/**
 * Eval pipeline — every threshold this feature introduces (AC-NF-10). Nothing
 * below is repeated inline in `service.ts`, `helpers.ts`, `scoring.ts`,
 * `repository.ts` or `routes.ts`; the module mirrors `brief/constants.ts`.
 */

/** AC-NF-02 — per-route limit on POST /agents/:id/eval-runs; each batch is paid. */
export const EVAL_RUN_RATE_LIMIT = { max: 3, timeWindow: '1 minute' } as const;

/** AC-NF-05 — bounded case concurrency inside one batch. */
export const EVAL_CONCURRENCY = 3;

/** AC-NF-05 — per-case model-call timeout. */
export const EVAL_CASE_TIMEOUT_MS = 60_000;

/** AC-NF-05 — per-case output-token cap. */
export const EVAL_CASE_MAX_TOKENS = 2_000;

/** Dashboard "recent, capped" — most recent batches across all agents. */
export const EVAL_DASHBOARD_RECENT_CAP = 20;

/** AC-39 — hand-authored cases the seed writes for the Security Reviewer. */
export const EVAL_SEED_CASE_COUNT = 8;

/** Case name truncation at creation (`eval_cases.name` from the finding title). */
export const EVAL_CASE_NAME_MAX = 120;

/**
 * The engine's structured schema name (`reviewer-core/src/review/run.ts` calls
 * `completeStructured` with `schemaName: 'Review'`) — the key a test targets
 * through `MockLLMOptions.structuredBySchema`.
 */
export const EVAL_SCHEMA_NAME = 'Review';
