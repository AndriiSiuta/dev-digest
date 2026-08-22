import type { BlastResult } from '../repo-intel/types.js';

/**
 * blast — narrow input shapes and ports. Deliberately NOT the Drizzle row
 * types and NOT `PullsRepository` / the `RepoIntel` class: the module's port
 * onto `pullsRepo` / `repoIntel` is declared here, in the module's own
 * `types.ts` (`no-cross-module-internals` bans reaching another module's
 * `repository.ts`, even as a type-only import — dependency-cruiser runs on
 * the RUNTIME graph and cannot see a type import, so this stays a
 * code-review-only rule if broken). The cross-module `types.ts` import above
 * is the sanctioned exception. `PullsRepository` and the container's
 * `repoIntel` satisfy these structurally; the container passes the concrete
 * instances straight through.
 */

/** The PR row — only the fields the service needs. */
export interface BlastPull {
  id: string;
  repoId: string;
  headSha: string;
}

/** A prior-PR row for the overlap history — only what `buildHistory` needs. */
export interface BlastHistoryPull {
  number: number;
  title: string;
  author: string;
  status: string;
  updatedAt: Date | null;
}

export interface BlastPullsRepo {
  getPull(workspaceId: string, prId: string): Promise<BlastPull | undefined>;
  getFiles(prId: string): Promise<Array<{ path: string }>>;
  listOverlapping(
    repoId: string,
    excludePrId: string,
    paths: string[],
    limit: number,
  ): Promise<Array<{ pull: BlastHistoryPull; overlap: string[] }>>;
}

export interface BlastRepoIntel {
  getBlastRadius(repoId: string, changedFiles: string[]): Promise<BlastResult>;
}
