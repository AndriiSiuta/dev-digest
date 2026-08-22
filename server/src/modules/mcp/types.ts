/**
 * mcp — the module's dependency bundle and its projection output shapes.
 *
 * These types are deliberately NOT `@devdigest/shared` contracts. An MCP wire
 * format is not an API contract: no client consumes it, and putting it in
 * `vendor/shared` would force a hand-sync of `client/src/vendor/shared/` for a
 * consumer that does not exist (see `specs/01-mcp-server.md` § Routes).
 *
 * Three sourcing rules, in order of preference:
 *
 *   1. Another module's `types.ts` IS its published surface and stays
 *      importable (`.dependency-cruiser.cjs:29-40` bans only
 *      `service|repository|routes|helpers|run-executor|diff-loader|findings|
 *      status`) — hence `ReviewRunner` / `ReviewDto` and `RepoIntel` /
 *      `BlastResult` below.
 *   2. A repository with no published port gets a NARROW STRUCTURAL interface
 *      declared right here — never `import type { AgentsRepository } from
 *      '../agents/repository.js'`. dependency-cruiser runs with
 *      `tsPreCompilationDeps: false`, so a type-only reach into another
 *      module's data layer is erased before the graph is built and NOTHING
 *      catches it: this convention is the only enforcement there is
 *      (`INSIGHTS.md:90`). The precedent is `modules/smart-diff/types.ts`.
 *      Signatures are copied verbatim from the real classes so the concrete
 *      instances the container hands over satisfy them structurally.
 *   3. Row shapes come from `src/db/rows.ts`, the sanctioned cross-module home.
 */

import type { RunEvent, RunSummary, Severity } from '@devdigest/shared';
import type { AgentRow, ConventionRow, PullRow, RepoRow } from '../../db/rows.js';
import type { ReviewDto, ReviewRunner } from '../reviews/types.js';
import type { BlastResult, RepoIntel } from '../repo-intel/types.js';

// ---------------------------------------------------------------------------
// Ports onto repositories that publish none of their own.
// ---------------------------------------------------------------------------

/** `AgentsRepository` satisfies this structurally. */
export interface McpAgentsRepo {
  list(workspaceId: string): Promise<AgentRow[]>;
  listEnabled(workspaceId: string): Promise<AgentRow[]>;
}

/** `RepoRepository` satisfies this structurally. */
export interface McpReposRepo {
  list(workspaceId: string): Promise<RepoRow[]>;
  findByFullName(workspaceId: string, fullName: string): Promise<RepoRow | undefined>;
}

/** `PullsRepository` satisfies this structurally. */
export interface McpPullsRepo {
  findByRepoAndNumber(
    workspaceId: string,
    repoId: string,
    number: number,
  ): Promise<PullRow | undefined>;
}

/** `ConventionsRepository` satisfies this structurally. */
export interface McpConventionsRepo {
  listForRepo(workspaceId: string, repoId: string): Promise<ConventionRow[]>;
}

/**
 * The slice of `platform/sse.ts`'s `RunBus` the blocking run tool needs. Narrow
 * on purpose: `RunBus` is a class with private fields, so an object literal can
 * never satisfy it — declaring the port here is what lets `run-waiter.ts` be
 * driven by a fake bus while `container.runBus` still passes straight through.
 */
export interface McpRunBus {
  subscribe(runId: string, listener: (e: RunEvent) => void): () => void;
  onDone(runId: string, listener: () => void): () => void;
  buffer(runId: string): RunEvent[];
  isComplete(runId: string): boolean;
}

/**
 * Everything the tools are allowed to touch. Assembled once in `routes.ts` from
 * the container, so no tool ever reaches for `Container` itself and the whole
 * module is drivable from a test with plain objects.
 */
export interface McpDeps {
  agentsRepo: McpAgentsRepo;
  reposRepo: McpReposRepo;
  pullsRepo: McpPullsRepo;
  conventionsRepo: McpConventionsRepo;
  reviewRunner: ReviewRunner;
  repoIntel: RepoIntel;
  runBus: McpRunBus;
}

// ---------------------------------------------------------------------------
// Projection inputs — the exact slices `projections.ts` reads.
// ---------------------------------------------------------------------------

/**
 * The finding fields the projection reads, taken off the REAL `ReviewDto` so a
 * rename in the reviews module breaks this at compile time instead of silently
 * emitting `undefined`. `ReviewDto` is published through
 * `modules/reviews/types.ts`; its `helpers.ts` stays unimported.
 */
export type McpFindingSource = Pick<
  ReviewDto['findings'][number],
  'id' | 'severity' | 'file' | 'start_line' | 'title'
>;

/** The run fields the projection reads, taken off `@devdigest/shared`'s `RunSummary`. */
export type McpRunSource = Pick<RunSummary, 'run_id' | 'status' | 'score' | 'error'>;

/** Re-exported so `projections.ts` and the tools name one blast input shape. */
export type { BlastResult };

// ---------------------------------------------------------------------------
// Projection outputs — the MCP wire shapes. One shape per source, no modes.
// ---------------------------------------------------------------------------

/** From `AgentRow`. Never `system_prompt` / `output_schema`. */
export interface McpAgent {
  name: string;
  model: string;
  enabled: boolean;
}

/**
 * From a review finding. `rationale` / `suggestion` are deliberately absent —
 * one rationale is 400-1500 chars of markdown and forty of them approach the
 * 25k output cap (`specs/01-mcp-server.md` § Accepted limitation).
 */
export interface McpFinding {
  id: string;
  severity: Severity;
  file: string;
  /** `start_line` — a finding's anchor; the range end is not carried. */
  line: number;
  title: string;
}

/** From `ConventionRow`. Never `rationale` / `evidence_*`. */
export interface McpConvention {
  category: string;
  rule: string;
  confidence: number | null;
}

/**
 * From `RunSummary`. Never `tokens_*` / `cost_usd` / `grounding` / `provider`.
 * `score` and `error` are omitted entirely when null — an absent key costs no
 * tokens and reads the same to a model.
 *
 * The run tool's full payload (`{status, run_id, agent, verdict, score, counts,
 * findings}`) is composed around this; this type is only the run projection.
 */
export interface McpRunResult {
  status: string;
  run_id: string;
  score?: number;
  error?: string;
}

/** Per-severity tally. Always all three keys, uppercase (the contract's casing). */
export type McpSeverityCounts = Record<Severity, number>;

/**
 * From `BlastResult`. Never `factsByFile` (per-caller-file endpoint/cron facts
 * — an internal read-model detail) and never the full `callers[]` list, which is
 * summarized to a count.
 */
export interface McpBlast {
  changed_symbols: { file: string; name: string; kind: string }[];
  impacted_endpoints: string[];
  caller_count: number;
}

/**
 * The "помилка веде далі" payload: never thrown, never a bare MCP error. `error`
 * is a stable machine code, `message` states the miss with the valid values
 * listed INLINE, and `next` names the exact call to make instead.
 *
 * The index signature carries builder-specific extras (e.g. `available_agents`);
 * those are literal-built by the builder, never a spread database row.
 */
export interface McpGuidance {
  error: string;
  message: string;
  next: string;
  [key: string]: unknown;
}
