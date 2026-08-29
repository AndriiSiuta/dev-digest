import { ReviewRunExecutor } from '../../src/modules/reviews/run-executor.js';
import { MockGitClient, MockLLMProvider, MockProjectContextDocs } from '../../src/adapters/mocks.js';
import { ProjectContextService } from '../../src/modules/project-context/service.js';
import { runBus } from '../../src/platform/sse.js';
import type { RunTrace } from '@devdigest/shared';
import type { AgentRow, PullRow, RepoRow } from '../../src/db/rows.js';

/**
 * Hermetic `ReviewRunExecutor` harness — no Postgres, no Docker, no network.
 *
 * The container is an object literal cast to `never`: `Container` carries
 * private fields (and so does `RunBus`), and TypeScript compares private
 * members nominally, so no literal can ever satisfy those types
 * (`server/INSIGHTS.md`, 2026-08-17). The real `runBus` singleton is passed
 * straight through — it is in-memory and needs no infrastructure.
 *
 * The `ReviewRepository` stand-in records every write in memory so a test can
 * assert on the persisted trace without a database.
 */

/** Every write the executor makes, captured instead of persisted. */
export interface RecordedRepo {
  reviews: unknown[];
  findings: unknown[];
  completions: { runId: string; values: Record<string, unknown> }[];
  traces: { runId: string; trace: RunTrace }[];
  reviewed: { prId: string; sha: string }[];
}

/**
 * Attached project-context documents for a run. When present the harness wires
 * a REAL `ProjectContextService` over fake repositories and
 * `MockProjectContextDocs`, so the ordering, dedupe and ceiling logic under
 * test is the shipped one. When absent the facade is still wired — it just
 * resolves to nothing, which is the case AC-14 pins.
 */
export interface ContextFixture {
  /** `path → content` in the checkout. */
  files?: Record<string, string>;
  /** Paths attached directly to the agent, in attachment order. */
  agentDocs?: string[];
  /** Enabled linked skill ids, in link order. */
  skillLinks?: string[];
  /** `skillId → paths` attached to each skill, in attachment order. */
  skillDocs?: Record<string, string[]>;
  /** Per-call token ceiling override. */
  ceiling?: number;
}

export interface HarnessOptions {
  /** Enabled linked skills, in link order, as `enabledSkillsForPrompt` returns them. */
  linkedSkills?: { skill: { id: string; name: string; body: string }; order: number; enabled: boolean }[];
  /** Overrides merged onto the default agent row. */
  agent?: Partial<AgentRow>;
  /** Overrides merged onto the default PR row. */
  pull?: Partial<PullRow>;
  /** Attached documents; omit for the no-documents baseline. */
  context?: ContextFixture;
  /** Extra container members merged over the defaults. */
  container?: Record<string, unknown>;
  /** Cancel the run before it starts (exercises the cancel/failure trace path). */
  cancelUpFront?: boolean;
}

export interface Harness {
  executor: ReviewRunExecutor;
  llm: MockLLMProvider;
  recorded: RecordedRepo;
  /** Token-count spy — every `container.tokenizer.count` call lands here. */
  tokenizerCalls: string[];
  /** The document store behind the run, when `context` was supplied. */
  contextDocs?: MockProjectContextDocs;
  workspaceId: string;
  agent: AgentRow;
  pull: PullRow;
  repoRow: RepoRow;
  runId: string;
  /** Run the executor once. Never throws — per-agent failures are isolated. */
  run(): Promise<void>;
  /** Every event the run published on the bus, oldest first. */
  events(): { kind: string; msg: string }[];
  /** The user message that reached `MockLLMProvider`, or undefined if none did. */
  userPrompt(): string | undefined;
  /** How many times the mock provider was asked for a completion. */
  llmCallCount(): number;
}

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const REPO_ID = '00000000-0000-4000-8000-000000000002';
const PR_ID = '00000000-0000-4000-8000-000000000003';
const AGENT_ID = '00000000-0000-4000-8000-000000000004';

/**
 * A fixture review the mock provider returns for every structured call. The
 * finding cites `src/config.ts:12`, which the default mock diff contains, so it
 * survives the grounding gate.
 */
const REVIEW_FIXTURE = {
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
      start_line: 12,
      end_line: 12,
      rationale: 'Line 12 contains a literal `sk_live_` key.',
      suggestion: 'Move it to an env var.',
      confidence: 0.9,
    },
  ],
};

