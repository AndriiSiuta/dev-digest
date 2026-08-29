import type { BlastPanel } from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { HISTORY_LIMIT } from './constants.js';
import { buildBlastRadius, buildHistory } from './helpers.js';
import type { BlastFacade, BlastPullsRepo, BlastRepoIntel } from './types.js';

/**
 * blast — composes the repo-intel blast radius with the prior-PR overlap
 * history. Computed fresh on every request (smart-diff pattern): no POST, no
 * persistence, no model call — `getBlastRadius` reads the Postgres index (or
 * the ripgrep fallback, which is what `degraded` reports).
 *
 * Narrow deps (only the two capabilities this module touches), typed against
 * this module's own ports (`types.ts`), not `PullsRepository` / `RepoIntel`
 * directly — see the comment there.
 */
export class BlastService implements BlastFacade {
  constructor(
    private pullsRepo: BlastPullsRepo,
    private repoIntel: BlastRepoIntel,
  ) {}

  async get(workspaceId: string, prId: string): Promise<BlastPanel> {
    const pull = await this.pullsRepo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const paths = (await this.pullsRepo.getFiles(prId)).map((f) => f.path);
    const [result, overlapRows] = await Promise.all([
      this.repoIntel.getBlastRadius(pull.repoId, paths),
      this.pullsRepo.listOverlapping(pull.repoId, prId, paths, HISTORY_LIMIT),
    ]);

    return {
      blast: buildBlastRadius(result),
      history: buildHistory(overlapRows),
      degraded: result.degraded === true,
      head_sha: pull.headSha,
    };
  }
}
