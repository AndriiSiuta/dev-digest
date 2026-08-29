/** Constants for the agent editor's Evals tab. */

/** Exactly two batches compare (AC-35); a third selection replaces the older pick. */
export const COMPARE_LIMIT = 2;

/** Skeleton rows shown while the case list / history load. */
export const SKELETON_ROWS = 3;

/** Expectation-kind → badge colour token (neutral for an unparseable payload). */
export const KIND_COLOR = {
  must_find: "var(--ok)",
  must_not_flag: "var(--warn)",
  unknown: "var(--text-muted)",
} as const;
