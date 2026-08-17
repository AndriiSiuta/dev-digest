/** Constants for the DiffViewer. */

/** Files with this many or fewer changed lines start expanded. */
export const AUTO_EXPAND_MAX_LINES = 200;

/** Matches a unified-diff hunk header, e.g. `@@ -1,2 +1,3 @@`. */
export const HUNK_HEADER_RE = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Severity → priority. Picks the highest-severity finding on a line (a line
 * can carry more than one) to color that line's left accent bar — higher
 * wins. Mirrors the server's own `SEVERITY_RANK`
 * (`server/src/modules/smart-diff/constants.ts`).
 */
export const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 3,
  WARNING: 2,
  SUGGESTION: 1,
};
