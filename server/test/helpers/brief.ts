import type {
  BlastPanel,
  Brief,
  PrIntentRecord,
  SmartDiffResponse,
  StructuredRequest,
} from '@devdigest/shared';
import { MockLLMProvider, MockProjectContextDocs } from '../../src/adapters/mocks.js';
import { BriefService } from '../../src/modules/brief/service.js';
import { BRIEF_SCHEMA_NAME } from '../../src/modules/brief/constants.js';
import type { StoredBrief } from '../../src/modules/brief/repository.js';
import type { PinoLike } from '../../src/platform/run-logger.js';

/**
 * Hermetic `BriefService` harness — no Postgres, no Docker, no network.
 *
 * The container is an object literal cast to `never`: `Container` carries
 * private fields and TypeScript compares those nominally, so no literal can
 * satisfy the type (`server/INSIGHTS.md`, 2026-08-17).
 *
 * EVERY dependency the service touches is wired and resolves to something
 * empty by default — never absent. An absent facade throws
 * `Cannot read properties of undefined` inside the gather step's best-effort
 * `catch`, which is swallowed, and the test then passes for the wrong reason
 * while proving nothing about the wiring it exists to guard
 * (`server/INSIGHTS.md`, *What Doesn't Work*, 2026-08-28).
 */

export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const REPO_ID = '00000000-0000-4000-8000-000000000002';
export const PR_ID = '00000000-0000-4000-8000-000000000003';
export const HEAD_SHA = 'a1b2c3d4';

/** A well-formed model draft: one grounded risk, one grounded focus item. */
export const DEFAULT_DRAFT = {
  what: 'Adds an idempotency key to order creation.',
  why: 'Retries were double-charging customers.',
  risks: [
    {
      kind: 'regression',
      title: 'Retry path is not idempotent',
      explanation: 'A second attempt can create a second order.',
      file_refs: ['src/orders.ts'],
      endpoint_refs: [] as string[],
      severity: 'medium',
    },
  ],
  review_focus: [{ file: 'src/orders.ts', line: 12, reason: 'new idempotency key handling' }],
  risk_level: 'low',
};

export const EMPTY_BLAST: BlastPanel = {
  blast: { changed_symbols: [], downstream: [], summary: 'No indexed symbols changed.' },
  history: { history: [] },
  degraded: false,
  head_sha: HEAD_SHA,
};

export const EMPTY_SMART_DIFF: SmartDiffResponse = {
  groups: [],
  split_suggestion: { too_big: false, total_lines: 0, proposed_splits: [] },
};

export interface BriefHarnessOptions {
  /** Overrides merged onto the default PR row. */
  pull?: Partial<{ headSha: string; title: string; body: string | null; number: number }>;
  /** The PR's changed paths; `[]` exercises the zero-files early return. */
  files?: string[];
  /** The persisted intent record; omitted means "no `pr_intent` row". */
  intent?: PrIntentRecord;
  /** A panel, or an `Error` to make `container.blast.get` throw. */
  blast?: BlastPanel | Error;
  /** A response, or an `Error` to make `container.smartDiff.get` throw. */
  smartDiff?: SmartDiffResponse | Error;
  /** `path → content` behind `MockProjectContextDocs`. */
  docs?: Record<string, string>;
  /** Search roots, or an `Error` to make `getSearchRoots` throw. */
  searchRoots?: string[] | null | Error;
  /** Fixture the mock provider returns for the `PrBriefDraft` call. */
  draft?: unknown;
  /** Make the provider call fail (AC-15). */
  llmError?: Error;
  /** Workspace `settings` rows, e.g. a `feature_models` override (AC-NF-03). */
  settings?: { key: string; value: unknown }[];
  /** A pre-existing `pr_brief` row. */
  stored?: { brief: Brief; headSha: string; model: string | null; generatedAt?: Date };
}

