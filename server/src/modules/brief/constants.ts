/**
 * PR Brief — every threshold this feature introduces (AC-NF-12). Nothing here
 * is repeated inline in `service.ts`, `prompt.ts`, `helpers.ts` or `routes.ts`;
 * the module mirrors `smart-diff/constants.ts` and `project-context/constants.ts`.
 *
 * The brief is ONE structured model call over inputs the system already
 * computed, so every knob below is either a budget on what reaches the model or
 * a bound on that single call.
 */

/** AC-NF-04 — cap on the assembled model input, across all sections. */
export const BRIEF_MAX_INPUT_CHARS = 24_000;

/** AC-35 — at most this many discovered `spec` documents reach the prompt. */
export const BRIEF_MAX_SPEC_DOCS = 6;

/** AC-35 — combined budget ACROSS the selected documents, whole documents only. */
export const BRIEF_MAX_SPEC_DOC_CHARS = 12_000;

/** AC-NF-10 — output ceiling and abandon time for the one model call. */
export const BRIEF_MAX_TOKENS = 1_500;
export const BRIEF_TIMEOUT_MS = 60_000;

/** Matches `CLASSIFY_TEMPERATURE`: this is an extraction, not a brainstorm. */
export const BRIEF_TEMPERATURE = 0.1;

/** AC-NF-06 — per-route limit on `POST`; each call is a paid model call. */
export const BRIEF_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

/**
 * AC-05 — the structured call's schema name. Also the key a test targets
 * through `MockLLMOptions.structuredBySchema`, and the filter the inertness
 * test uses to prove no brief was generated as a side effect (AC-38).
 */
export const BRIEF_SCHEMA_NAME = 'PrBriefDraft';

/**
 * AC-35 — `ProjectContextDocType` is `z.string()`, not an enum
 * (`contracts/project-context.ts:17`), so the document type is matched as a
 * string. A repository whose roots produce no `spec` type contributes nothing.
 */
export const BRIEF_SPEC_DOC_TYPE = 'spec';

/**
 * AC-NF-04 — the drop order, highest priority FIRST. `fitToBudget` drops whole
 * sections from the bottom until the assembled prompt fits; index 0 (the PR
 * itself) is never dropped and nothing is ever truncated part-way.
 *
 * This is the spec's seven-entry input-priority list with one addition: the PR
 * description, which the spec's priority table omits but the prompt carries. It
 * sits directly below the intent record because it is the same class of input —
 * the PR's own claim about itself — and above every derived input.
 */
export const BRIEF_INPUT_PRIORITY = [
  'pull_request', // 1 — number, title, head SHA, changed-path list. Never dropped.
  'intent', // 2 — the persisted intent record + linked-issue refs
  'pr_description', // 3 — the author's body
  'blast_summary', // 4 — the deterministic summary + changed symbols
  'changed_files', // 5 — diff stats + core/wiring/boilerplate classification
  'downstream', // 6 — per-symbol callers, endpoints, crons
  'history', // 7 — prior PRs touching these files
  'project_context', // 8 — discovered spec documents; dropped first
] as const;
export type BriefInputSection = (typeof BRIEF_INPUT_PRIORITY)[number];

/**
 * Provenance label per section, for the `brief: generated` log line. Same shape
 * as `prompt-log.ts`'s own maps, so a brief line reads like a review line.
 */
export const BRIEF_SECTION_SOURCE: Record<BriefInputSection | 'system', string> = {
  system: 'brief-prompt',
  pull_request: 'github-pr',
  intent: 'intent-classifier',
  pr_description: 'github-pr',
  blast_summary: 'blast-radius',
  changed_files: 'smart-diff',
  downstream: 'blast-radius',
  history: 'pr-history',
  project_context: 'project-context',
};

/**
 * AC-30 — how a per-risk `RiskSeverity` ranks when the whole-PR
 * `BriefRiskLevel` is computed over the risks that SURVIVE grounding. An empty
 * list is `none` (AC-31), which is why this map has no fourth entry.
 */
export const SEVERITY_RANK = { high: 3, medium: 2, low: 1 } as const;
