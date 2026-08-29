/**
 * Eval batch executor — hermetic, on the `test/helpers/eval.ts` harness.
 * The provider is `MockLLMProvider` (or a hand-rolled wrapper for error /
 * gating / concurrency injection); the engine, scoring and persistence layout
 * are real (AC-04, AC-14..17, AC-21..30, AC-NF-04..07, AC-NF-11).
 */
import { describe, it, expect } from 'vitest';
import { FeatureModelId, type LLMProvider, type StructuredRequest } from '@devdigest/shared';
import {
  buildEvalHarness,
  AGENT_ID,
  FIXTURE_PATCH,
  REVIEW_FIXTURE,
  WORKSPACE_ID,
  type EvalHarness,
} from './helpers/eval.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import type { InsertEvalRun } from '../src/modules/eval/repository.js';

const runOpts = (h: EvalHarness) => ({ logger: h.logger, correlationId: 'req-1' });

/** A patch for a second file — the fixture finding cannot ground against it. */
const OTHER_PATCH = '@@ -1,2 +1,3 @@\n import x from "y";\n+export const other = 1;\n const z = 2;';

describe('runBatch', () => {
  it('persists one row per case, sharing one fresh batch_id and the agent version (AC-14, AC-26)', async () => {
    const h = buildEvalHarness();
    h.evalRepo.addCase();
    h.evalRepo.addCase();
    h.evalRepo.addCase();

    const detail = await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));

    expect(h.evalRepo.runs).toHaveLength(3);
    const batchIds = new Set(h.evalRepo.runs.map((r) => r.batchId));
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).toBe(detail.batch_id);
    expect(h.evalRepo.runs.every((r) => r.agentVersion === h.agent.version)).toBe(true);
    expect(detail.cases_total).toBe(3);
    expect(detail.agent_version).toBe(3);
    expect(detail.model).toBe('gpt-4.1');
  });

  it('prompts carry the skills and the frozen fragment, and no enrichment section (AC-15)', async () => {
    const h = buildEvalHarness({
      linkedSkills: [
        { skill: { id: 's1', name: 'No secrets', body: 'Never commit keys.' }, order: 0, enabled: true },
      ],
    });
    h.evalRepo.addCase();
    await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));

    const [prompt] = h.userPrompts();
    expect(prompt).toContain('## Skills / rules');
    expect(prompt).toContain('Never commit keys.');
    expect(prompt).toContain('stripeKey: "sk_live_SENTINEL"'); // the frozen fragment
    // The eval executor NEVER enriches: no intent, callers, repo map, project
    // context or memory reaches the prompt (Decision-log 2).
    expect(prompt).not.toContain('## PR intent & scope');
    expect(prompt).not.toContain('## Callers of changed symbols');
    expect(prompt).not.toContain('## Repo skeleton');
    expect(prompt).not.toContain('## Project context');
    expect(prompt).not.toContain('## Relevant memory');
  });

  it('grounding drops an out-of-fragment citation: surviving 0, must_find fails (AC-16)', async () => {
    const h = buildEvalHarness({
      structured: {
        ...REVIEW_FIXTURE,
        findings: [{ ...REVIEW_FIXTURE.findings[0]!, start_line: 99, end_line: 99 }],
      },
    });
    h.evalRepo.addCase();
    const detail = await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));

    expect(detail.cases_passed).toBe(0);
    expect(detail.results[0]!.pass).toBe(false);
    const outcome = h.evalRepo.runs[0]!.actualOutput;
    expect(outcome.surviving).toBe(0);
    expect(outcome.proposed).toBe(1);
  });

  it('makes exactly one structured call per case and nothing else (AC-17)', async () => {
    const h = buildEvalHarness();
    h.evalRepo.addCase();
    h.evalRepo.addCase();
    const detail = await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));

    const methods = h.llm.calls.map((c) => c.method);
    expect(methods.filter((m) => m === 'completeStructured')).toHaveLength(detail.cases_total);
    expect(methods.every((m) => m === 'completeStructured')).toBe(true);
  });

  it('computes batch metrics from raw counts end-to-end (AC-21..23)', async () => {
    const h = buildEvalHarness();
    // A: must_find at the cited line → matched, pass.
    h.evalRepo.addCase();
    // B: must_find in another file — the fixture finding cannot ground there.
    h.evalRepo.addCase({
      inputDiff: OTHER_PATCH,
      inputFiles: ['src/other.ts'],
      expectedOutput: { kind: 'must_find', file: 'src/other.ts', start_line: 2, end_line: 2 },
    });
    // C: must_not_flag at the cited line → the match is noise, fail.
    h.evalRepo.addCase({
      expectedOutput: { kind: 'must_not_flag', file: 'src/config.ts', start_line: 11, end_line: 11 },
    });

    const detail = await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));

    // Hand-computed: must_find A passes, B fails → recall 1/2. Surviving
    // A=1, B=0, C=1 → Σ2; noise C=1 → precision 1 − 1/2. Proposed Σ3 →
    // citation 2/3 (raw counts, not a mean).
    expect(detail.recall).toBe(0.5);
    expect(detail.precision).toBe(0.5);
    expect(detail.citation_accuracy).toBeCloseTo(2 / 3, 10);
    expect(detail.cases_passed).toBe(1);
    expect(detail.cases_errored).toBe(0);
  });

  it('each row records pass, its own citation accuracy, duration and cost (AC-25)', async () => {
    const h = buildEvalHarness();
    h.evalRepo.addCase();
    const detail = await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));

    const row = h.evalRepo.runs[0]!;
    expect(row.pass).toBe(true);
    expect(row.citationAccuracy).toBe(1);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.costUsd).toBe(0.001); // MockLLMProvider's fixed per-call cost
    // Recall/precision are batch metrics — the per-row values stay null.
    expect(detail.results[0]!.recall).toBeNull();
    expect(detail.results[0]!.precision).toBeNull();
    expect(detail.results[0]!.citation_accuracy).toBe(1);
  });

  it('two batches see byte-identical prompts after the live PR mutates (AC-04)', async () => {
    const prFiles = [{ path: 'src/config.ts', patch: FIXTURE_PATCH }];
    const h = buildEvalHarness({ finding: { acceptedAt: new Date() }, prFiles });
    // Create the case through the real path, then mutate everything live.
    await h.service.createCaseFromFinding(WORKSPACE_ID, h.finding.id);
    h.pull.title = 'RENAMED after freezing';
    h.pull.body = 'Rewritten body';
    prFiles[0]!.patch = '@@ -1,1 +1,1 @@\n-old\n+completely different diff';

    await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));
    const first = h.llm.calls
      .filter((c) => c.method === 'completeStructured')
      .map((c) => JSON.stringify((c.req as { messages: unknown }).messages));
    h.llm.calls.length = 0;
    await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));
    const second = h.llm.calls
      .filter((c) => c.method === 'completeStructured')
      .map((c) => JSON.stringify((c.req as { messages: unknown }).messages));

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    // The frozen title, not the mutated one, framed the task.
    expect(first[0]).toContain('Add rate limiting');
    expect(first[0]).not.toContain('RENAMED after freezing');
  });

  it('a per-case provider error leaves the other rows written and excluded metrics (AC-27)', async () => {
    let calls = 0;
    const inner = new MockLLMProvider('openai', {
      structuredBySchema: { Review: REVIEW_FIXTURE },
    });
    const flaky: LLMProvider = {
      id: 'openai',
      listModels: () => inner.listModels(),
      complete: (req) => inner.complete(req),
      completeStructured: async <T>(req: StructuredRequest<T>) => {
        calls += 1;
        if (calls === 2) throw new Error('provider exploded on call #2');
        return inner.completeStructured(req);
      },
      embed: (texts) => inner.embed(texts),
    };
    const h = buildEvalHarness({ llm: flaky });
    h.evalRepo.addCase();
    h.evalRepo.addCase();
    h.evalRepo.addCase();
    const detail = await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));

    expect(h.evalRepo.runs).toHaveLength(3);
    const errored = h.evalRepo.runs.filter((r) => r.actualOutput.error !== null);
    expect(errored).toHaveLength(1);
    expect(errored[0]!.actualOutput.error).toBe('provider exploded on call #2');
    expect(errored[0]!.pass).toBeNull();
    expect(errored[0]!.costUsd).toBeNull();
    expect(detail.cases_errored).toBe(1);
    expect(detail.cases_total).toBe(3);
    // Both executed cases passed → the errored one is in no denominator.
    expect(detail.recall).toBe(1);
    expect(detail.precision).toBe(1);
    expect(detail.citation_accuracy).toBe(1);
    const erroredRecord = detail.results.find((r) => r.error !== null)!;
    expect(erroredRecord.error).toBe('provider exploded on call #2');
  });

  it('refuses an empty case set with 409 before resolving any provider (AC-28)', async () => {
    const h = buildEvalHarness();
    await expect(h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h))).rejects.toMatchObject({
      code: 'no_eval_cases',
      statusCode: 409,
    });
    expect(h.llm.calls).toHaveLength(0);
    expect(h.llmResolves).toHaveLength(0);
  });

  it('a concurrent trigger is refused, and the lock releases afterwards (AC-29)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gateOpen = false;
    const inner = new MockLLMProvider('openai', {
      structuredBySchema: { Review: REVIEW_FIXTURE },
    });
    const gated: LLMProvider = {
      id: 'openai',
      listModels: () => inner.listModels(),
      complete: (req) => inner.complete(req),
      completeStructured: async <T>(req: StructuredRequest<T>) => {
        if (!gateOpen) await gate;
        return inner.completeStructured(req);
      },
      embed: (texts) => inner.embed(texts),
    };
    const g = buildEvalHarness({ llm: gated });
    g.evalRepo.addCase();
    g.evalRepo.addCase();

    const first = g.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(g));
    // Let the first batch genuinely get in flight (past the lock).
    await new Promise((r) => setTimeout(r, 10));
    const second = g.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(g));
    await expect(second).rejects.toMatchObject({ code: 'eval_run_in_flight', statusCode: 409 });

    gateOpen = true;
    release();
    const detail = await first;
    expect(detail.cases_total).toBe(2);
    // Only the first batch's calls happened.
    expect(inner.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(2);

    // The finally released the lock: a third trigger succeeds.
    const third = await g.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(g));
    expect(third.cases_total).toBe(2);
  });

  it('never writes review-domain rows and never resolves GitHub (AC-30)', async () => {
    const h = buildEvalHarness();
    h.evalRepo.addCase();
    await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));

    // Present-and-empty, not absent: the spies are wired in the harness.
    expect(h.recorded.insertReview).toEqual([]);
    expect(h.recorded.insertFindings).toEqual([]);
    expect(h.recorded.githubResolves).toBe(0);
    expect(h.github.posted).toEqual([]);
  });

  it('bounds every call and never exceeds 3 in flight on an 8-case batch (AC-NF-05)', async () => {
    let inFlight = 0;
    let peak = 0;
    const base = buildEvalHarness();
    const counting: LLMProvider = {
      id: 'openai',
      listModels: () => base.llm.listModels(),
      complete: (req) => base.llm.complete(req),
      completeStructured: async <T>(req: StructuredRequest<T>) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        const res = await base.llm.completeStructured(req);
        inFlight -= 1;
        return res;
      },
      embed: (texts) => base.llm.embed(texts),
    };
    const h = buildEvalHarness({ llm: counting });
    for (let i = 0; i < 8; i += 1) h.evalRepo.addCase();
    await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));

    expect(peak).toBeLessThanOrEqual(3);
    const reqs = base.llm.calls
      .filter((c) => c.method === 'completeStructured')
      .map((c) => c.req as { maxTokens?: number; timeoutMs?: number });
    expect(reqs).toHaveLength(8);
    for (const req of reqs) {
      expect(req.maxTokens).toBe(2000);
      expect(req.timeoutMs).toBe(60000);
    }
  });

  it("uses the agent's own model, never the feature-model registry (AC-NF-04)", async () => {
    const h = buildEvalHarness({ agent: { model: 'deepseek/deepseek-v4-flash', provider: 'openai' } });
    h.evalRepo.addCase();
    await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));

    for (const req of h.structuredCalls()) {
      expect(req.model).toBe('deepseek/deepseek-v4-flash');
    }
    expect(h.llmResolves).toEqual(['openai']);
    // A pin: `FeatureModelId` still has exactly its five members — this
    // feature added no registry entry.
    expect(FeatureModelId.options).toHaveLength(5);
  });

  it('a persist failure aborts the batch, leaving exactly k parseable rows (AC-NF-11)', async () => {
    const h = buildEvalHarness();
    for (let i = 0; i < 4; i += 1) h.evalRepo.addCase();
    // Sticky, like a real persist failure: with 3 workers in flight, a
    // one-shot throw would let a later case's insert land after the failure.
    h.evalRepo.onInsertRun = (_values: InsertEvalRun, call: number) => {
      if (call >= 3) throw new Error('disk full');
    };

    await expect(h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h))).rejects.toThrow(
      'disk full',
    );
    // Exactly k = 2 rows landed, each parseable (joinRows re-parses them).
    expect(h.evalRepo.runs).toHaveLength(2);
    const rows = await h.evalRepo.runsForBatch(WORKSPACE_ID, h.evalRepo.runs[0]!.batchId);
    expect(rows).toHaveLength(2);
    // ... and the lock was released by the finally: a retry runs.
    h.evalRepo.onInsertRun = undefined;
    h.evalRepo.runs.length = 0;
    const retry = await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));
    expect(retry.cases_total).toBe(4);
  });

  it('emits one structured batch line with ids, counts and metrics only (AC-NF-06, AC-NF-07)', async () => {
    const h = buildEvalHarness({
      pull: { body: 'SECRET-PR-BODY do not log' },
      linkedSkills: [
        { skill: { id: 's1', name: 'No secrets', body: 'SKILL-BODY-SENTINEL' }, order: 0, enabled: true },
      ],
    });
    h.evalRepo.addCase({
      inputMeta: {
        pr_title: 'Add rate limiting',
        pr_body: 'SECRET-PR-BODY do not log',
        repo: 'acme/payments-api',
        pr_number: 482,
        source_finding_id: 'seed:log',
      },
    });
    const detail = await h.service.runBatch(WORKSPACE_ID, AGENT_ID, runOpts(h));

    const batchLine = h.logger.lines.find((l) => l.msg === 'eval: batch completed');
    expect(batchLine).toBeDefined();
    expect(batchLine!.obj).toMatchObject({
      batch_id: detail.batch_id,
      agent_id: AGENT_ID,
      agent_version: 3,
      model: 'gpt-4.1',
      cases_total: 1,
      cases_errored: 0,
      cases_passed: 1,
      recall: 1,
      precision: 1,
      citation_accuracy: 1,
      correlationId: 'req-1',
    });
    const obj = batchLine!.obj as Record<string, unknown>;
    expect(typeof obj.duration_ms).toBe('number');
    expect(obj).toHaveProperty('cost_usd');

    // AC-NF-06 — across ALL captured lines: no diff text, PR body or prompt
    // content ever reaches a log.
    const dump = h.logger.dump();
    expect(dump).not.toContain('sk_live_SENTINEL');
    expect(dump).not.toContain('SECRET-PR-BODY');
    expect(dump).not.toContain('SKILL-BODY-SENTINEL');
    expect(dump).not.toContain('You are a careful reviewer');
  });
});

