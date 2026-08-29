import { randomUUID } from 'node:crypto';
import type {
  EvalBatchDetail,
  EvalBatchSummary,
  EvalCase,
  EvalDashboardView,
  EvalRunRecord,
  LLMProvider,
} from '@devdigest/shared';
import { EvalExpectation } from '@devdigest/shared';
import { reviewPullRequest } from '@devdigest/reviewer-core';
import type { Container } from '../../platform/container.js';
import { AppError, NotFoundError } from '../../platform/errors.js';
import type { PinoLike } from '../../platform/run-logger.js';
import type { AgentRow } from '../../db/rows.js';
import {
  EVAL_CASE_MAX_TOKENS,
  EVAL_CASE_NAME_MAX,
  EVAL_CASE_TIMEOUT_MS,
  EVAL_CONCURRENCY,
  EVAL_DASHBOARD_RECENT_CAP,
} from './constants.js';
import {
  caseDiff,
  mapWithConcurrency,
  toEvalCaseDto,
  toSkillPromptBlock,
  withCallLimits,
} from './helpers.js';
import { batchMetrics, caseCitation, caseVerdict } from './scoring.js';
import type { EvalRepository, EvalRunRow, InsertEvalRun } from './repository.js';
import { EvalCaseMeta, type EvalCaseOutcome, type EvalFacade } from './types.js';

/**
 * Eval pipeline — finding → frozen case → synchronous batch → mechanical score.
 *
 * One model call per case (`reviewPullRequest`, single-pass, the grounding gate
 * applied inside the engine) and ZERO LLM calls for scoring: the verdicts and
 * metrics are pure functions in `scoring.ts`. The executor touches no
 * `reviews`/`findings`/`agent_runs` writer and never resolves
 * `container.github()` (AC-30 — no call site exists in this module).
 *
 * It takes the whole `Container` (the house pattern — `BriefService` records
 * the same trade-off): the service legitimately touches `reviewRepo`,
 * `agentsRepo`, `evalRepo` and `llm`, and `ContainerOverrides` is the test
 * seam either way.
 */
export class EvalService implements EvalFacade {
  /**
   * AC-29 — one in-flight batch per agent. A plain Set is enough: the
   * container getter memoizes one service per app, and the batch trigger is
   * synchronous in one process by spec decision.
   */
  private inFlight = new Set<string>();

  constructor(private container: Container) {}

  private get evalRepo(): EvalRepository {
    return this.container.evalRepo;
  }

  // ---- case creation / list / delete --------------------------------------

  async createCaseFromFinding(workspaceId: string, findingId: string): Promise<EvalCase> {
    const ctx = await this.container.reviewRepo.findingContext(findingId);
    // Tenancy first: a finding outside the workspace is a 404, never a 409.
    if (!ctx || ctx.pull.workspaceId !== workspaceId) {
      throw new NotFoundError('Finding not found');
    }
    const { finding, review, pull } = ctx;

    // The label comes from the decision (`setFindingAccepted` nulls the other
    // timestamp and vice versa, so both-set cannot occur). Undecided → refuse,
    // nothing created (AC-05).
    const kind = finding.acceptedAt
      ? ('must_find' as const)
      : finding.dismissedAt
        ? ('must_not_flag' as const)
        : null;
    if (!kind) {
      throw new AppError(
        'finding_undecided',
        'Accept or dismiss the finding before adding it as an eval case',
        409,
      );
    }

    // AC-06 — one case per source finding; the refusal names the existing case.
    const existing = await this.evalRepo.findCaseBySourceFinding(workspaceId, findingId);
    if (existing) {
      throw new AppError(
        'eval_case_exists',
        `An eval case already exists for this finding (case ${existing.id})`,
        409,
        { existing_case_id: existing.id },
      );
    }

    // AC-08 — the case is owned by the agent whose review produced the finding.
    const agent = review.agentId
      ? await this.container.agentsRepo.getById(workspaceId, review.agentId)
      : undefined;
    if (!agent) throw new NotFoundError('Agent for this finding no longer exists');

    // AC-07 — the frozen input is the verbatim stored patch; no patch, no case.
    const files = await this.container.reviewRepo.getPrFiles(pull.id);
    const patch = files.find((f) => f.path === finding.file)?.patch;
    if (!patch) {
      throw new AppError(
        'no_diff_fragment',
        `No stored diff fragment for '${finding.file}' on this pull request`,
        422,
      );
    }

    const repoRow = await this.container.reviewRepo.getRepo(pull.repoId);
    const row = await this.evalRepo.insertCase({
      workspaceId,
      ownerKind: 'agent',
      ownerId: agent.id,
      name: finding.title.slice(0, EVAL_CASE_NAME_MAX),
      inputDiff: patch,
      inputFiles: [finding.file],
      inputMeta: {
        pr_title: pull.title,
        pr_body: pull.body,
        repo: repoRow?.fullName ?? '',
        pr_number: pull.number,
        source_finding_id: findingId,
      },
      expectedOutput: {
        kind,
        file: finding.file,
        start_line: finding.startLine,
        end_line: finding.endLine,
      },
    });
    return toEvalCaseDto(row);
  }

