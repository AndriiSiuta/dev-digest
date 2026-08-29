import { EvalService } from '../../src/modules/eval/service.js';
import { MockGitHubClient, MockLLMProvider } from '../../src/adapters/mocks.js';
import { EvalCaseOutcome } from '../../src/modules/eval/types.js';
import type {
  EvalCaseRow,
  EvalRecentRunRow,
  EvalRunRow,
  InsertEvalCase,
  InsertEvalRun,
} from '../../src/modules/eval/repository.js';
import type { AgentRow, FindingRow, PullRow, RepoRow } from '../../src/db/rows.js';
import type { LLMProvider } from '@devdigest/shared';
import type { PinoLike } from '../../src/platform/run-logger.js';

/**
 * Hermetic `EvalService` harness — no Postgres, no Docker, no network.
 *
 * The container is an object literal cast to `never` (`Container` has private
 * fields, compared nominally — `server/INSIGHTS.md`, 2026-08-17). EVERY
 * dependency the service could touch is WIRED and resolves to empty, never
 * absent: an unwired facade would throw, be swallowed somewhere, and let an
 * inertness assertion pass vacuously (the 2026-08-28 trap). The AC-30 spies
 * (`insertReview` / `insertFindings` / `container.github`) therefore exist and
 * record zero calls rather than not existing.
 */

export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const REPO_ID = '00000000-0000-4000-8000-000000000002';
export const PR_ID = '00000000-0000-4000-8000-000000000003';
export const AGENT_ID = '00000000-0000-4000-8000-000000000004';
export const REVIEW_ID = '00000000-0000-4000-8000-000000000005';
export const FINDING_ID = '00000000-0000-4000-8000-000000000006';

/**
 * The frozen fragment cases are built from. `sk_live_SENTINEL` doubles as the
 * AC-NF-06 leak probe: no captured log line may ever contain it. New-side
 * lines covered: 10 (context), 11 (the added key), 12 (context).
 */
export const FIXTURE_PATCH =
  '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_SENTINEL",\n   redisUrl: x,';

/** A model review whose one finding cites line 11 — inside the fragment. */
export const REVIEW_FIXTURE = {
  verdict: 'request_changes',
  summary: 'One blocker.',
  score: 60,
  findings: [
    {
      id: 'f1',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded key',
      file: 'src/config.ts',
      start_line: 11,
      end_line: 11,
      rationale: 'Line 11 contains a literal key.',
      suggestion: 'Move it to an env var.',
      confidence: 0.9,
    },
  ],
};

/** In-memory `EvalRepository` double — records every write. */
export class InMemoryEvalRepo {
  cases: EvalCaseRow[] = [];
  runs: (InsertEvalRun & { id: string; ranAt: Date })[] = [];
  insertRunCalls = 0;
  /** Ran before each default insert — throw here to abort a batch (AC-NF-11). */
  onInsertRun?: (values: InsertEvalRun, call: number) => void;
  /** `agents.id → name` for the dashboard join. */
  agentNames: Record<string, string> = { [AGENT_ID]: 'Baseline Reviewer' };

  private seq = 0;

  addCase(over: Partial<EvalCaseRow> = {}): EvalCaseRow {
    const row: EvalCaseRow = {
      id: `00000000-0000-4000-8000-00000000c${String(this.seq++).padStart(3, '0')}`,
      workspaceId: WORKSPACE_ID,
      ownerKind: 'agent',
      ownerId: AGENT_ID,
      name: 'Hardcoded key',
      inputDiff: FIXTURE_PATCH,
      inputFiles: ['src/config.ts'],
      inputMeta: {
        pr_title: 'Add rate limiting',
        pr_body: null,
        repo: 'acme/payments-api',
        pr_number: 482,
        source_finding_id: `seed:${this.seq}`,
      },
      expectedOutput: { kind: 'must_find', file: 'src/config.ts', start_line: 11, end_line: 11 },
      notes: null,
      ...over,
    };
    this.cases.push(row);
    return row;
  }

  async insertCase(values: InsertEvalCase): Promise<EvalCaseRow> {
    return this.addCase({
      workspaceId: values.workspaceId,
      ownerKind: values.ownerKind,
      ownerId: values.ownerId,
      name: values.name,
      inputDiff: values.inputDiff,
      inputFiles: values.inputFiles as object,
      inputMeta: values.inputMeta,
      expectedOutput: values.expectedOutput,
    });
  }

  async listCases(
    workspaceId: string,
    ownerKind: string,
    ownerId: string,
  ): Promise<EvalCaseRow[]> {
    return this.cases.filter(
      (c) => c.workspaceId === workspaceId && c.ownerKind === ownerKind && c.ownerId === ownerId,
    );
  }

  async getCase(workspaceId: string, caseId: string): Promise<EvalCaseRow | undefined> {
    return this.cases.find((c) => c.workspaceId === workspaceId && c.id === caseId);
  }