export function buildHarness(opts: HarnessOptions = {}): Harness {
  const runId = `run-${Math.random().toString(36).slice(2)}`;

  const llm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });

  const recorded: RecordedRepo = {
    reviews: [],
    findings: [],
    completions: [],
    traces: [],
    reviewed: [],
  };
  const tokenizerCalls: string[] = [];

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
    // Off, so no repo-intel enrichment reaches the prompt and the baseline
    // depends on nothing outside this file.
    repoIntel: false,
    enabled: true,
    version: 1,
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
    // No body — the PR-description section stays out of the baseline prompt.
    body: null,
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
    clonePath: '/mock/clones/acme/payments-api',
    // Present because `RepoRow` requires it; the run path reads it through
    // `reposRepo.getSearchRoots`, not off this fixture.
    contextSearchRoots: null,
    lastPolledAt: null,
    createdBy: null,
    createdAt: new Date('2026-08-28T00:00:00.000Z'),
  };

  const repo = {
    getPrFiles: async () => [],
    insertReview: async (values: Record<string, unknown>) => {
      recorded.reviews.push(values);
      return {
        id: 'review-1',
        prId: pull.id,
        agentId: agent.id,
        runId,
        kind: 'review',
        verdict: values.verdict,
        summary: values.summary,
        score: values.score,
        model: values.model,
        createdAt: new Date('2026-08-28T00:00:00.000Z'),
      };
    },
    insertFindings: async (_reviewId: string, findings: unknown[]) => {
      recorded.findings.push(...findings);
      return findings.map((_f, i) => ({ id: `finding-${i}` }));
    },
    markReviewed: async (prId: string, sha: string) => {
      recorded.reviewed.push({ prId, sha });
    },
    completeAgentRun: async (id: string, values: Record<string, unknown>) => {
      recorded.completions.push({ runId: id, values });
    },
    saveRunTrace: async (id: string, trace: RunTrace) => {
      recorded.traces.push({ runId: id, trace });
    },
  };

  const tokenizer = {
    count: (s: string) => {
      tokenizerCalls.push(s);
      // Deterministic and cheap: one "token" per whitespace-separated word.
      return s.trim().length === 0 ? 0 : s.trim().split(/\s+/).length;
    },
  };

  // The project-context facade is ALWAYS wired, even with nothing attached —
  // that is what makes the AC-14 baseline meaningful. An unwired facade would
  // throw, be swallowed by the best-effort catch, and pass the same assertions
  // while proving nothing about the feature being called.
  const contextDocs = opts.context ? new MockProjectContextDocs({ ...opts.context.files }) : undefined;
  const projectContext = contextDocs
    ? {
        resolveForRun: (input: Parameters<ProjectContextService['resolveForRun']>[0]) =>
          new ProjectContextService({
            reposRepo: { getSearchRoots: async () => null },
            agentsRepo: {
              enabledContextDocsForPrompt: async () =>
                (opts.context?.agentDocs ?? []).map((path, order) => ({ path, order })),
              enabledSkillsForPrompt: async () =>
                (opts.context?.skillLinks ?? []).map((id, order) => ({ skill: { id }, order })),
            },
            skillsRepo: {
              enabledContextDocsForPrompt: async (skillId: string) =>
                (opts.context?.skillDocs?.[skillId] ?? []).map((path, order) => ({ path, order })),
            },
            projectContextDocs: contextDocs,
            tokenizer,
          } as never).resolveForRun({
            ...input,
            ...(opts.context?.ceiling !== undefined ? { ceiling: opts.context.ceiling } : {}),
          }),
      }
    : { resolveForRun: async () => ({ specs: [], specsRead: [], tokens: 0 }) };

  const container = {
    config: { promptLogVerbose: false, repoIntelEnabled: false },
    projectContext,
    runBus,
    git: new MockGitClient(),
    tokenizer,
    llm: async () => llm,
    // Intent is best-effort pre-work; `undefined` keeps the section out of the
    // prompt AND guarantees no provider is resolved for classification.
    intent: { getOrClassify: async () => undefined },
    repoIntel: {
      getCallerSignatures: async () => [],
      getRepoMap: async () => ({ text: '', tokens: 0, cached: false, degraded: true }),
      getFileRank: async () => [],
    },
    agentsRepo: {
      enabledSkillsForPrompt: async () => opts.linkedSkills ?? [],
    },
    ...opts.container,
  };

  const executor = new ReviewRunExecutor(
    container as never,
    repo as never,
    container.agentsRepo as never,
  );

  return {
    executor,
    llm,
    recorded,
    tokenizerCalls,
    ...(contextDocs ? { contextDocs } : {}),
    workspaceId: WORKSPACE_ID,
    agent,
    pull,
    repoRow,
    runId,
    async run() {
      if (opts.cancelUpFront) runBus.cancel(runId);
      await executor.executeRuns(WORKSPACE_ID, pull, repoRow, [{ agent, runId }]);
    },
    events() {
      return runBus.buffer(runId).map((e) => ({ kind: e.kind, msg: e.msg }));
    },
    userPrompt() {
      const call = llm.calls.find((c) => c.method === 'completeStructured');
      if (!call) return undefined;
      const req = call.req as { messages: { role: string; content: string }[] };
      return req.messages[1]?.content;
    },
    llmCallCount() {
      return llm.calls.filter((c) => c.method === 'completeStructured').length;
    },
  };
}
