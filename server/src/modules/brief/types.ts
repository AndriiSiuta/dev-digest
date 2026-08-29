import type {
  BlastPanel,
  BriefMissingInput,
  PrBriefRecord,
  PrIntentRecord,
  SmartDiffResponse,
} from '@devdigest/shared';
import type { PinoLike } from '../../platform/run-logger.js';

/**
 * brief — the module's published surface.
 *
 * `BriefFacade` is the port callers outside the module reach through
 * `container.brief`; tests inject a double through `ContainerOverrides.brief`.
 * The repository reads below are declared as NARROW STRUCTURAL ports rather
 * than by importing `PullsRepository` / `ReviewRepository` / `RepoRepository`
 * (`no-cross-module-internals` bans reaching another module's `repository.ts`,
 * and dependency-cruiser cannot see a type-only import — so this is the
 * convention that keeps the graph clean for the right reason;
 * `server/INSIGHTS.md`, 2026-08-16). The concrete repositories satisfy them
 * structurally, and the container passes them straight through.
 */

export interface BriefFacade {
  /** The stored brief, or `undefined` when the PR has none. Never calls a model. */
  get(workspaceId: string, prId: string): Promise<PrBriefRecord | undefined>;
  /**
   * Generate (or return the cached) brief for a PR.
   *
   * `logger` is REQUIRED, not optional: AC-NF-05 is a SHALL ("record the model,
   * the token counts and the cost of each brief generation"), and an optional
   * logger some caller forgets is a silent observability hole rather than a
   * degraded mode — the exact bug that made the intent classifier's one log
   * line dead on the review path (`server/INSIGHTS.md`, 2026-08-14). The route
   * has `req.log` in hand and no other caller exists.
   */
  generate(
    workspaceId: string,
    prId: string,
    opts: { force: boolean; logger: PinoLike; correlationId?: string },
  ): Promise<PrBriefRecord>;
}

/** The PR row — only the fields the brief reads. */
export interface BriefPull {
  id: string;
  repoId: string;
  number: number;
  title: string;
  body: string | null;
  headSha: string;
}

/** The repository row — only what the prompt names. */
export interface BriefRepo {
  id: string;
  owner: string;
  name: string;
  fullName: string;
}

export interface BriefPullsRepo {
  getPull(workspaceId: string, prId: string): Promise<BriefPull | undefined>;
  getRepoById(repoId: string): Promise<BriefRepo | undefined>;
  /**
   * The PR's FULL changed-path list. Read as `{ path }` only: `PrFileRow` also
   * carries `patch`, and never naming it is what makes AC-03 ("no diff hunk
   * body in the prompt") structural rather than disciplinary.
   */
  getFiles(prId: string): Promise<Array<{ path: string }>>;
}

export interface BriefReviewRepo {
  getIntent(prId: string): Promise<PrIntentRecord | undefined>;
}

export interface BriefReposRepo {
  getSearchRoots(workspaceId: string, repoId: string): Promise<string[] | null>;
}

/**
 * Everything gathered before the model call — the single input the prompt
 * builder and the grounding gate both read. `intent`, `blast` and `smartDiff`
 * are `undefined` when their source was absent or unreachable; `missing` is the
 * ledger that becomes `Brief.missing_inputs` (AC-32).
 */
export interface BriefFacts {
  pull: BriefPull;
  repo: BriefRepo;
  /** The PR's full changed-path list — also the grounding universe (AC-06). */
  changedPaths: string[];
  intent: PrIntentRecord | undefined;
  blast: BlastPanel | undefined;
  smartDiff: SmartDiffResponse | undefined;
  /** Selected `spec` documents, already read (AC-35). */
  docs: { path: string; text: string }[];
  missing: BriefMissingInput[];
}