  async findCaseBySourceFinding(
    workspaceId: string,
    findingId: string,
  ): Promise<EvalCaseRow | undefined> {
    return this.cases.find(
      (c) =>
        c.workspaceId === workspaceId &&
        (c.inputMeta as { source_finding_id?: string } | null)?.source_finding_id === findingId,
    );
  }

  async deleteCase(caseId: string): Promise<void> {
    this.cases = this.cases.filter((c) => c.id !== caseId);
    // Mirrors the FK's ON DELETE CASCADE.
    this.runs = this.runs.filter((r) => r.caseId !== caseId);
  }

  async countCases(workspaceId: string): Promise<number> {
    return this.cases.filter((c) => c.workspaceId === workspaceId).length;
  }

  async insertRun(values: InsertEvalRun): Promise<void> {
    this.insertRunCalls += 1;
    this.onInsertRun?.(values, this.insertRunCalls);
    this.runs.push({ ...values, id: `run-${this.insertRunCalls}`, ranAt: new Date() });
  }

  async runsForBatch(workspaceId: string, batchId: string): Promise<EvalRunRow[]> {
    return this.joinRows((r, c) => c.workspaceId === workspaceId && r.batchId === batchId);
  }

  async runsForAgent(workspaceId: string, agentId: string): Promise<EvalRunRow[]> {
    return this.joinRows(
      (_r, c) => c.workspaceId === workspaceId && c.ownerKind === 'agent' && c.ownerId === agentId,
    ).sort((a, b) => b.ranAt.getTime() - a.ranAt.getTime());
  }

  async recentRuns(workspaceId: string, _cap: number): Promise<EvalRecentRunRow[]> {
    return this.joinRows((_r, c) => c.workspaceId === workspaceId).map((row) => ({
      ...row,
      agentName: this.agentNames[row.ownerId] ?? 'unknown',
    }));
  }

  private joinRows(
    keep: (run: InsertEvalRun & { id: string; ranAt: Date }, kase: EvalCaseRow) => boolean,
  ): EvalRunRow[] {
    const rows: EvalRunRow[] = [];
    for (const run of this.runs) {
      const kase = this.cases.find((c) => c.id === run.caseId);
      if (!kase || !keep(run, kase)) continue;
      rows.push({
        id: run.id,
        caseId: run.caseId,
        caseName: kase.name,
        ownerId: kase.ownerId,
        batchId: run.batchId,
        agentVersion: run.agentVersion,
        ranAt: run.ranAt,
        pass: run.pass,
        citationAccuracy: run.citationAccuracy,
        durationMs: run.durationMs,
        costUsd: run.costUsd,
        // Same boundary rule as the real repository: parse, fail loudly.
        outcome: EvalCaseOutcome.parse(run.actualOutput),
      });
    }
    return rows;
  }
}

/** A capturing PinoLike — every line lands here, serialized for leak probes. */
export class CapturingLogger implements PinoLike {
  lines: { level: string; obj: unknown; msg?: string }[] = [];
  info = (obj: unknown, msg?: string) => void this.lines.push({ level: 'info', obj, msg });
  warn = (obj: unknown, msg?: string) => void this.lines.push({ level: 'warn', obj, msg });
  error = (obj: unknown, msg?: string) => void this.lines.push({ level: 'error', obj, msg });
  debug = (obj: unknown, msg?: string) => void this.lines.push({ level: 'debug', obj, msg });
  /** Everything ever logged, as one string — the AC-NF-06 probe surface. */
  dump(): string {
    return this.lines.map((l) => `${JSON.stringify(l.obj)} ${l.msg ?? ''}`).join('\n');
  }
}

export interface EvalHarnessOptions {
  agent?: Partial<AgentRow>;
  pull?: Partial<PullRow>;
  finding?: Partial<FindingRow>;
  /** `reviews.agent_id` — null exercises AC-08's orphaned-review path. */
  reviewAgentId?: string | null;
  /** `agentsRepo.getById` misses entirely (unknown agent, AC-08). */
  agentMissing?: boolean;
  /** The PR's stored files; default carries the fixture patch. */
  prFiles?: { path: string; patch: string | null }[];
  /** Enabled linked skills, as `enabledSkillsForPrompt` returns them. */
  linkedSkills?: { skill: { id: string; name: string; body: string }; order: number; enabled: boolean }[];
  /** Structured fixture the mock provider returns for schema 'Review'. */
  structured?: unknown;
  /** Full provider override (error injection, gating, concurrency counters). */
  llm?: LLMProvider;
}

export interface EvalHarness {
  service: EvalService;
  evalRepo: InMemoryEvalRepo;
  llm: MockLLMProvider;
  github: MockGitHubClient;
  logger: CapturingLogger;
  agent: AgentRow;
  pull: PullRow;
  finding: FindingRow;
  /** AC-30 spies — wired, present-and-empty. */
  recorded: { insertReview: unknown[]; insertFindings: unknown[]; githubResolves: number };
  /** Provider ids resolved through `container.llm`. */
  llmResolves: string[];
  /** The user-message contents of every structured call, in call order. */
  userPrompts(): string[];
  structuredCalls(): { model?: string; maxTokens?: number; timeoutMs?: number; sessionId?: string }[];
}