  async listCases(workspaceId: string, agentId: string): Promise<EvalCase[]> {
    const rows = await this.evalRepo.listCases(workspaceId, 'agent', agentId);
    return rows.map(toEvalCaseDto);
  }

  async deleteCase(workspaceId: string, caseId: string): Promise<void> {
    const row = await this.evalRepo.getCase(workspaceId, caseId);
    if (!row) throw new NotFoundError('Eval case not found');
    await this.evalRepo.deleteCase(caseId);
  }

  // ---- batch execution -----------------------------------------------------

  async runBatch(
    workspaceId: string,
    agentId: string,
    opts: { logger: PinoLike; correlationId?: string },
  ): Promise<EvalBatchDetail> {
    const agent = await this.container.agentsRepo.getById(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');

    // AC-28 — an empty set refuses BEFORE any provider is resolved.
    const cases = (await this.evalRepo.listCases(workspaceId, 'agent', agentId)).map(
      toEvalCaseDto,
    );
    if (cases.length === 0) {
      throw new AppError('no_eval_cases', 'This agent has no eval cases to run', 409);
    }

    // AC-29 — one batch per agent at a time. Check-and-add is atomic (no await
    // between them), and the `finally` releases the lock on every exit path.
    if (this.inFlight.has(agentId)) {
      throw new AppError(
        'eval_run_in_flight',
        'An eval batch is already running for this agent',
        409,
      );
    }
    this.inFlight.add(agentId);
    try {
      const triggeredAt = new Date();
      const batchId = randomUUID();
      // Skill blocks resolve ONCE per batch so every case sees identical
      // prompt inputs (Decision 7).
      const blocks = (await this.container.agentsRepo.enabledSkillsForPrompt(agentId)).map(
        (l) => toSkillPromptBlock(l.skill),
      );
      // The agent's OWN provider and model — never `resolveFeatureModel`
      // (AC-NF-04). The decorator bounds every call (AC-NF-05).
      const llm = withCallLimits(
        await this.container.llm(agent.provider as 'openai' | 'anthropic' | 'openrouter'),
        { maxTokens: EVAL_CASE_MAX_TOKENS, timeoutMs: EVAL_CASE_TIMEOUT_MS },
      );

      await mapWithConcurrency(cases, EVAL_CONCURRENCY, (c) =>
        this.executeCase(c, { agent, batchId, blocks, llm }),
      );

      const rows = await this.evalRepo.runsForBatch(workspaceId, batchId);
      const detail = toBatchDetail(rows, agentId, triggeredAt.toISOString());

      // AC-NF-07 — one structured line per batch. Identifiers, counts, metrics
      // and sizes only — never diff text, PR bodies, prompt or model output
      // (AC-NF-06); nothing else in this module logs content either.
      opts.logger.info(
        {
          feature: 'eval',
          batch_id: batchId,
          agent_id: agentId,
          agent_version: agent.version,
          model: agent.model,
          cases_total: detail.cases_total,
          cases_errored: detail.cases_errored,
          cases_passed: detail.cases_passed,
          recall: detail.recall,
          precision: detail.precision,
          citation_accuracy: detail.citation_accuracy,
          cost_usd: detail.cost_usd,
          duration_ms: detail.duration_ms,
          correlationId: opts.correlationId,
        },
        'eval: batch completed',
      );
      return detail;
    } finally {
      this.inFlight.delete(agentId);
    }
  }

  /**
   * Run one case: frozen diff → one engine call → mechanical score → one row,
   * written IMMEDIATELY (AC-14, AC-25, AC-NF-11's write-as-you-go).
   *
   * A failure while executing becomes an errored row and the method returns
   * normally so the remaining cases run (AC-27). The persist itself sits
   * OUTSIDE the catch: a failed `insertRun` aborts the whole batch, leaving
   * exactly the rows already written (AC-NF-11).
   */
  private async executeCase(
    c: EvalCase,
    ctx: { agent: AgentRow; batchId: string; blocks: string[]; llm: LLMProvider },
  ): Promise<void> {
    const started = Date.now();
    let kind: 'must_find' | 'must_not_flag' = 'must_find';
    let record: InsertEvalRun;
    try {
      const exp = EvalExpectation.parse(c.expected_output);
      kind = exp.kind;
      const meta = EvalCaseMeta.parse(c.input_meta);
      const diff = caseDiff(exp.file, c.input_diff);

      // One structured call, single-pass, grounding applied inside the engine
      // (AC-15..17). No intent/callers/repoMap/specs/memory, EVER — which also
      // keeps the scope filter a no-op, so `dropped` holds only grounding
      // drops (AC-23, Decision 6).
      const outcome = await reviewPullRequest({
        systemPrompt: ctx.agent.systemPrompt,
        model: ctx.agent.model,
        diff,
        llm: ctx.llm,
        strategy: 'single-pass',
        ...(ctx.blocks.length ? { skills: ctx.blocks } : {}),
        ...(meta.pr_body != null ? { prDescription: meta.pr_body } : {}),
        task: `Review PR: ${meta.pr_title}`,
        sessionId: ctx.batchId,
      });

      const surviving = outcome.review.findings;
      const proposed = surviving.length + outcome.dropped.length;
      const { pass, matched } = caseVerdict(exp, surviving);
      const payload: EvalCaseOutcome = {
        model: ctx.agent.model,
        expectation_kind: kind,
        proposed,
        surviving: surviving.length,
        noise: kind === 'must_not_flag' ? matched : 0,
        matched: matched > 0,
        error: null,
        findings: surviving,
      };
      record = {
        caseId: c.id,
        batchId: ctx.batchId,
        agentVersion: ctx.agent.version,
        pass,
        citationAccuracy: caseCitation(surviving.length, proposed),
        durationMs: Date.now() - started,
        costUsd: outcome.costUsd,
        actualOutput: payload,
      };
    } catch (err) {
      record = {
        caseId: c.id,
        batchId: ctx.batchId,
        agentVersion: ctx.agent.version,
        pass: null,
        citationAccuracy: null,
        durationMs: Date.now() - started,
        costUsd: null,
        actualOutput: {
          model: ctx.agent.model,
          expectation_kind: kind,
          proposed: 0,
          surviving: 0,
          noise: 0,
          matched: false,
          error: err instanceof Error ? err.message : String(err),
          findings: [],
        },
      };
    }
    await this.evalRepo.insertRun(record);
  }

  // ---- history, batch detail, dashboard ------------------------------------

  async listBatches(workspaceId: string, agentId: string): Promise<EvalBatchSummary[]> {
    const rows = await this.evalRepo.runsForAgent(workspaceId, agentId);
    return groupByBatch(rows)
      .map((group) => toBatchSummary(group, agentId))
      .sort((a, b) => (a.ran_at < b.ran_at ? 1 : -1));
  }

  async getBatch(
    workspaceId: string,
    agentId: string,
    batchId: string,
  ): Promise<EvalBatchDetail> {
    const rows = await this.evalRepo.runsForBatch(workspaceId, batchId);
    if (rows.length === 0 || rows.some((r) => r.ownerId !== agentId)) {
      throw new NotFoundError('Eval batch not found');
    }
    return toBatchDetail(rows, agentId);
  }

  async dashboard(workspaceId: string): Promise<EvalDashboardView> {
    const [casesTotal, rows] = await Promise.all([
      this.evalRepo.countCases(workspaceId),
      this.evalRepo.recentRuns(workspaceId, EVAL_DASHBOARD_RECENT_CAP),
    ]);
    const recent = groupByBatch(rows)
      .map((group) => ({
        ...toBatchSummary(group, group[0]!.ownerId),
        agent_name: (group[0] as { agentName?: string }).agentName ?? '',
      }))
      .sort((a, b) => (a.ran_at < b.ran_at ? 1 : -1))
      .slice(0, EVAL_DASHBOARD_RECENT_CAP);
    return { cases_total: casesTotal, recent };
  }
}

// ---- pure batch mapping (rows → wire shapes) --------------------------------

function groupByBatch<R extends EvalRunRow>(rows: R[]): R[][] {
  const byBatch = new Map<string, R[]>();
  for (const row of rows) {
    const group = byBatch.get(row.batchId);
    if (group) group.push(row);
    else byBatch.set(row.batchId, [row]);
  }
  return [...byBatch.values()];
}

function toBatchSummary(rows: EvalRunRow[], agentId: string, ranAt?: string): EvalBatchSummary {
  const first = rows[0]!;
  const metrics = batchMetrics(rows.map((r) => r.outcome));
  const earliest = rows.reduce((min, r) => (r.ranAt < min ? r.ranAt : min), first.ranAt);
  // Null-propagating cost sum: an unpriced (or errored) row makes the batch
  // cost unknown, never silently smaller.
  let costUsd: number | null = 0;
  for (const r of rows) {
    costUsd = costUsd === null || r.costUsd === null ? null : costUsd + r.costUsd;
  }
  return {
    batch_id: first.batchId,
    agent_id: agentId,
    agent_version: first.agentVersion,
    model: first.outcome.model,
    ran_at: ranAt ?? earliest.toISOString(),
    ...metrics,
    duration_ms: rows.reduce((n, r) => n + (r.durationMs ?? 0), 0),
    cost_usd: costUsd,
  };
}

function toBatchDetail(rows: EvalRunRow[], agentId: string, ranAt?: string): EvalBatchDetail {
  return { ...toBatchSummary(rows, agentId, ranAt), results: rows.map(toRunRecord) };
}

function toRunRecord(r: EvalRunRow): EvalRunRecord {
  return {
    id: r.id,
    case_id: r.caseId,
    case_name: r.caseName,
    batch_id: r.batchId,
    agent_version: r.agentVersion,
    ran_at: r.ranAt.toISOString(),
    actual_output: r.outcome,
    pass: r.pass,
    // Recall/precision are BATCH metrics; the per-row columns stay null (AC-25).
    recall: null,
    precision: null,
    citation_accuracy: r.citationAccuracy,
    duration_ms: r.durationMs,
    cost_usd: r.costUsd,
    error: r.outcome.error,
  };
}
