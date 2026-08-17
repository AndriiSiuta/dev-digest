/**
 * Intent classifier — tuning knobs. The gather step is deliberately cheap and
 * bounded: title + capped description + capped linked issues/docs + the
 * changed-file list with hunk HEADERS only (never diff bodies), so a
 * classification costs a predictable number of tokens on any PR size.
 */

/** Cap on the PR description that reaches the prompt. */
export const MAX_DESCRIPTION_CHARS = 4_000;

/** Cap per linked-issue body, and how many linked issues we fetch at most. */
export const MAX_ISSUE_CHARS = 4_000;
export const MAX_LINKED_ISSUES = 3;

/** Cap per linked doc/spec file, and how many doc links we follow at most. */
export const MAX_DOC_CHARS = 8_000;
export const MAX_DOC_LINKS = 3;

/** Cap on the rendered changed-file list (paths + hunk headers). */
export const MAX_FILE_LIST_CHARS = 6_000;

/** Model call bounds. Classification is one cheap structured call. */
export const CLASSIFY_TEMPERATURE = 0.1;
export const CLASSIFY_MAX_TOKENS = 1_500;
export const CLASSIFY_TIMEOUT_MS = 60_000;

/** How many risk areas we ask for. More than this is noise, not coverage. */
export const MAX_RISK_AREAS = 4;

/**
 * Confidence ceiling when the PR has no description: the model is guessing
 * from the title and file list alone, so its self-reported score is clamped.
 */
export const NO_DESCRIPTION_CONFIDENCE_CAP = 0.5;
