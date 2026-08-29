import type { SmartDiffResponse } from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { buildSmartDiff } from './helpers.js';
import type {
  SmartDiffFacade,
  SmartDiffPullsRepo,
  SmartDiffReviewRepo,
} from './types.js';

/**
 * smart-diff — pure recombination of already-imported PR files and
 * already-computed review findings. This module makes no paid API call and
 * has no dependency on any model provider or its logging.
 *
 * Narrow deps (only the two reads this module needs), per
 * `onion-architecture`'s guidance for a NEW service: the constructor's
 * signature is the whole list of capabilities it touches, rather than the
 * full `Container`. Typed against this module's own port (`types.ts`), not
 * `PullsRepository` / `ReviewRepository` directly — see the comment there.
 */
export class SmartDiffService implements SmartDiffFacade {
  constructor(
    private pullsRepo: SmartDiffPullsRepo,
    private reviewRepo: SmartDiffReviewRepo,
  ) {}

  /** Computed fresh on every request — nothing about Smart Diff is persisted. */
  async get(workspaceId: string, prId: string): Promise<SmartDiffResponse> {
    const pull = await this.pullsRepo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const [files, reviews] = await Promise.all([
      this.pullsRepo.getFiles(prId),
      this.reviewRepo.reviewsForPull(prId),
    ]);
    return buildSmartDiff(files, reviews);
  }
}
