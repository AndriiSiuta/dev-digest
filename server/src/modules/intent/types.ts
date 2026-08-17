import type { PrIntentRecord } from '@devdigest/shared';
import type { PullRow } from '../../db/rows.js';
import type { PinoLike } from '../../platform/run-logger.js';

/**
 * intent — the module's port (repoIntel facade pattern). The review
 * run-executor codes against this via `container.intent`; tests inject a mock
 * through `ContainerOverrides.intent`.
 */
export interface IntentFacade {
  /**
   * The PR's persisted intent, or a fresh classification when none exists.
   * May throw (missing key, provider error) — callers on the review path treat
   * any failure as "no intent" so the prompt stays byte-identical to today.
   *
   * `correlationId` (the caller's runId on the review path) and `logger` are
   * optional and last so existing call sites and test doubles keep compiling.
   * Together they make a classification triggered inside a review emit its
   * prompt line under that run's id; without a logger nothing is emitted.
   */
  getOrClassify(
    workspaceId: string,
    pull: PullRow,
    correlationId?: string,
    logger?: PinoLike,
  ): Promise<PrIntentRecord | undefined>;
}
