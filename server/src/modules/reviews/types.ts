import type { RunSummary } from '@devdigest/shared';
import type { AgentRow } from '../../db/rows.js';
import type { PinoLike } from '../../platform/run-logger.js';
import type { ReviewDto } from './helpers.js';

/**
 * The review DTO, re-exported through the module's published surface.
 * `no-cross-module-internals` bans importing another module's `helpers.ts`, so
 * this is the only legal way for a consumer of `ReviewRunner` to name the shape
 * `reviewsForPull` returns.
 */
export type { ReviewDto };

/**
 * reviews — the module's port (repoIntel/intent facade pattern). Consumers code
 * against this via `container.reviewRunner`; tests inject a mock through
 * `ContainerOverrides.reviewRunner`.
 *
 * `resolveTargets` is deliberately NOT here: it throws `NotFoundError` on an
 * unknown agent, and a caller that must answer with guidance instead of an error
 * (MCP) resolves the agent itself and passes the row in.
 */
export interface ReviewRunner {
  /**
   * Start a review run per target agent and return the run ids immediately —
   * the runs themselves execute in the background. Targets are full `AgentRow`s
   * because the executor reads `systemPrompt`, `provider`, `model`, `ciFailOn`,
   * `repoIntel` and `version` off them; a narrowed target type would not do.
   *
   * `reviews` is widened to `unknown[]`: the implementation always returns `[]`
   * (reviews are persisted as each agent finishes, not returned here), so the
   * port publishes no shape a caller could be tempted to read.
   */
  runReview(
    workspaceId: string,
    prId: string,
    targets: AgentRow[],
    logger?: PinoLike,
  ): Promise<{ runs: { run_id: string; agent_id: string; agent_name: string }[]; reviews: unknown[] }>;

  /** In-flight runs for a PR (server-side source of truth, survives reload). */
  activeRuns(
    workspaceId: string,
    prId: string,
  ): Promise<{ run_id: string; agent_id: string | null; agent_name: string | null; ran_at: string | null }[]>;

  /** All runs for a PR (any status), newest first — the run history. */
  listRuns(workspaceId: string, prId: string): Promise<RunSummary[]>;

  /** Persisted reviews + findings for a PR. */
  reviewsForPull(workspaceId: string, prId: string): Promise<ReviewDto[]>;

  /**
   * Cancel an in-flight run. The only sanctioned cancellation path: it signals
   * the live runner, marks the `agent_runs` row cancelled AND completes the bus,
   * which a raw `runBus.cancel` does not.
   */
  cancelRun(runId: string): Promise<void>;
}