export function buildEvalHarness(opts: EvalHarnessOptions = {}): EvalHarness {
  const agent: AgentRow = {
    id: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Baseline Reviewer',
    description: '',
    provider: 'openai',
    model: 'gpt-4.1',
    systemPrompt: 'You are a careful reviewer.',
    outputSchema: null,
    strategy: 'single-pass',
    ciFailOn: 'critical',
    repoIntel: false,
    enabled: true,
    version: 3,
    createdBy: null,
    createdAt: new Date('2026-08-28T00:00:00.000Z'),
    ...opts.agent,
  };

  const pull: PullRow = {
    id: PR_ID,
    workspaceId: WORKSPACE_ID,
    repoId: REPO_ID,
    number: 482,
    title: 'Add rate limiting',
    author: 'marisa.koch',
    branch: 'feat/rate-limit',
    base: 'main',
    headSha: 'a1b2c3d4',
    lastReviewedSha: null,
    additions: 4,
    deletions: 0,
    filesCount: 1,
    status: 'open',
    body: 'Adds a token-bucket limiter.',
    openedAt: null,
    updatedAt: null,
    ...opts.pull,
  };

  const repoRow: RepoRow = {
    id: REPO_ID,
    workspaceId: WORKSPACE_ID,
    owner: 'acme',
    name: 'payments-api',
    fullName: 'acme/payments-api',
    defaultBranch: 'main',
    clonePath: null,
    contextSearchRoots: null,
    lastPolledAt: null,
    createdBy: null,
    createdAt: new Date('2026-08-28T00:00:00.000Z'),
  };

  const finding: FindingRow = {
    id: FINDING_ID,
    reviewId: REVIEW_ID,
    file: 'src/config.ts',
    startLine: 11,
    endLine: 11,
    severity: 'CRITICAL',
    category: 'security',
    title: 'Hardcoded Stripe secret key in commit',
    rationale: 'Line 11 contains a literal key.',
    suggestion: null,
    confidence: 0.9,
    kind: 'finding',
    trifectaComponents: null,
    acceptedAt: null,
    dismissedAt: null,
    ...opts.finding,
  };

  const review = {
    id: REVIEW_ID,
    workspaceId: pull.workspaceId,
    prId: pull.id,
    agentId: opts.reviewAgentId !== undefined ? opts.reviewAgentId : agent.id,
    runId: null,
    kind: 'review',
    verdict: 'request_changes',
    summary: 's',
    score: 60,
    model: agent.model,
    createdAt: new Date('2026-08-28T00:00:00.000Z'),
  };

  const prFiles = opts.prFiles ?? [{ path: 'src/config.ts', patch: FIXTURE_PATCH }];

  const evalRepo = new InMemoryEvalRepo();
  evalRepo.agentNames[agent.id] = agent.name;
  const llm = new MockLLMProvider('openai', {
    structuredBySchema: { Review: opts.structured ?? REVIEW_FIXTURE },
  });
  const github = new MockGitHubClient();
  const logger = new CapturingLogger();
  const recorded = { insertReview: [] as unknown[], insertFindings: [] as unknown[], githubResolves: 0 };
  const llmResolves: string[] = [];

  const container = {
    config: { promptLogVerbose: false },
    evalRepo,
    reviewRepo: {
      findingContext: async (id: string) =>
        id === finding.id ? { finding, review, pull } : undefined,
      getPrFiles: async () => prFiles,
      getRepo: async () => repoRow,
      // AC-30 spies — the executor must never write review-domain rows.
      insertReview: async (values: unknown) => {
        recorded.insertReview.push(values);
        return { id: 'review-x' };
      },
      insertFindings: async (_reviewId: string, values: unknown[]) => {
        recorded.insertFindings.push(...values);
        return [];
      },
    },
    agentsRepo: {
      getById: async (workspaceId: string, id: string) =>
        !opts.agentMissing && workspaceId === agent.workspaceId && id === agent.id
          ? agent
          : undefined,
      enabledSkillsForPrompt: async () => opts.linkedSkills ?? [],
    },
    llm: async (id: string) => {
      llmResolves.push(id);
      return opts.llm ?? llm;
    },
    // AC-30 — wired, present, and expected to record ZERO resolutions.
    github: async () => {
      recorded.githubResolves += 1;
      return github;
    },
  };

  const service = new EvalService(container as never);

  return {
    service,
    evalRepo,
    llm,
    github,
    logger,
    agent,
    pull,
    finding,
    recorded,
    llmResolves,
    userPrompts() {
      return llm.calls
        .filter((c) => c.method === 'completeStructured')
        .map((c) => {
          const req = c.req as { messages: { role: string; content: string }[] };
          return req.messages.find((m) => m.role === 'user')?.content ?? '';
        });
    },
    structuredCalls() {
      return llm.calls
        .filter((c) => c.method === 'completeStructured')
        .map((c) => c.req as { model?: string; maxTokens?: number; timeoutMs?: number; sessionId?: string });
    },
  };
}