export interface BriefHarness {
  service: BriefService;
  llm: MockLLMProvider;
  logger: PinoLike;
  /** Every line the service logged, newest last. */
  logs: { obj: Record<string, unknown>; msg?: string }[];
  /** Per-source call counts — AC-02 asserts each is exactly 1. */
  calls: {
    getPull: number;
    getRepoById: number;
    getFiles: number;
    getIntent: number;
    blast: number;
    smartDiff: number;
    getSearchRoots: number;
    docsList: number;
    docsRead: number;
    intentGetOrClassify: number;
    insertReview: number;
    insertFindings: number;
    createAgentRun: number;
    reviewRunner: number;
  };
  /** Every `saveBrief` call, in order. */
  saved: { prId: string; brief: Brief; headSha: string; model: string | null }[];
  /** The in-memory `pr_brief` row, if any. */
  row(): StoredBrief | undefined;
  /** The user message of the one structured call, or undefined. */
  userPrompt(): string | undefined;
  /** How many structured calls the mock provider saw. */
  structuredCalls(): number;
  contextDocs: MockProjectContextDocs;
  /** Every provider id `container.llm(...)` was asked for (AC-NF-03). */
  providerIds: string[];
  workspaceId: string;
  prId: string;
}

export function buildBriefHarness(opts: BriefHarnessOptions = {}): BriefHarness {
  const calls: BriefHarness['calls'] = {
    getPull: 0,
    getRepoById: 0,
    getFiles: 0,
    getIntent: 0,
    blast: 0,
    smartDiff: 0,
    getSearchRoots: 0,
    docsList: 0,
    docsRead: 0,
    intentGetOrClassify: 0,
    insertReview: 0,
    insertFindings: 0,
    createAgentRun: 0,
    reviewRunner: 0,
  };
  const logs: BriefHarness['logs'] = [];
  const saved: BriefHarness['saved'] = [];

  const pull = {
    id: PR_ID,
    workspaceId: WORKSPACE_ID,
    repoId: REPO_ID,
    number: 482,
    title: 'Make order creation idempotent',
    body: 'Adds an idempotency key to the retry path.',
    headSha: HEAD_SHA,
    ...opts.pull,
  };

  const repo = {
    id: REPO_ID,
    workspaceId: WORKSPACE_ID,
    owner: 'acme',
    name: 'payments-api',
    fullName: 'acme/payments-api',
  };

  const files = (opts.files ?? ['src/orders.ts', 'src/retry.ts']).map((path) => ({
    path,
    // A patch column the brief must never read — `BriefPullsRepo.getFiles` is
    // typed `{ path }`, so this is here to have something to leak.
    patch: `@@ -1 +1 @@\n+// PATCH_BODY_${path}`,
  }));

  const llm = new MockLLMProvider('openai', {
    structuredBySchema: { [BRIEF_SCHEMA_NAME]: opts.draft ?? DEFAULT_DRAFT },
  });
  if (opts.llmError) {
    const err = opts.llmError;
    // Record the call, then fail — so "exactly one call was made and nothing
    // was written" stays assertable (AC-15).
    (llm as unknown as { completeStructured: unknown }).completeStructured = async (
      req: StructuredRequest<unknown>,
    ) => {
      llm.calls.push({ method: 'completeStructured', req });
      throw err;
    };
  }

  const contextDocs = new MockProjectContextDocs({ ...(opts.docs ?? {}) });
  const listedDocs = contextDocs.list.bind(contextDocs);
  const readDoc = contextDocs.read.bind(contextDocs);

  let row: StoredBrief | undefined = opts.stored
    ? {
        brief: opts.stored.brief,
        headSha: opts.stored.headSha,
        model: opts.stored.model,
        generatedAt: opts.stored.generatedAt ?? new Date('2026-08-28T00:00:00.000Z'),
      }
    : undefined;

  const settingsRows = opts.settings ?? [];
  const providerIds: string[] = [];

  const container = {
    config: { promptLogVerbose: false },
    db: {
      // `resolveFeatureModel` runs for real against this: one chainable
      // select().from().where() over the workspace's settings rows.
      select: () => ({ from: () => ({ where: async () => settingsRows }) }),
    },
    tokenizer: {
      count: (s: string) => (s.trim().length === 0 ? 0 : s.trim().split(/\s+/).length),
    },
    llm: async (id: string) => {
      providerIds.push(id);
      return llm;
    },
    pullsRepo: {
      getPull: async (workspaceId: string, prId: string) => {
        calls.getPull += 1;
        return workspaceId === WORKSPACE_ID && prId === PR_ID ? pull : undefined;
      },
      getRepoById: async () => {
        calls.getRepoById += 1;
        return repo;
      },
      getFiles: async () => {
        calls.getFiles += 1;
        return files;
      },
    },
    reviewRepo: {
      getIntent: async () => {
        calls.getIntent += 1;
        return opts.intent;
      },
      // Present so "the brief writes no review rows" is a real assertion
      // (AC-26) rather than a call that would have thrown anyway.
      insertReview: async () => {
        calls.insertReview += 1;
        return {};
      },
      insertFindings: async () => {
        calls.insertFindings += 1;
        return [];
      },
      createAgentRun: async () => {
        calls.createAgentRun += 1;
        return {};
      },
    },
    reposRepo: {
      getSearchRoots: async () => {
        calls.getSearchRoots += 1;
        if (opts.searchRoots instanceof Error) throw opts.searchRoots;
        return opts.searchRoots ?? null;
      },
    },
    briefRepo: {
      getBrief: async () => row,
      saveBrief: async (
        prId: string,
        values: { brief: Brief; headSha: string; model: string | null },
      ) => {
        saved.push({ prId, ...values });
        row = { ...values, generatedAt: new Date() };
      },
    },
    blast: {
      get: async () => {
        calls.blast += 1;
        if (opts.blast instanceof Error) throw opts.blast;
        return opts.blast ?? EMPTY_BLAST;
      },
    },
    smartDiff: {
      get: async () => {
        calls.smartDiff += 1;
        if (opts.smartDiff instanceof Error) throw opts.smartDiff;
        return opts.smartDiff ?? EMPTY_SMART_DIFF;
      },
    },
    projectContextDocs: {
      list: async (...args: Parameters<MockProjectContextDocs['list']>) => {
        calls.docsList += 1;
        return listedDocs(...args);
      },
      read: async (...args: Parameters<MockProjectContextDocs['read']>) => {
        calls.docsRead += 1;
        return readDoc(...args);
      },
    },
    // Wired and inert: the brief must never trigger a classification (AC-29)
    // or a review run (AC-26), and an ABSENT facade could not prove either.
    intent: {
      getOrClassify: async () => {
        calls.intentGetOrClassify += 1;
        return undefined;
      },
    },
    reviewRunner: {
      startRun: async () => {
        calls.reviewRunner += 1;
        return {};
      },
    },
  };

  const record = (obj: unknown, msg?: string) => {
    logs.push({ obj: obj as Record<string, unknown>, ...(msg === undefined ? {} : { msg }) });
  };
  const logger: PinoLike = { info: record, warn: record, error: record, debug: record };

  return {
    service: new BriefService(container as never),
    llm,
    logger,
    logs,
    calls,
    saved,
    row: () => row,
    contextDocs,
    providerIds,
    workspaceId: WORKSPACE_ID,
    prId: PR_ID,
    userPrompt() {
      const call = llm.calls.find((c) => c.method === 'completeStructured');
      if (!call) return undefined;
      const req = call.req as { messages: { role: string; content: string }[] };
      return req.messages[1]?.content;
    },
    structuredCalls() {
      return llm.calls.filter((c) => c.method === 'completeStructured').length;
    },
  };
}