describe('eval reads: history, batch detail, dashboard', () => {
  const OUTCOME = {
    model: 'gpt-4.1',
    expectation_kind: 'must_find' as const,
    proposed: 1,
    surviving: 1,
    noise: 0,
    matched: true,
    error: null,
    findings: [],
  };

  function seedRun(
    h: EvalHarness,
    caseId: string,
    batchId: string,
    over: Partial<InsertEvalRun & { ranAt: Date }> = {},
  ) {
    h.evalRepo.runs.push({
      id: `run-${h.evalRepo.runs.length + 1}`,
      caseId,
      batchId,
      agentVersion: 3,
      pass: true,
      citationAccuracy: 1,
      durationMs: 100,
      costUsd: 0.001,
      actualOutput: OUTCOME,
      ranAt: new Date('2026-08-29T00:00:00.000Z'),
      ...over,
    });
  }

  it('lists batches newest first with distinct version/model labels (AC-26, AC-34)', async () => {
    const h = buildEvalHarness();
    const c = h.evalRepo.addCase();
    seedRun(h, c.id, 'batch-old', {
      agentVersion: 3,
      ranAt: new Date('2026-08-28T00:00:00.000Z'),
    });
    seedRun(h, c.id, 'batch-new', {
      agentVersion: 5,
      ranAt: new Date('2026-08-29T00:00:00.000Z'),
      actualOutput: { ...OUTCOME, model: 'gpt-5.2' },
    });

    const batches = await h.service.listBatches(WORKSPACE_ID, AGENT_ID);
    expect(batches.map((b) => b.batch_id)).toEqual(['batch-new', 'batch-old']);
    expect(batches[0]!.agent_version).toBe(5);
    expect(batches[0]!.model).toBe('gpt-5.2');
    expect(batches[1]!.agent_version).toBe(3);
    expect(batches[1]!.model).toBe('gpt-4.1');
  });

  it('getBatch carries case_id + case_name on every row, errored included (AC-35)', async () => {
    const h = buildEvalHarness();
    const a = h.evalRepo.addCase({ name: 'Case A' });
    const b = h.evalRepo.addCase({ name: 'Case B' });
    seedRun(h, a.id, 'batch-1');
    seedRun(h, b.id, 'batch-1', {
      pass: null,
      citationAccuracy: null,
      costUsd: null,
      actualOutput: { ...OUTCOME, proposed: 0, surviving: 0, matched: false, error: 'timed out' },
    });

    const detail = await h.service.getBatch(WORKSPACE_ID, AGENT_ID, 'batch-1');
    expect(detail.results).toHaveLength(2);
    expect(detail.results.map((r) => r.case_name).sort()).toEqual(['Case A', 'Case B']);
    expect(detail.results.every((r) => r.case_id)).toBe(true);
    const errored = detail.results.find((r) => r.error !== null)!;
    expect(errored.case_name).toBe('Case B');
    expect(detail.cases_errored).toBe(1);

    // An unknown batch — and another agent's batch — is a 404.
    await expect(h.service.getBatch(WORKSPACE_ID, AGENT_ID, 'nope')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      h.service.getBatch(WORKSPACE_ID, '00000000-0000-4000-8000-0000000000aa', 'batch-1'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('dashboard on an empty eval_runs is an empty state, not a throw (AC-37)', async () => {
    const h = buildEvalHarness();
    h.evalRepo.addCase();
    h.evalRepo.addCase();
    const view = await h.service.dashboard(WORKSPACE_ID);
    expect(view).toEqual({ cases_total: 2, recent: [] });
  });

  it('dashboard is newest-first, capped, and carries agent_name (AC-36)', async () => {
    const h = buildEvalHarness();
    const c = h.evalRepo.addCase();
    for (let i = 0; i < 25; i += 1) {
      seedRun(h, c.id, `batch-${i}`, {
        ranAt: new Date(Date.UTC(2026, 7, 1 + (i % 28), i)),
      });
    }
    const view = await h.service.dashboard(WORKSPACE_ID);
    expect(view.recent).toHaveLength(20); // EVAL_DASHBOARD_RECENT_CAP
    expect(view.recent[0]!.agent_name).toBe('Baseline Reviewer');
    const times = view.recent.map((b) => b.ran_at);
    expect([...times].sort().reverse()).toEqual(times);
  });
});
