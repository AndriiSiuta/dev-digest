/**
 * smart-diff — narrow input shapes `helpers.ts` needs. Deliberately NOT the
 * Drizzle row types (`PrFileRow` / `FindingRow` / `ReviewRow`): keeping the
 * pure builder's input shape independent of the persistence layer is what
 * lets `smart-diff-helpers.test.ts` construct fixtures with no DB and no
 * mocks.
 */

/** A PR's persisted file — only the fields the builder needs. */
export interface SmartDiffPrFile {
  path: string;
  additions: number;
  deletions: number;
}

/** A persisted finding — only the fields the builder needs. */
export interface SmartDiffFindingInput {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Free text at this layer (the DB column has no enum type); validated by
   *  the `SmartDiffFinding` zod schema when the response is serialized. */
  severity: string;
  title: string;
}

/** One persisted review (any kind) + its findings — only what `pickLatestFindings` needs. */
export interface SmartDiffReviewInput {
  review: {
    kind: string;
    agentId: string | null;
  };
  findings: SmartDiffFindingInput[];
}

/**
 * The module's port onto `pullsRepo` / `reviewRepo` — declared here, in the
 * module's own `types.ts`, rather than by importing `PullsRepository` /
 * `ReviewRepository` from their owning modules (`no-cross-module-internals`
 * bans reaching another module's `repository.ts`, even as a type-only
 * import: dependency-cruiser runs on the RUNTIME graph and cannot see a type
 * import, so this stays a code-review-only rule if broken). Both repository
 * classes satisfy these structurally; the container passes the concrete
 * instances straight through.
 */
export interface SmartDiffPullsRepo {
  getPull(workspaceId: string, prId: string): Promise<unknown | undefined>;
  getFiles(prId: string): Promise<SmartDiffPrFile[]>;
}

export interface SmartDiffReviewRepo {
  reviewsForPull(prId: string): Promise<SmartDiffReviewInput[]>;
}
