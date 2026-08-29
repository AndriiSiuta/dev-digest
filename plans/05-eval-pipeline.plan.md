# Development Plan: Eval Pipeline — regression protection for review agents

**Spec:** `specs/05-eval-pipeline.md` (Status: draft, approved for planning; Decision log closes all gaps, Open questions: none)
**AC-IDs in scope:** AC-01 … AC-40, AC-NF-01 … AC-NF-11 (51 total)
**Produced by:** `implementation-planner`, 2026-08-29
**Branch:** `feature/eval-pipeline` (already checked out; work lands here)

## Goal & scope

**In.** The loop *finding → one-click eval case → frozen input → batch run → mechanical score → comparable numbers*: `POST /findings/:id/eval-case` creating a frozen case owned by the agent whose review produced the finding; case list + delete in a new **Evals** tab of the agent editor; `POST /agents/:id/eval-runs` running the whole set **synchronously** with one model call per case and zero LLM calls for scoring; per-case result rows sharing one `batch_id`; recall / precision / citation-accuracy from raw counts; per-agent batch history and a two-batch comparison in the Evals tab; an Eval Dashboard at `/eval` linked from the sidebar; contract additions in `@devdigest/shared` (canonical first, hand-mirror second); the minimal `eval_runs` extension (`batch_id`, `agent_version`); a seed path to ≥ 8 cases; `pnpm verify:l06` at the repo root; `client/messages/en/eval.json` rewritten to the built surfaces.

**Non-goals (do not build).** Export-to-CI / `AgentManifest` / `ci_installations` / `ci_runs`; skill-owned eval sets (`owner_kind='skill'` stays contract-compatible, no route or UI targets it); any LLM-judge scoring; a manual eval-case editor; a per-case run button; a metric trend chart; conformance/compose/hooks/memory; MCP exposure; `e2e/` flows. The pre-staged `EvalRun`, `EvalPerTrace`, `EvalCaseInput`, `EvalRunResult`, `EvalTrendPoint`, `EvalDashboard` contracts stay exported and unused (the `PrBrief` precedent).

## Context consulted

| Source | What it constrained |
| --- | --- |
| `specs/05-eval-pipeline.md` | Everything: AC-IDs, the normative match rule and metric formulas, the two-column schema extension, the route set, all 12 Decision-log rulings. |
| `plans/04-pr-brief.plan.md` | House style; the contracts-first/mirror-second task shape; migration mechanics; the rate-limit `NODE_ENV` trap; the throwaway-tsconfig recipe. |
| `INSIGHTS.md` (root), 2026-07-29 + 2026-08-28 | `client/src/vendor/shared/` is a hand-copy; **`contracts/eval-ci.ts` currently lags the canonical copy** (missing `AgentManifest` + `Provider`/`CiFailOn` imports); the client typecheck is the mechanism that proves a copy complete. Forces Task 1's shape. Also: pnpm/npm split; pre-staged copy is a proposal (AC-38); `pnpm arch` does not exist. |
| `server/INSIGHTS.md` | Vacuous-baseline trap (2026-08-28) → every harness wires facades resolving to empty; rate limit inert under `NODE_ENV=test` (2026-08-29); it-tests reach real providers (2026-08-14) → Task 10 overrides all three provider ids; journal-rewrite hazard + migrations-not-on-boot (2026-08-05) → Task 2 preflight/post-check; `server/test/**` not type-checked (2026-08-17); no transactions (2026-08-05) → AC-NF-11 design; pure-mapper duplication is sanctioned (2026-08-05) → Task 4 duplicates `toSkillPromptBlock`; the facade-on-container promotion recipe (2026-08-29) → `container.eval`; optional-logger observability hole (2026-08-14) → `logger` required; `pnpm` may be absent in agent shells → local-binary equivalents (2026-08-29). |
| `client/INSIGHTS.md` | `?tab=` double whitelist + the page-level round-trip test (2026-08-29) → AC-31; `VALID_TABS` is already derived from `TABS` (`AgentEditor/constants.ts:19`), so adding a `TABS` entry updates the whitelist automatically; **no `user-event`** (2026-08-20) → all client tests use `fireEvent`; `next build` while dev runs breaks `.next/` (2026-08-29). |
| `reviewer-core/INSIGHTS.md`, Decisions 2026-07-31 | The grounding gate is mechanical and mandatory; never bypassed or edited via the server shim. |
| Source read | `reviewer-core/src/{index.ts,review/run.ts,grounding.ts}` (`ReviewInput` has no `maxTokens`/`timeoutMs` → Decision 4; no-`intent` ⇒ scope filter is a no-op ⇒ `ReviewOutcome.dropped` holds only grounding drops → AC-23); `server/src/db/schema/{eval,reviews,pulls}.ts`; `server/src/vendor/shared/contracts/{knowledge,eval-ci,findings,review-api}.ts`; `server/src/vendor/shared/adapters.ts:39-69` (`StructuredRequest` **does** take `maxTokens`/`timeoutMs`); `server/src/modules/reviews/{findings.ts,helpers.ts:19,repository.ts,repository/review.repo.ts:140,diff-loader.ts,run-executor.ts:435-462}`; `server/src/modules/agents/repository.ts` (`getById`, `enabledSkillsForPrompt`, `version`); `server/src/platform/container.ts` (overrides + getter pattern, incl. the `briefRepo` seam precedent); `server/src/adapters/mocks.ts` (`MockLLMProvider.calls`, `structuredBySchema`); `server/src/db/seed.ts` (name-keyed idempotency; `Security Reviewer` enabled built-in); `server/src/modules/index.ts`; `server/package.json` / `client/package.json` scripts (no root `package.json` exists); `client/messages/en/eval.json`; `client/src/components/app-shell/helpers.ts:35`; `client/src/vendor/ui/nav.ts` (**no eval nav item exists**; the conventions feature added its item to this vendored file in commit `641b637` — the precedent Task 16 follows); `client/src/app/agents/[id]/{page.tsx,page.test.tsx,_components/AgentEditor/}`; `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingCard/FindingCard.tsx`; `client/src/lib/{api.ts,types.ts,hooks/}`; `TESTING.md`. |
| Skills | `.claude/skills/README.md` (catalog), `postgresql-table-design/SKILL.md` (FK columns need manual indexes; `timestamptz`; JSONB guidance), `react-testing-library/SKILL.md` (fewer/longer flow tests; overridden on `fireEvent` per `client/INSIGHTS.md`). |

## Modules touched

| Module | Package manager | Typecheck | Tests |
| --- | --- | --- | --- |
| `server/` | **pnpm** | `cd server && pnpm typecheck` | `cd server && pnpm test` (hermetic + `*.it.test.ts`; it-tests self-skip without Docker) |
| `server/src/vendor/shared/` | pnpm (part of `server/`) | as above | `server/test/contracts.test.ts` |
| `client/` | **pnpm** | `cd client && pnpm typecheck` | `cd client && pnpm test` |
| repo root | — (a scripts-only `package.json`; **no install, no lockfile**) | — | `pnpm verify:l06` |
| `reviewer-core/` | — | **not touched** (Decision 4 keeps the engine API frozen) | — |
| `e2e/` | — | not touched (spec Out) | — |

In agent shells where `pnpm` is missing, use the local-binary equivalents (`server/INSIGHTS.md`, 2026-08-29): `./node_modules/.bin/tsc --noEmit -p tsconfig.json`, `./node_modules/.bin/vitest run`, `./node_modules/.bin/drizzle-kit generate`, `./node_modules/.bin/tsx src/db/migrate.ts`.

---

## Contract changes

**These land first, both copies, in one task.** Canonical: `server/src/vendor/shared/`; hand-mirror: `client/src/vendor/shared/` (no sync script; the client typecheck is what catches an incomplete copy — root `INSIGHTS.md` 2026-08-28).

In `contracts/eval-ci.ts` (canonical), all additive:

- **`EvalExpectation`** *(new)* — `z.object({ kind: z.enum(['must_find', 'must_not_flag']), file: z.string().min(1), start_line: z.number().int(), end_line: z.number().int() })`. Placed beside `EvalCaseInput` under the Eval banner; doc comment says it is the shape carried by `eval_cases.expected_output`.
- **`EvalRunRecord`** — gains three fields **in place** (nothing removed or renamed): `batch_id: z.string()`, `agent_version: z.number().int().nullable()`, `error: z.string().nullable()` (null when the case executed; the failure message when it errored).
- **`EvalBatchSummary`** *(new)* — `{ batch_id: z.string(), agent_id: z.string(), agent_version: z.number().int().nullable(), model: z.string(), ran_at: z.string(), cases_total: z.number().int(), cases_errored: z.number().int(), cases_passed: z.number().int(), recall: z.number(), precision: z.number(), citation_accuracy: z.number(), duration_ms: z.number().int(), cost_usd: z.number().nullable() }`.
- **`EvalBatchDetail`** *(new)* — `EvalBatchSummary.extend({ results: z.array(EvalRunRecord) })`.
- **`EvalDashboardView`** *(new)* — `{ cases_total: z.number().int(), recent: z.array(EvalBatchSummary.extend({ agent_name: z.string() })) }`, doc-commented "newest first, capped at `EVAL_DASHBOARD_RECENT_CAP`".

In `contracts/knowledge.ts` (canonical): **doc comment only** on `EvalCase.expected_output` — "carries an `EvalExpectation` (`eval-ci.ts`); the schema field stays `z.unknown()` deliberately". No schema edit.

Left alone deliberately: `EvalRun`, `EvalPerTrace`, `EvalCaseInput`, `EvalRunResult`, `EvalTrendPoint`, `EvalDashboard`, and `contracts/platform.ts` (`FeatureModelId` keeps its five members — AC-NF-04).

**Mirror:** the client's `contracts/eval-ci.ts` **lags** the canonical file (whole `AgentManifest` block + imports). The mirror step copies the *entire* canonical `eval-ci.ts` byte-for-byte — closing that lag is part of this change, exactly as the spec's Contract-changes section states — plus the `knowledge.ts` doc comment. `adapters.ts` and `contracts/productionize.ts` stay unsynced (OpenRouter/CI-runner gap, out of scope here).

The `vendor/shared/index.ts` barrels on both sides already re-export `./contracts/eval-ci.js` and `./contracts/knowledge.js`; no barrel edit.

---

## Design decisions this plan makes (where the spec delegated)

**Decision 1 — one new `eval` module owns all seven routes, including `POST /findings/:id/eval-case`.** The reviews module already owns `/findings/:id/(accept|dismiss)`, but the eval-case route's writes land entirely in eval-owned tables, and everything it needs from other domains is on the container already: `container.reviewRepo.findingContext(findingId)` (finding + review + pull, `repository/review.repo.ts:140`), `container.reviewRepo.getPrFiles(prId)` (the `patch` column), `container.agentsRepo.getById` / `.enabledSkillsForPrompt`. No new facade, no cross-module internal import, no change to the reviews module. The path is the contract; module plugins are not path-prefixed (the reviews module already declares `/findings/...` paths).

**Decision 2 — `EvalFacade` on the container, plus an `evalRepo` override seam.** A module whose routes construct their own service has no test seam (`server/INSIGHTS.md`, 2026-08-29). `eval/types.ts` declares `EvalFacade`; `EvalService implements EvalFacade`; `platform/container.ts` gains `ContainerOverrides.eval` + `ContainerOverrides.evalRepo` (the `briefRepo` precedent — AC-NF-11's "insert throws after k rows" needs a recording/throwing repository double) and lazy `get eval()` / `get evalRepo()` getters. The service also holds the per-agent in-flight lock (AC-29) as a private `Set<string>` — safe because the getter memoizes one instance per app, and the trigger is synchronous in one process by spec decision 4.

**Decision 3 — where the extra per-row facts live: a module-defined `EvalCaseOutcome` inside `actual_output`, not new columns.** The spec's schema section allows exactly two new columns (`batch_id`, `agent_version`), yet the batch aggregates must be derivable from rows (no batch table) and `EvalRunRecord.error` must persist. `eval/types.ts` declares a zod `EvalCaseOutcome = { model: string, expectation_kind: 'must_find'|'must_not_flag', proposed: int, surviving: int, noise: int, matched: boolean, error: string | null, findings: Finding[] }` written into the `actual_output` jsonb; the repository parses it on read (garbage → a parse error, not a malformed response) and maps `error` / batch aggregates from it. It is deliberately **not** a wire contract — on the wire `actual_output` stays `z.unknown()` inside `EvalRunRecord`. Rejected: an `error` column (contradicts the spec's "one minimal extension" list) and computing metrics only at write time (there is nowhere to store them without a batch table).

**Decision 4 — per-call bounds via an LLM decorator, not an engine change.** `ReviewInput` has no `maxTokens`/`timeoutMs`, and widening `reviewer-core`'s public API for one consumer was rejected for the brief and is rejected again (engine purity, `onion-architecture` Core Principle 4). `eval/helpers.ts` exports `withCallLimits(llm, { maxTokens, timeoutMs }): LLMProvider` — a pure decorator that injects `maxTokens: EVAL_CASE_MAX_TOKENS` and `timeoutMs: EVAL_CASE_TIMEOUT_MS` into every `completeStructured`/`complete` request and delegates everything else. `StructuredRequest` carries both fields (`vendor/shared/adapters.ts:61-62`), so AC-NF-05's "call options" half is assertable on the mock's recorded request. Concurrency ≤ 3 comes from a ~12-line pure `mapWithConcurrency(items, limit, fn)` in the same file — no new dependency.

**Decision 5 — the frozen diff is the verbatim `pr_files.patch`, wrapped deterministically at execution.** `input_diff` stores the patch text exactly as persisted (the spec's literal wording). At execution, a pure `caseDiff(file, patch): UnifiedDiff` prepends the same three header lines `diffFromPrFiles` uses (`diff --git a/<f> b/<f>`, `--- a/<f>`, `+++ b/<f>`, `server/src/modules/reviews/diff-loader.ts:33-43`) and parses with `parseUnifiedDiff` (a pure function under `adapters/` that services legitimately import — `server/INSIGHTS.md` 2026-08-05). Same input → same `UnifiedDiff` → same prompt bytes on every run (AC-04), and the grounding gate gets a real line index (the spec's "must be groundable" constraint).

**Decision 6 — one call per case is forced structurally.** `reviewPullRequest` is called with `strategy: 'single-pass'` explicitly (a one-file diff would resolve to single-pass anyway, but the explicit value keeps AC-17 independent of the agent's own `strategy` setting), with `sessionId: batchId` so a batch groups as one provider session. No `intent`, `callers`, `repoMap`, `specs`, or `memory` is ever passed (AC-15, Decision-log 2) — which also makes the scope filter a no-op, so `ReviewOutcome.dropped` contains **only** grounding drops and AC-23's "only grounding-gate drops count" falls out of the wiring rather than needing to un-merge `run.ts:230`'s combined list.

**Decision 7 — skill blocks: duplicate the 3-line mapper.** `toSkillPromptBlock` lives in `modules/reviews/helpers.ts:19`, banned cross-module. Per the sanctioned-duplication rule (`server/INSIGHTS.md` 2026-08-05), `eval/helpers.ts` declares its own `toSkillPromptBlock(skill) => \`### ${name}\n${body.trim()}\`` with a comment naming the duplication and the rule. Skill blocks are resolved **once per batch** (not per case) so every case in a batch sees identical prompt inputs.

**Decision 8 — indexes:** `eval_cases_owner_idx (owner_kind, owner_id)` (an agent's case list — the hot read the spec names), `eval_runs_case_idx (case_id)` (FK: batch-detail join and the cascade delete path — Postgres does not index FKs), `eval_runs_batch_idx (batch_id)` (a batch's rows / grouping for history). No index on `eval_cases.workspace_id` — the dashboard count is a rare, small scan and every other read reaches cases through `owner_id`.

**Decision 9 — refusal codes (AC-05..08), all via `AppError` from `platform/errors.ts`, mapped by the shared error handler:** undecided finding → `AppError('finding_undecided', …, 409)`; duplicate → `AppError('eval_case_exists', message naming the existing case id, 409, { existing_case_id })` (AC-06's "identify the existing case"); no stored patch → `AppError('no_diff_fragment', …, 422)` (the "distinct error" AC-07 demands); unresolvable agent → `NotFoundError('Agent for this finding no longer exists')`. Empty case set → `AppError('no_eval_cases', …, 409)`; concurrent trigger → `AppError('eval_run_in_flight', …, 409)`.

**Decision 10 — `verify:l06` is a scripts-only, private root `package.json` using `pnpm -C`.** AC-40 names only the server and client lanes, and both are pnpm packages, so `pnpm -C <dir>` invokes each package with its own package manager and its own lockfile; no dependencies, no install, no `pnpm-workspace.yaml`, no root lockfile is ever created (AC-NF-09). Rejected: a shell script in `scripts/` (does not satisfy the literal `pnpm verify:l06` command Decision-log 10 fixes) and a workspace (explicitly forbidden).

**Decision 11 — the sidebar item goes into `client/src/vendor/ui/nav.ts`.** The nav item list lives in vendored `@devdigest/ui`, and the Conventions feature already edited exactly this file for exactly this purpose (commit `641b637`). `activeKeyFor("/eval")` is pre-staged (`app-shell/helpers.ts:35`), so adding `{ key: "eval", … }` lights up active-state for free. Recorded as a deliberate, precedent-backed exception to "do not touch `vendor/ui`".

**Decision 12 — batch aggregates are computed in TypeScript from the batch's rows** (a pure `batchMetrics(outcomes)` in `eval/scoring.ts`), not in SQL. The tables are lesson-scale, the formulas are the feature's spec-audited core (AC-21..24), and one pure function is unit-testable with no mocks; the repository returns rows, the service groups and maps. Per-row columns `recall`/`precision` stay `NULL` (they are batch metrics; the row records `pass`, its own `citation_accuracy`, `duration_ms`, `cost_usd` — AC-25).

---

## Tasks

### Task 1 — `@devdigest/shared`: eval contracts, both copies

- **Module:** `server/` (canonical) + `client/` (hand-mirror), pnpm both.
- **Files:** `server/src/vendor/shared/contracts/eval-ci.ts` (edit `EvalRunRecord` in place + append the four new schemas under the Eval banner); `server/src/vendor/shared/contracts/knowledge.ts` (doc comment on `EvalCase.expected_output` only); `client/src/vendor/shared/contracts/eval-ci.ts` (**replace with the full canonical file** — this also closes the pre-existing `AgentManifest` lag); `client/src/vendor/shared/contracts/knowledge.ts` (mirror the comment); `client/src/lib/types.ts` (re-export `EvalCase`, `EvalOwnerKind`, `EvalExpectation`, `EvalRunRecord`, `EvalBatchSummary`, `EvalBatchDetail`, `EvalDashboardView` beside the existing `@devdigest/shared` re-exports); `server/test/contracts.test.ts` (extend).
- **Do:** exactly the shapes in **Contract changes**. Nothing existing is removed or renamed; `contracts/platform.ts` is untouched.
- **Then, same task:** `diff server/src/vendor/shared/contracts/eval-ci.ts client/src/vendor/shared/contracts/eval-ci.ts` and the same for `knowledge.ts` must both be empty; `cd client && pnpm typecheck` (or `./node_modules/.bin/tsc --noEmit`) must pass — the only mechanism that catches an incomplete hand-copy.
- **covers:** [AC-26, AC-27, AC-33, AC-34, AC-35, AC-36, AC-NF-08]
- **skills:** [zod, onion-architecture]
- **Tests:** extend `server/test/contracts.test.ts` (hermetic): a fully-populated `EvalBatchDetail` fixture parses; an `EvalExpectation` with `kind: 'maybe_find'` fails; an `EvalRunRecord` without `batch_id` fails; the pre-staged `EvalRun`/`EvalDashboard` still parse their original shapes (the left-alone guarantee).
- **Verify:** `cd server && pnpm typecheck && pnpm test -- contracts` · both `diff`s empty · `cd client && pnpm typecheck`

### Task 2 — `eval_runs` gains `batch_id` + `agent_version`; indexes

- **Module:** `server/` (pnpm). **Depends on:** nothing.
- **Files:** `server/src/db/schema/eval.ts`; a generated `server/src/db/migrations/00NN_*.sql` + snapshot + `meta/_journal.json`.
- **Do:** extend `evalRuns` in place — never edit an existing migration:
  ```ts
  export const evalRuns = pgTable('eval_runs', {
    ...existing columns unchanged...,
    /** Groups the case-result rows written by one POST /agents/:id/eval-runs.
     *  NOT NULL with no backfill: lesson-staged table, empty in every deployment. */
    batchId: uuid('batch_id').notNull(),
    /** agents.version at trigger time — labels history/comparison ("v3 vs v5"). */
    agentVersion: integer('agent_version'),
  }, (t) => ({
    caseIdx: index('eval_runs_case_idx').on(t.caseId),
    batchIdx: index('eval_runs_batch_idx').on(t.batchId),
  }));
  ```
  and add `(t) => ({ ownerIdx: index('eval_cases_owner_idx').on(t.ownerKind, t.ownerId) })` to `evalCases`. `timestamptz` and `doublePrecision` are already right in the staged table; do not touch existing columns.
- **Migration mechanics:** (1) preflight `cd server && git status --porcelain src/db/migrations` clean — `db:generate` on a diverged journal **rewrites** committed history (`server/INSIGHTS.md` 2026-08-05); (2) `pnpm db:generate` (add-only → no interactive rename prompt; if one appears, stop and re-read the 2026-08-05 entry); (3) post-check: `git diff src/db/migrations/meta/_journal.json` shows exactly **one appended** entry and zero modifications to earlier entries; (4) `pnpm db:migrate` — migrations do not run on boot, and skipping this leaves the dev DB failing at request time while typecheck and both test lanes stay green.
- **covers:** [AC-14, AC-26]
- **skills:** [drizzle-orm-patterns, postgresql-table-design]
- **Tests:** none of its own; exercised by Task 10's it-tests.
- **Verify:** `cd server && pnpm typecheck` · `pnpm db:migrate` ends `✓ migrations applied` (raw `NOTICE` lines about the `vector` extension are idempotent skips)

### Task 3 — `eval` module skeleton: `constants.ts` + `types.ts`

- **Module:** `server/` (pnpm). **Depends on:** Task 1.
- **Files:** new `server/src/modules/eval/constants.ts`, `server/src/modules/eval/types.ts`.
- **Do:** `constants.ts` holds **every** threshold, none inline anywhere (AC-NF-10), each annotated with its AC:
  ```
  EVAL_RUN_RATE_LIMIT     = { max: 3, timeWindow: '1 minute' } as const  // AC-NF-02
  EVAL_CONCURRENCY        = 3        // AC-NF-05 — bounded case concurrency
  EVAL_CASE_TIMEOUT_MS    = 60_000   // AC-NF-05 — per-case model-call timeout
  EVAL_CASE_MAX_TOKENS    = 2_000    // AC-NF-05 — per-case output-token cap
  EVAL_DASHBOARD_RECENT_CAP = 20     // dashboard "recent, capped"
  EVAL_SEED_CASE_COUNT    = 8        // AC-39
  EVAL_CASE_NAME_MAX      = 120      // case name truncation at creation
  EVAL_SCHEMA_NAME        = 'Review' // the engine's structured schema name (MockLLM keying)
  ```
  `types.ts` declares:
  - `EvalFacade` — `createCaseFromFinding(workspaceId, findingId): Promise<EvalCase>`; `listCases(workspaceId, agentId): Promise<EvalCase[]>`; `deleteCase(workspaceId, caseId): Promise<void>`; `runBatch(workspaceId, agentId, opts: { logger: PinoLike; correlationId?: string }): Promise<EvalBatchDetail>`; `listBatches(workspaceId, agentId): Promise<EvalBatchSummary[]>`; `getBatch(workspaceId, agentId, batchId): Promise<EvalBatchDetail>`; `dashboard(workspaceId): Promise<EvalDashboardView>`. **`logger` is required, not optional** — AC-NF-07 is a SHALL, and an optional logger some caller omits is the silent observability hole that bit the intent classifier (`server/INSIGHTS.md` 2026-08-14).
  - `EvalCaseOutcome` — the zod schema for `actual_output` (Decision 3), plus `EvalCaseMeta` — a zod schema for `input_meta` (`{ pr_title: string, pr_body: string | null, repo: string, pr_number: number, source_finding_id: string }`), both parsed at the repository boundary.
- **covers:** [AC-NF-02, AC-NF-05, AC-NF-10]
- **skills:** [onion-architecture, typescript-expert, zod]
- **Tests:** none of its own; the constants are asserted through Tasks 4, 7, 9.
- **Verify:** `cd server && pnpm typecheck`

### Task 4 — pure core: `eval/helpers.ts` + `eval/scoring.ts`

- **Module:** `server/` (pnpm). **Depends on:** Tasks 1, 3.
- **Files:** new `server/src/modules/eval/helpers.ts`, `server/src/modules/eval/scoring.ts`; new `server/test/eval-scoring.test.ts`.
- **Do:** no I/O, no container, no `process.env` — pure functions only.
  - `helpers.ts`: `caseDiff(file, patch): UnifiedDiff` (Decision 5, header recipe from `diff-loader.ts:33-43`, parse via `parseUnifiedDiff`); `toSkillPromptBlock` (Decision 7 duplication, commented); `withCallLimits(llm, { maxTokens, timeoutMs }): LLMProvider` (Decision 4); `mapWithConcurrency<T, R>(items, limit, fn): Promise<R[]>` (Decision 4); `toEvalCaseDto(row): EvalCase` (Drizzle rows stop at the module edge).
  - `scoring.ts`, stated against the spec's normative definitions:
    - `matches(finding: { file, start_line, end_line }, exp: EvalExpectation): boolean` — files equal **and** `[start_line, end_line]` ranges overlap (inclusive); severity/category/title never read — the function signature simply cannot see them (AC-18 structurally).
    - `caseVerdict(exp, surviving: Finding[]): { pass: boolean; matched: number }` — `must_find`: pass iff ≥ 1 match; `must_not_flag`: pass iff 0 matches (AC-19, AC-20).
    - `caseCitation(surviving: number, proposed: number): number` — `proposed === 0 ? 1 : surviving / proposed`.
    - `batchMetrics(outcomes: EvalCaseOutcome[] /* incl. errored */): { recall, precision, citation_accuracy, cases_total, cases_errored, cases_passed }` — errored outcomes excluded from **every** denominator (AC-27); recall = passed must_find ÷ total must_find, 1.0 on zero denominator; precision = `1 − (Σ noise ÷ Σ surviving)`, 1.0 when Σ surviving = 0; citation = `Σ surviving ÷ Σ proposed`, 1.0 when Σ proposed = 0 — **raw counts across the batch, never a mean of per-case values** (AC-21..24, Decision-log 5/6/7).
- **covers:** [AC-18, AC-19, AC-20, AC-21, AC-22, AC-23, AC-24, AC-NF-05]
- **skills:** [onion-architecture, typescript-expert, zod]
- **Tests:** `server/test/eval-scoring.test.ts`, hermetic, **no mocks**: overlap at exactly one shared line matches; adjacency (`end_line + 1`) does not; other-file does not; a severity/category/title mismatch on an overlapping range **still matches** (AC-18); the two verdict rules incl. the empty-surviving cases (AC-19, AC-20); recall/precision/citation on hand-computed fixtures incl. every vacuous-denominator case (AC-21..23); **a two-case fixture where the mean of per-case citation values differs from the raw-count ratio (e.g. 1/1 and 5/10 → raw 6/11 ≈ 0.545 vs mean 0.75) asserting the raw-count answer** (AC-24); an errored outcome changes no metric but increments `cases_errored`; `withCallLimits` injects `maxTokens: 2000, timeoutMs: 60000` into a recorded request; `mapWithConcurrency` never exceeds 3 in flight (in-flight counter fixture); `caseDiff` output makes `groundFindings` accept a citation inside the fragment and drop one outside it.
- **Verify:** `cd server && pnpm typecheck && pnpm test -- eval-scoring`

### Task 5 — `eval/repository.ts`

- **Module:** `server/` (pnpm). **Depends on:** Tasks 1, 2, 3.
- **Files:** new `server/src/modules/eval/repository.ts`.
- **Do:** the only code touching `eval_cases` / `eval_runs` (module owns its tables — promotion-ladder stage 3). Domain-shaped methods:
  - `insertCase(values): Promise<EvalCaseRow>`; `listCases(workspaceId, ownerKind, ownerId)`; `getCase(workspaceId, caseId)`; `findCaseBySourceFinding(workspaceId, findingId)` — `where(sql\`input_meta->>'source_finding_id' = ...\`)` scoped to the workspace (AC-06's duplicate check); `deleteCase(caseId)` — a plain delete; the `ON DELETE CASCADE` on `eval_runs.case_id` (`schema/eval.ts:24-26`) removes the result rows (AC-09).
  - `insertRun(values): Promise<void>` — one row per completed/errored case, called **as each case finishes**, never batched at the end (the write-as-you-go design AC-NF-11 rests on; nothing runs in a transaction and none is wanted here).
  - `runsForBatch(workspaceId, batchId)` and `runsForAgent(workspaceId, agentId)` — join `eval_runs → eval_cases` (for `case_name`, owner scoping, and the workspace filter: **workspace scoping always rides the `eval_cases.workspace_id` join**, AC-NF-01); `recentRuns(workspaceId, cap)` joins onward to `agents` for `agent_name`; `countCases(workspaceId)`.
  - Rows are parsed at this boundary: `EvalCaseOutcome.parse(row.actualOutput)`, `EvalCaseMeta.parse(row.inputMeta)`, `EvalExpectation.parse(row.expectedOutput)` — Drizzle types stop here.
- **covers:** [AC-06, AC-09, AC-34, AC-36, AC-NF-01]
- **skills:** [drizzle-orm-patterns, onion-architecture, postgresql-table-design, zod]
- **Tests:** none of its own; completed by Task 10's it-tests (never mock the database).
- **Verify:** `cd server && pnpm typecheck`

### Task 6 — `eval/service.ts` part 1: case creation, list, delete; `container.eval`

- **Module:** `server/` (pnpm). **Depends on:** Tasks 3, 4, 5.
- **Files:** new `server/src/modules/eval/service.ts`; `server/src/platform/container.ts`; new `server/test/helpers/eval.ts`; new `server/test/eval-cases.test.ts`.
- **Do:** `export class EvalService implements EvalFacade { constructor(private container: Container) {} }` (whole-`Container` matches the house pattern; the service touches `reviewRepo`, `agentsRepo`, `evalRepo`, `llm` — recorded trade-off, same as `BriefService`).

  `createCaseFromFinding(workspaceId, findingId)`:
  1. `ctx = await reviewRepo.findingContext(findingId)`; miss or `ctx.pull.workspaceId !== workspaceId` → `NotFoundError('Finding not found')` (tenancy, AC-NF-01's service half).
  2. Label from the decision: `acceptedAt` → `must_find`; `dismissedAt` → `must_not_flag`; **neither → `finding_undecided` 409, nothing created** (AC-05). (`setFindingAccepted` nulls `dismissedAt` and vice versa, so both-set cannot occur.)
  3. Duplicate: `evalRepo.findCaseBySourceFinding(workspaceId, findingId)` → `eval_case_exists` 409 with `{ existing_case_id }`, nothing created (AC-06).
  4. Agent: `ctx.review.agentId` null, or `agentsRepo.getById(workspaceId, agentId)` miss → `NotFoundError('Agent for this finding no longer exists')`, nothing created (AC-08).
  5. Patch: `(await reviewRepo.getPrFiles(ctx.pull.id)).find(f => f.path === finding.file)?.patch`; null/absent → `no_diff_fragment` 422, nothing created (AC-07 — `pr_files.patch` is nullable, `schema/pulls.ts:44`).
  6. Insert: `owner_kind: 'agent'`, `owner_id: agentId`, `name: finding.title.slice(0, EVAL_CASE_NAME_MAX)`, `input_diff: patch` **verbatim**, `input_files: [finding.file]`, `input_meta: { pr_title: pull.title, pr_body: pull.body, repo: '<owner>/<name>' via reposRepo or pull display fields, pr_number: pull.number, source_finding_id: findingId }`, `expected_output: { kind, file: finding.file, start_line: finding.startLine, end_line: finding.endLine }` (AC-01, AC-02, AC-03). Return the `EvalCase` DTO.

  `listCases(workspaceId, agentId)` → DTO list. `deleteCase(workspaceId, caseId)` → `getCase` for tenancy (miss → `NotFoundError`), then delete.

  Container: `import type { EvalFacade }`, `import { EvalService }`, `import { EvalRepository }`; add `eval?: EvalFacade` and `evalRepo?: EvalRepository` to `ContainerOverrides`; lazy getters `get eval()` / `get evalRepo()` (the `brief`/`briefRepo` pattern at `container.ts:236-256`).

  `server/test/helpers/eval.ts` — hermetic harness in the `test/helpers/run-executor.ts` shape (object-literal container cast through `never`; `Container` has private fields compared nominally, `server/INSIGHTS.md` 2026-08-17). **Every dependency wired and resolving to empty, never absent** (the vacuous-baseline trap, 2026-08-28): fake `reviewRepo` (`findingContext`, `getPrFiles`, plus recording `insertReview`/`insertFindings` spies for Task 7), fake `agentsRepo` (`getById`, `enabledSkillsForPrompt` → `[]` by default), a recording in-memory `evalRepo` double, `llm` → `MockLLMProvider` keyed `structuredBySchema['Review']`, a wired `MockGitHubClient`, a capturing logger.
- **covers:** [AC-01, AC-02, AC-03, AC-05, AC-06, AC-07, AC-08]
- **skills:** [onion-architecture, zod, drizzle-orm-patterns]
- **Tests:** `server/test/eval-cases.test.ts`: accepted finding → case with `must_find` + the finding's file/range, owned by the review's agent (AC-01); dismissed → `must_not_flag` (AC-02); the created case's `input_diff` is byte-equal to the fixture's `pr_files.patch`, `input_meta` carries the PR title/body and `source_finding_id` (AC-03); undecided → 409 `finding_undecided` and the repo double recorded **zero** inserts (AC-05); second creation for the same finding → 409 `eval_case_exists` whose details name the first case's id (AC-06); fixture file with `patch = null` → 422 `no_diff_fragment`, nothing created (AC-07); `agentId: null` and unknown-agent both refuse, nothing created (AC-08); a finding in another workspace → `NotFoundError`.
- **Verify:** `cd server && pnpm typecheck && pnpm test -- eval-cases`

### Task 7 — `eval/service.ts` part 2: the batch executor

- **Module:** `server/` (pnpm). **Depends on:** Tasks 4, 5, 6.
- **Files:** `server/src/modules/eval/service.ts`; new `server/test/eval-run.test.ts`.
- **Do:** `runBatch(workspaceId, agentId, { logger, correlationId })`:
  1. `agent = agentsRepo.getById(workspaceId, agentId)` → `NotFoundError` on miss.
  2. `cases = evalRepo.listCases(workspaceId, 'agent', agentId)`; empty → `no_eval_cases` 409, **before** any provider is resolved (AC-28).
  3. In-flight lock: `if (this.inFlight.has(agentId)) throw AppError('eval_run_in_flight', …, 409)`; `this.inFlight.add(agentId)`; whole body in `try/finally` with `this.inFlight.delete(agentId)` (AC-29).
  4. `batchId = randomUUID()`; `blocks = (await agentsRepo.enabledSkillsForPrompt(agentId)).map(toSkillPromptBlock)` — once per batch; `llm = withCallLimits(this.container.llm(agent.provider), { maxTokens: EVAL_CASE_MAX_TOKENS, timeoutMs: EVAL_CASE_TIMEOUT_MS })` — **the agent's own provider and model, never `resolveFeatureModel`** (AC-NF-04).
  5. `await mapWithConcurrency(cases, EVAL_CONCURRENCY, executeCase)` where `executeCase(c)`:
     - parse `EvalExpectation` + `EvalCaseMeta` from the case; `diff = caseDiff(exp.file, c.input_diff)`;
     - `outcome = await reviewPullRequest({ systemPrompt: agent.systemPrompt, model: agent.model, diff, llm, strategy: 'single-pass', ...(blocks.length ? { skills: blocks } : {}), prDescription: meta.pr_body ?? undefined, task: \`Review PR: ${meta.pr_title}\`, sessionId: batchId })` — no `intent`/`callers`/`repoMap`/`specs`/`memory`, ever (AC-15; grounding applied inside the engine, AC-16; one structured call, AC-17; Decision 6);
     - score with `scoring.ts`: `surviving = outcome.review.findings`, `proposed = surviving.length + outcome.dropped.length` (all drops are grounding drops — Decision 6), `noise` = matches against a `must_not_flag` case's own expectation, `{ pass } = caseVerdict(exp, surviving)`;
     - `evalRepo.insertRun({ caseId, batchId, agentVersion: agent.version, pass, citationAccuracy, durationMs, costUsd: outcome.costUsd, actualOutput: EvalCaseOutcome })` — **written immediately** (AC-14, AC-25, AC-NF-11);
     - `catch (err)`: `insertRun({ caseId, batchId, agentVersion: agent.version, pass: null, citationAccuracy: null, durationMs, costUsd: null, actualOutput: { model: agent.model, expectation_kind, proposed: 0, surviving: 0, noise: 0, matched: false, error: message, findings: [] } })` and **return normally** so the remaining cases run (AC-27).
  6. Assemble `EvalBatchDetail` from the in-memory outcomes via `batchMetrics` (same mapping `getBatch` uses); `duration_ms` = Σ row durations, `cost_usd` = null-propagating sum, `ran_at` = trigger time.
  7. Emit **one** structured line `logger.info({ batch_id, agent_id, agent_version, model, cases_total, cases_errored, cases_passed, recall, precision, citation_accuracy, cost_usd, duration_ms, correlationId }, 'eval: batch completed')` (AC-NF-07). **Identifiers, counts, metrics and sizes only — never diff text, PR bodies, prompt or model output** (AC-NF-06); nothing else in this module logs content either.

  The executor touches no `reviews`/`findings`/`agent_runs` writer and never resolves `container.github()` (AC-30 — structural: no import, no call site).
- **covers:** [AC-04, AC-14, AC-15, AC-16, AC-17, AC-19, AC-20, AC-21, AC-22, AC-23, AC-25, AC-26, AC-27, AC-28, AC-29, AC-30, AC-NF-04, AC-NF-05, AC-NF-06, AC-NF-07, AC-NF-11]
- **skills:** [onion-architecture, zod, typescript-expert]
- **Tests:** `server/test/eval-run.test.ts` on the Task 6 harness. Assert: a 3-case batch persists exactly 3 rows sharing one fresh `batch_id`, all with `agentVersion === agent.version` (AC-14, AC-26 server half); the captured `completeStructured` messages contain the fixture skill body and the frozen diff fragment, and **no** `## Derived intent`, blast, project-context or repo-map section (AC-15); a stubbed `Review` fixture citing a line outside the fragment yields `surviving: 0`, `pass: false` for a `must_find` case (AC-16); `llm.calls.filter(c => c.method === 'completeStructured').length === cases_total` and no other method was called (AC-17); recall/precision/citation on a mixed fixture match hand-computed raw-count values end-to-end (AC-21..23 at the service ring); each row records pass, its own citation accuracy, duration and cost (AC-25); **mutate the fake PR's title/body and `pr_files.patch` after case creation, run two batches, and assert the two captured message arrays are byte-identical** (AC-04); an injected per-case provider error (hand-rolled `LLMProvider` that throws on call #2) leaves the other rows written, the errored row carrying its message in `actual_output`, every metric denominator excluding it, and `cases_errored: 1` on the returned batch (AC-27); empty case set → 409 with `llm.calls` empty (AC-28); two concurrent `runBatch` calls (`Promise.all`, with the provider gated on a deferred so the first is genuinely in flight) → second rejects `eval_run_in_flight` and `llm.calls` grew only by the first batch's count — and after both settle, a third call **succeeds**, proving the `finally` released the lock (AC-29); the recording `reviewRepo` spies (`insertReview`, `insertFindings`) and the **wired** `MockGitHubClient` were never called — present-and-empty, not absent (AC-30, the vacuous-baseline trap); every recorded structured request carries `maxTokens: 2000` and `timeoutMs: 60000`, and the mock's in-flight counter never exceeded 3 on an 8-case batch (AC-NF-05); `req.model === agent.model` on every call plus a pin asserting `FeatureModelId` still has exactly its five members (AC-NF-04); an `evalRepo` double whose `insertRun` throws on the (k+1)th call aborts the batch leaving exactly k rows, each parsing against `EvalCaseOutcome` — the crash-mid-batch shape, no reaper needed (AC-NF-11); the captured log lines contain the batch line with agent, version, counts, three metrics, cost and duration (AC-NF-07) and — asserted over **all** captured lines — no fixture diff sentinel, PR body text or prompt content (AC-NF-06).
- **Verify:** `cd server && pnpm typecheck && pnpm test -- eval-run`

### Task 8 — `eval/service.ts` part 3: history, batch detail, dashboard

- **Module:** `server/` (pnpm). **Depends on:** Tasks 5, 7.
- **Files:** `server/src/modules/eval/service.ts`; extend `server/test/eval-run.test.ts` (or a small `eval-reads` describe block in it).
- **Do:** `listBatches(workspaceId, agentId)` — `runsForAgent` rows grouped by `batch_id` in TypeScript (Decision 12), each group mapped through `batchMetrics` to `EvalBatchSummary` (`model` from the rows' `EvalCaseOutcome.model`, `agent_version` from the column, `ran_at` = earliest row), sorted newest first. `getBatch(workspaceId, agentId, batchId)` — `runsForBatch` (empty → `NotFoundError`), summary + `results: EvalRunRecord[]` each carrying `case_id`, `case_name` and `error` mapped from the stored outcome (what lets the client align two batches case-by-case, AC-35). `dashboard(workspaceId)` — `{ cases_total: countCases(workspaceId), recent: recentRuns(workspaceId, EVAL_DASHBOARD_RECENT_CAP) }` grouped the same way, `agent_name` from the join, newest first, capped.
- **covers:** [AC-26, AC-34, AC-35, AC-36, AC-37]
- **skills:** [onion-architecture, zod]
- **Tests:** in the same file: two seeded batches come back newest-first with distinct `agent_version`/`model` labels (AC-26, AC-34 server half); `getBatch` results carry `case_id` + `case_name` for every row incl. errored ones (AC-35 server half); `dashboard` on an empty `eval_runs` returns `{ cases_total: N, recent: [] }` — an empty state, not a throw (AC-37 server half); the recent list is capped and carries `agent_name` (AC-36 server half).
- **Verify:** `cd server && pnpm typecheck && pnpm test -- eval-run`

### Task 9 — `eval/routes.ts` + module registration

- **Module:** `server/` (pnpm). **Depends on:** Tasks 1, 6, 7, 8.
- **Files:** new `server/src/modules/eval/routes.ts`; `server/src/modules/index.ts`; new `server/test/eval-routes.test.ts`.
- **Do:** mirror `intent/routes.ts` / `brief/routes.ts`: every route resolves tenancy via `getContext(app.container, req)`, delegates to `app.container.eval`, and declares Zod `params` **and `schema.response`** (the output allowlist — AC-NF-03):
  ```
  POST   /findings/:id/eval-case          { params: IdParams, response: { 201: EvalCase } }        → 201
  GET    /agents/:id/eval-cases           { params: IdParams, response: { 200: z.array(EvalCase) } }
  DELETE /eval-cases/:id                  { params: IdParams, response: <mirror DELETE /agents/:id's shape> }
  POST   /agents/:id/eval-runs            { params: IdParams, response: { 200: EvalBatchDetail } }
                                          config: { rateLimit: EVAL_RUN_RATE_LIMIT }               // AC-NF-02
  GET    /agents/:id/eval-runs            { params: IdParams, response: { 200: z.array(EvalBatchSummary) } }
  GET    /agents/:id/eval-runs/:batchId   { params: z.object({ id: uuid, batchId: uuid }), response: { 200: EvalBatchDetail } }
  GET    /eval/dashboard                  { response: { 200: EvalDashboardView } }
  ```
  `POST /agents/:id/eval-runs` passes `req.log` / `req.id` as the required logger / correlation id. Handlers parse → resolve context → delegate → map; no queries, no hand-built error bodies (errors are thrown `AppError`s, mapped by the shared handler in `app.ts`).

  **Registration is its own line item:** `import evalRoutes from './eval/routes.js';` (**not** `import eval` — `eval` is a reserved identifier in strict mode) and an `eval: evalRoutes,` entry in the `modules` record of `server/src/modules/index.ts`.
- **covers:** [AC-13 (server half: one request → one deterministic outcome envelope), AC-NF-01, AC-NF-02, AC-NF-03]
- **skills:** [fastify-best-practices, zod, onion-architecture]
- **Tests:** `server/test/eval-routes.test.ts`, hermetic, via `buildApp({ config, overrides: { auth: new MockAuthProvider(), eval: fakeFacade } })` (the `routes-smoke` pattern; `MockAuthProvider` because `LocalNoAuthProvider` hits the DB). Assert: a 201 body parses as `EvalCase`; a facade returning an extra field has it **stripped** from the wire body on `GET /agents/:id/eval-cases` and `GET /eval/dashboard` (AC-NF-03); facade `AppError('eval_case_exists', …, 409, { existing_case_id })` surfaces as a 409 envelope carrying that code (AC-13's "already existing" signal); invalid uuid `:id` → 422; facade `NotFoundError` → 404. **AC-NF-02 needs its own app build** — the rate-limit plugin is inert under `NODE_ENV=test` (`server/INSIGHTS.md` 2026-08-29): build one case with `loadConfig({ ...process.env, NODE_ENV: 'development', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv)` (the `silent` level is load-bearing), a stub `eval` facade, then inject 4 `POST /agents/:id/eval-runs` and expect the 4th to be 429.
- **Verify:** `cd server && pnpm typecheck && pnpm test -- eval-routes` · `cd server && ./node_modules/.bin/depcruise --config .dependency-cruiser.cjs src` reports zero violations (**not** `pnpm arch` — the script does not exist on `main`)

### Task 10 — DB-backed integration tests (`eval.it.test.ts`)

- **Module:** `server/` (pnpm). **Depends on:** Tasks 2, 5, 6, 7, 9.
- **Files:** new `server/test/eval.it.test.ts`.
- **Do:** model on `server/test/blast.it.test.ts` / `brief.it.test.ts`: `startPg()` + docker gate, `buildApp` over real Drizzle, real `workspaces`/`repos`/`pull_requests`/`pr_files`/`reviews`/`findings`/`agents` fixtures. **Override every LLM provider id** (`llm: { openai, anthropic, openrouter }`) — an it-test that triggers a batch otherwise reaches a real provider on any machine with keys in `~/.devdigest/secrets.json` (`server/INSIGHTS.md` 2026-08-14). Cases:
  - `POST /findings/:id/eval-case` on an accepted fixture finding → one `eval_cases` row whose `input_diff` equals the fixture patch.
  - Trigger a batch, then `DELETE /eval-cases/:id` → the case's `eval_runs` rows are gone via the existing `ON DELETE CASCADE` (AC-09 — this test completes it).
  - Batch rows round-trip: `select … where batch_id = …` returns `cases_total` rows, each with `agent_version` set.
  - Cross-workspace: create a second workspace; its context 404s on the case, the batch history, the batch detail, and eval-case creation for the first workspace's finding; its dashboard shows `cases_total: 0` (AC-NF-01 — completes it).
- **covers:** [AC-09, AC-14, AC-NF-01]
- **skills:** [drizzle-orm-patterns, fastify-best-practices, postgresql-table-design]
- **Verify:** `cd server && pnpm test -- eval.it` — and confirm from the reporter that the suite **ran** rather than self-skipping without Docker (`server/INSIGHTS.md` 2026-07-29)

### Task 11 — seed path: ≥ 8 cases for a built-in agent

- **Module:** `server/` (pnpm). **Depends on:** Tasks 2, 3.
- **Files:** `server/src/db/seed.ts` (new `seedEvalCases(db, workspaceId)` called from `seed()`); new `server/test/eval-seed.it.test.ts`.
- **Do:** seed `EVAL_SEED_CASE_COUNT` (8) hand-authored cases for **`Security Reviewer`** (enabled built-in; resolved by name exactly as `seedSkills` resolves agents) — hand-authored because seeded data has zero findings (`client/INSIGHTS.md` 2026-08-04), so the finding-born path cannot produce them. Mix: 5 `must_find` (leaked key, SQL injection, SSRF, missing auth check, weak hash) + 3 `must_not_flag` (dismissed-noise shapes). Each `input_diff` is a **valid unified-diff fragment** (`@@ -a,b +c,d @@` hunks with `+`/context lines) whose expectation range points at real new-side lines inside the fragment — the grounding gate builds its line index from parsed hunks, so an unparseable fragment scores everything ungrounded (the spec's groundability constraint). `input_meta` carries a plausible `pr_title`/`pr_body`/`repo`/`pr_number`, and `source_finding_id: 'seed:<slug>'` — the marker also powers idempotency: skip insertion when a case with that marker already exists for the workspace (the `seedAgents` name-check pattern). `expected_output` is a valid `EvalExpectation`.
- **covers:** [AC-39]
- **skills:** [drizzle-orm-patterns, security, zod]
- **Tests:** `server/test/eval-seed.it.test.ts`: fresh testcontainer, run `seed(db)` **twice**; assert ≥ 8 `eval_cases` rows owned by the `Security Reviewer` agent, both expectation kinds present, every `expected_output` parses as `EvalExpectation`, every `input_diff` parses via `caseDiff` into ≥ 1 hunk, and the count after the second run equals the count after the first (idempotent).
- **Verify:** `cd server && pnpm test -- eval-seed` (confirm it ran, not skipped) · manually against the dev DB: `cd server && pnpm db:seed` twice, then a row-count query

### Task 12 — rewrite `client/messages/en/eval.json` (+ the tab label)

- **Module:** `client/` (pnpm). **Depends on:** nothing (parallel-safe).
- **Files:** `client/messages/en/eval.json`; `client/messages/en/agents.json` (add `editor.tabs.evals: "Evals"` beside the existing tab labels — the tab strip resolves `labelKey` under the `agents` namespace); new `client/src/app/eval/messages.test.ts`.
- **Do:** pre-staged copy is a proposal, not a spec (root `INSIGHTS.md` 2026-08-05/29; this file already misled three features). Rewrite to describe **only** what is built:
  - **Remove entirely:** the `caseEditor` object (manual editor — Out), `evalsTab.run` / `evalsTab.running` / `evalsTab.edit` / `evalsTab.newCase` (per-case run + editor affordances — Out), `dashboard.metricTrend` + `dashboard.legend` (trend chart — Out), `dashboard.configure`, `page.crumbNewCase` / `page.crumbEvalCase`.
  - **Keep:** `dashboard.defaultTitle`, `dashboard.loading`, `dashboard.recentRuns`, **`dashboard.noRuns`** (AC-37's string), `dashboard.metrics.*`, `dashboard.table.*`, `evalsTab.casesHeading`, `evalsTab.loadingCases`, `evalsTab.delete`, `page.crumbEvalDashboard` / `page.crumbAgents` / `page.crumbEvals` / `page.crumbSkillsLab`; rewrite `evalsTab.emptyCases` to name the real creation path ("Accept or dismiss a finding on a PR, then add it here as an eval case.").
  - **Add:** batch-run keys (`runBatch` with case count, `runningBatch`, `refusedInFlight`), latest-result keys (metrics labels, `passedOfTotal`, `erroredCount`), history keys (`historyHeading`, `version` label, `cost`), comparison keys (`compareHeading`, `selectTwo`, `delta`, `perCaseHeading`, per-case pass/fail/error labels), finding-card keys (`findingAction.add`, `findingAction.adding`, `findingAction.added`, `findingAction.exists`), dashboard keys (`casesTotal`, `agent` column). No string may promise a manual editor, per-case run, trend, schedule, or automatic runs.
- **covers:** [AC-38]
- **skills:** [frontend-ui-architecture]
- **Tests:** `client/src/app/eval/messages.test.ts` — plain JSON assertions, not a render: import `eval.json`; assert `msgs.caseEditor === undefined`, `msgs.evalsTab.run === undefined`, `msgs.evalsTab.edit === undefined`, `msgs.evalsTab.newCase === undefined`, `msgs.dashboard.metricTrend === undefined`, `msgs.dashboard.legend === undefined`; assert `msgs.dashboard.noRuns` is still a string (AC-37 depends on it); assert the new `findingAction` / comparison keys exist. `loadMessages` reads every file in `messages/en/`, so there is no registration step.
- **Verify:** `cd client && pnpm typecheck && pnpm test -- messages`

### Task 13 — `client/src/lib/hooks/eval.ts`

- **Module:** `client/` (pnpm). **Depends on:** Task 1.
- **Files:** new `client/src/lib/hooks/eval.ts`; `client/src/lib/hooks/index.ts` (add `export * from "./eval";`).
- **Do:** components never fetch or name a query key. Hooks, with their own top-level keys (nothing here may ride `["reviews", …]` invalidations — eval reads must not churn on review activity):
  - `useAgentEvalCases(agentId)` — `["eval-cases", agentId]`, `GET /agents/:id/eval-cases`.
  - `useCreateEvalCase()` — mutation `(findingId) => api.post<EvalCase>(\`/findings/${findingId}/eval-case\`)` (body-less POST — `api.ts` already omits `content-type` for that); `onSuccess` invalidates the `["eval-cases"]` prefix. **The 409 `eval_case_exists` outcome is surfaced, not retried**: callers read `ApiError.code`.
  - `useDeleteEvalCase(agentId)` — `DELETE /eval-cases/:id`; invalidates `["eval-cases", agentId]`.
  - `useRunEvalBatch(agentId)` — mutation `POST /agents/:id/eval-runs` → `EvalBatchDetail`; `onSuccess` seeds `qc.setQueryData(["eval-batch", agentId, detail.batch_id], detail)` (the response *is* the fresh record — no second round trip) and invalidates `["eval-batches", agentId]` + `["eval-dashboard"]`.
  - `useEvalBatches(agentId)` — `["eval-batches", agentId]`.
  - `useEvalBatch(agentId, batchId | null)` — `["eval-batch", agentId, batchId]`, `enabled: batchId != null` (the comparison fetches this twice with two ids).
  - `useEvalDashboard()` — `["eval-dashboard"]`.
- **covers:** [AC-13, AC-32, AC-34, AC-35, AC-36]
- **skills:** [react-best-practices, frontend-ui-architecture, next-best-practices]
- **Tests:** none of its own — exercised through Tasks 14–16 component tests (the RTL skill: test simple data hooks through their components).
- **Verify:** `cd client && pnpm typecheck`

### Task 14 — FindingCard: the eval-case control

- **Module:** `client/` (pnpm). **Depends on:** Tasks 12, 13.
- **Files:** `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingCard/FindingCard.tsx` (+ its `styles.ts` if needed); `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingCard/FindingCard.test.tsx` (extend or create beside the component).
- **Do:** the card already derives `accepted` / `dismissed` from `f.accepted_at` / `f.dismissed_at` (`FindingCard.tsx:50-52`). Add, in the actions row beside accept/dismiss, a single-activation control using `useCreateEvalCase()` and `useTranslations("eval")` (`findingAction.*` keys):
  - rendered **only** when `accepted || dismissed` (AC-11); when neither, the control is absent from the DOM (AC-12);
  - `onClick` → `create.mutate(f.id)` exactly once; `disabled` while `isPending` (AC-13's "exactly one request");
  - outcome states without reload: success → `findingAction.added`; `ApiError.code === "eval_case_exists"` → `findingAction.exists` (not an error style); other errors → inline error note (AC-13).
  Local mutation state only; no `useState` mirror of server data, no `useEffect`.
- **covers:** [AC-11, AC-12, AC-13]
- **skills:** [react-best-practices, react-testing-library, frontend-ui-architecture]
- **Tests:** `FindingCard.test.tsx` — module-mock `@/lib/hooks/eval` (mutable `mockState` reset in `beforeEach`), real `eval.json` messages in the provider, **`fireEvent`, never `userEvent`** (not a dependency — `client/INSIGHTS.md` 2026-08-20). Flows: (1) accepted finding shows the control; clicking calls the mutate spy exactly once and a second click while `isPending` calls it zero more times (AC-11, AC-13); (2) dismissed finding shows it too (AC-11); (3) undecided finding: the control is not in the document (AC-12); (4) the `eval_case_exists` rejection renders the "exists" outcome without reload (AC-13).
- **Verify:** `cd client && pnpm typecheck && pnpm test -- FindingCard`

### Task 15 — the Evals tab: cases, run, history, comparison, tab wiring

- **Module:** `client/` (pnpm). **Depends on:** Tasks 12, 13.
- **Files:** new `client/src/app/agents/[id]/_components/AgentEditor/_components/EvalsTab/{EvalsTab.tsx, constants.ts, styles.ts, index.ts, EvalsTab.test.tsx}`; `client/src/app/agents/[id]/_components/AgentEditor/constants.ts` (add the `TABS` entry); `client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx` (render branch); `client/src/app/agents/[id]/page.test.tsx` (round-trip guard).
- **Do:**
  - `constants.ts`: append `{ key: "evals", labelKey: "editor.tabs.evals", icon: "BarChart2" /* or nearest available IconName */ }` to `TABS`. `VALID_TABS` is derived from `TABS` (`constants.ts:19`), so the page whitelist updates itself — that derivation is exactly the guard `client/INSIGHTS.md` 2026-08-29 prescribes, and the existing `page.test.tsx` (`it.each(TABS.map(t => t.key))`) automatically gains a `?tab=evals` round-trip case; confirm it passes and extend nothing unless it fails (AC-31).
  - `AgentEditor.tsx`: add the `tab === "evals"` branch rendering `<EvalsTab agentId={…} agentVersion={agent.version} model={agent.model} />` beside the Config/Skills/Context branches.
  - `EvalsTab.tsx` (`'use client'` leaf, `useTranslations("eval")`), mutually exclusive states as early-return branches, private subcomponents (`CaseRow`, `BatchRow`, `ComparisonPanel`) in-file until shared:
    - **Cases** — `useAgentEvalCases`: each row shows `name`, expectation-kind badge (parse `expected_output` with `EvalExpectation.safeParse`; unparseable → a neutral badge), `file:start–end`, and a delete control via `useDeleteEvalCase` (AC-10); empty → `evalsTab.emptyCases`.
    - **Run** — a `runBatch` button labelled with the case count, wired to `useRunEvalBatch`; **while `isPending` the button is disabled and shows the pending state — no second trigger from this surface** (AC-32); `eval_run_in_flight` 409 renders `refusedInFlight`; disabled when the case list is empty. On success render the returned `EvalBatchDetail`'s recall / precision / citation accuracy and `passedOfTotal` (+ errored count when > 0) (AC-33).
    - **History** — `useEvalBatches`, newest first: time, `v{agent_version}`, model, the three metrics, cost (AC-34, AC-26 client half).
    - **Comparison** — each history row has a select toggle; when exactly two are selected, `useEvalBatch` twice and render side-by-side: both versions/models, each batch's three metrics with signed deltas, and per-case outcomes aligned by `case_id` (name + pass/fail/error per side; a case present in only one batch renders a "—" cell) (AC-35, AC-26).
- **covers:** [AC-10, AC-26, AC-31, AC-32, AC-33, AC-34, AC-35]
- **skills:** [react-best-practices, frontend-ui-architecture, react-testing-library, next-best-practices]
- **Tests:** `EvalsTab.test.tsx` — module-mock `@/lib/hooks/eval` (mutable `mockState`), real `eval.json`, `fireEvent`. Flow tests, not one-per-assertion: (1) *cases* — rows show name, kind badge and `file:12–14`, delete calls the spy with the case id, empty list renders the empty copy (AC-10); (2) *run* — clicking run calls the mutate spy once; with `isPending: true` the button is disabled and pending copy shows and a click fires nothing (AC-32); with a returned detail, the three metrics and passed/total render (AC-33); (3) *history* — two summaries render newest first with `v3`/`v5`, model and cost visible (AC-34, AC-26); (4) *comparison* — selecting two batches renders both metric columns, deltas, and per-case rows aligned by `case_id` including one case that errored on one side (AC-35). Plus the untouched-but-now-covering `page.test.tsx` run for the `evals` round-trip (AC-31).
- **Verify:** `cd client && pnpm typecheck && pnpm test -- EvalsTab` · `cd client && pnpm test -- agents` (the page round-trip suite)

### Task 16 — the `/eval` dashboard page + sidebar link

- **Module:** `client/` (pnpm). **Depends on:** Tasks 12, 13.
- **Files:** new `client/src/app/eval/page.tsx`; new `client/src/app/eval/_components/EvalDashboard/{EvalDashboard.tsx, styles.ts, index.ts, EvalDashboard.test.tsx}`; `client/src/vendor/ui/nav.ts` (Decision 11).
- **Do:**
  - `nav.ts`: add `{ key: "eval", label: "Eval Dashboard", icon: "BarChart2" /* nearest IconName */, href: "/eval", gKey: "e" }` to the `SKILLS LAB` group and `{ keys: "g e", label: "Go to Eval Dashboard", group: "Navigation" }` to `SHORTCUTS` — the conventions-feature precedent (commit `641b637`). `activeKeyFor("/eval")` already returns `"eval"` (`app-shell/helpers.ts:35`), so the item lights up with no further wiring.
  - `page.tsx`: thin `'use client'` page — `AppShell` with the `page.crumbEvalDashboard` crumb, rendering `<EvalDashboard />`.
  - `EvalDashboard.tsx`: `useEvalDashboard()` + `useTranslations("eval")`; early-return branches — loading (`dashboard.loading`), error (inline `ErrorState`), **`recent.length === 0` → an explicit empty state rendering `dashboard.noRuns`** (AC-37), populated → `cases_total` summary line + a recent-batches table with agent name, time, and the three metrics (per `dashboard.table.*` / `dashboard.metrics.*`), newest first (AC-36).
- **covers:** [AC-36, AC-37]
- **skills:** [frontend-ui-architecture, react-best-practices, next-best-practices, react-testing-library]
- **Tests:** `EvalDashboard.test.tsx` — mock `@/lib/hooks/eval`, real messages, `fireEvent` where needed: populated state renders agent names, times and the three metric values for two fixture batches (AC-36); the empty state renders the exact `dashboard.noRuns` string and no table and no error UI (AC-37); plus a plain assertion importing `NAV` from `@devdigest/ui` (or `../../vendor/ui/nav`) that an item `{ key: "eval", href: "/eval" }` exists — the mechanical "reachable from the left sidebar" check (AC-36).
- **Verify:** `cd client && pnpm typecheck && pnpm test -- EvalDashboard`

### Task 17 — `verify:l06` at the repo root

- **Module:** repo root (no package manager work — a file write only). **Depends on:** everything server/client (it is the gate over them).
- **Files:** new `/package.json` (repo root).
- **Do:** exactly this, nothing more (Decision 10):
  ```json
  {
    "name": "devdigest-root",
    "private": true,
    "scripts": {
      "verify:l06": "pnpm -C server typecheck && pnpm -C server exec vitest run --exclude '**/*.it.test.ts' && pnpm -C client typecheck && pnpm -C client test"
    }
  }
  ```
  No `dependencies`, no `devDependencies`, no `packageManager` field that would trigger corepack churn, **no `pnpm-workspace.yaml`, no root lockfile, no install step** (AC-NF-09). `pnpm -C <dir>` runs each package's own scripts against its own lockfile; `&&` chaining makes any lane's failure the gate's non-zero exit (AC-40). The server lane is the hermetic exclusion invocation from `server/CLAUDE.md`; the client lane is its full vitest + typecheck.
- **covers:** [AC-40, AC-NF-09]
- **skills:** [onion-architecture]
- **Tests:** none (it *is* a test runner).
- **Verify:** from the repo root: `pnpm verify:l06` exits 0 · `git status --porcelain` shows only `package.json` (no lockfile appeared) · break-one-lane probe: temporarily introduce a type error in `client/src` (or run with an intentionally failing test filter), observe non-zero exit, revert · confirm no `pnpm-workspace.yaml` and no root `node_modules/` exist afterwards

### Task 18 — operational: the demo-day experiment (Decision-log 12)

- **Module:** none (manual, paid; run against the local stack). **Depends on:** Tasks 1–17 landed and migrated/seeded.
- **Do:** the spec's Decision 12 says "prompt changes visibly move the numbers" is a demonstration, not an automatable AC; this task is that demonstration, exercising the machinery AC-04/AC-26/AC-35 guarantee. Steps (each batch ≈ 8 calls on `deepseek/deepseek-v4-flash` — cheap but not free):
  1. `./scripts/dev.sh` (or ensure the stack is up), `cd server && pnpm db:migrate && pnpm db:seed` — the Security Reviewer now has ≥ 8 cases.
  2. In the studio: Agents → Security Reviewer → Evals tab → **Run eval** → note the batch (version `v1`), its recall / precision / citation.
  3. Config tab: **degrade the prompt deliberately** — e.g. append "Flag every changed line as a potential security issue, regardless of evidence." Save (this bumps `agents.version`).
  4. Evals tab → **Run eval** again (version `v2`).
  5. Select both batches → comparison shows `v1 vs v2` with a visible **precision drop** (the degraded prompt now matches the `must_not_flag` regions) and the deltas attributable to the prompt because inputs were frozen (AC-04) and version + model are recorded (AC-26).
  6. Open `/eval`: both batches appear under the agent's name (AC-36 in the flesh).
  7. **Revert the system prompt** to the seeded text (seed does not overwrite existing agents; revert by hand in the Config tab), and optionally run a third batch to show recovery.
  8. If the run 500s with a provider 401, that is the dead-key class of failure — check key shapes per `INSIGHTS.md` *Recurring Errors & Fixes* 2026-08-29; the fix is workspace Settings, never a contract edit.
- **covers:** [AC-26, AC-33, AC-35] (manual demonstration of the machinery those ACs' automated tests already pin)
- **skills:** [engineering-insights] (the implementer records anything non-obvious the live run surfaces)
- **Verify:** the comparison view shows a precision delta between the two batches; screenshots optional.

---

## AC coverage

| AC-ID | Tasks | Completed by | Verified by |
| ----- | ----- | ------------ | ----------- |
| AC-01 | 6 | 6 | `server/test/eval-cases.test.ts` |
| AC-02 | 6 | 6 | `server/test/eval-cases.test.ts` |
| AC-03 | 6 | 6 | `server/test/eval-cases.test.ts` |
| AC-04 | 6, 7 | 7 | `server/test/eval-run.test.ts` |
| AC-05 | 6 | 6 | `server/test/eval-cases.test.ts` |
| AC-06 | 5, 6 | 6 | `server/test/eval-cases.test.ts` |
| AC-07 | 6 | 6 | `server/test/eval-cases.test.ts` |
| AC-08 | 6 | 6 | `server/test/eval-cases.test.ts` |
| AC-09 | 5, 10 | 10 | `server/test/eval.it.test.ts` |
| AC-10 | 15 | 15 | `client/…/EvalsTab/EvalsTab.test.tsx` |
| AC-11 | 14 | 14 | `client/…/FindingCard/FindingCard.test.tsx` |
| AC-12 | 14 | 14 | `client/…/FindingCard/FindingCard.test.tsx` |
| AC-13 | 9, 13, 14 | 14 | `client/…/FindingCard/FindingCard.test.tsx`, `server/test/eval-routes.test.ts` |
| AC-14 | 2, 7, 10 | 7 | `server/test/eval-run.test.ts`, `server/test/eval.it.test.ts` |
| AC-15 | 7 | 7 | `server/test/eval-run.test.ts` |
| AC-16 | 7 | 7 | `server/test/eval-run.test.ts` |
| AC-17 | 7 | 7 | `server/test/eval-run.test.ts` |
| AC-18 | 4 | 4 | `server/test/eval-scoring.test.ts` |
| AC-19 | 4, 7 | 4 | `server/test/eval-scoring.test.ts` |
| AC-20 | 4, 7 | 4 | `server/test/eval-scoring.test.ts` |
| AC-21 | 4, 7 | 7 | `server/test/eval-scoring.test.ts`, `server/test/eval-run.test.ts` |
| AC-22 | 4, 7 | 7 | `server/test/eval-scoring.test.ts`, `server/test/eval-run.test.ts` |
| AC-23 | 4, 7 | 7 | `server/test/eval-scoring.test.ts`, `server/test/eval-run.test.ts` |
| AC-24 | 4 | 4 | `server/test/eval-scoring.test.ts` |
| AC-25 | 7 | 7 | `server/test/eval-run.test.ts` |
| AC-26 | 1, 2, 7, 8, 15, 18 | 15 | `server/test/eval-run.test.ts`, `client/…/EvalsTab/EvalsTab.test.tsx` |
| AC-27 | 1, 7 | 7 | `server/test/eval-run.test.ts` |
| AC-28 | 7 | 7 | `server/test/eval-run.test.ts` |
| AC-29 | 7 | 7 | `server/test/eval-run.test.ts` |
| AC-30 | 7 | 7 | `server/test/eval-run.test.ts` |
| AC-31 | 15 | 15 | `client/src/app/agents/[id]/page.test.tsx` |
| AC-32 | 13, 15 | 15 | `client/…/EvalsTab/EvalsTab.test.tsx` |
| AC-33 | 1, 15, 18 | 15 | `client/…/EvalsTab/EvalsTab.test.tsx` |
| AC-34 | 1, 5, 8, 13, 15 | 15 | `client/…/EvalsTab/EvalsTab.test.tsx` |
| AC-35 | 1, 8, 13, 15, 18 | 15 | `client/…/EvalsTab/EvalsTab.test.tsx` |
| AC-36 | 1, 5, 8, 13, 16 | 16 | `client/…/EvalDashboard/EvalDashboard.test.tsx` |
| AC-37 | 8, 16 | 16 | `client/…/EvalDashboard/EvalDashboard.test.tsx` |
| AC-38 | 12 | 12 | `client/src/app/eval/messages.test.ts` |
| AC-39 | 11 | 11 | `server/test/eval-seed.it.test.ts` |
| AC-40 | 17 | 17 | `pnpm verify:l06` run + break-one-lane probe |
| AC-NF-01 | 5, 9, 10 | 10 | `server/test/eval.it.test.ts` |
| AC-NF-02 | 3, 9 | 9 | `server/test/eval-routes.test.ts` (non-`test` `NODE_ENV` app build) |
| AC-NF-03 | 9 | 9 | `server/test/eval-routes.test.ts` |
| AC-NF-04 | 7 | 7 | `server/test/eval-run.test.ts` |
| AC-NF-05 | 3, 4, 7 | 7 | `server/test/eval-scoring.test.ts`, `server/test/eval-run.test.ts` |
| AC-NF-06 | 7 | 7 | `server/test/eval-run.test.ts` |
| AC-NF-07 | 7 | 7 | `server/test/eval-run.test.ts` |
| AC-NF-08 | 1 | 1 | `diff` on both contract files + `cd client && pnpm typecheck` |
| AC-NF-09 | 17 | 17 | root inspection after the change (no deps/lockfile/workspace) |
| AC-NF-10 | 3 | 3 | code review against `server/src/modules/eval/constants.ts` |
| AC-NF-11 | 5, 7 | 7 | `server/test/eval-run.test.ts` |

51 rows, 51 AC-IDs, no blanks.

---

## Verification plan

In execution order. **`server/` and `client/` use pnpm; never npm in either. `reviewer-core/` and `e2e/` are untouched — do not run npm in them.** Where `pnpm` is off PATH, use the local binaries (`server/INSIGHTS.md` 2026-08-29).

1. After Task 1: `cd server && pnpm typecheck && pnpm test -- contracts` · `diff server/src/vendor/shared/contracts/eval-ci.ts client/src/vendor/shared/contracts/eval-ci.ts` empty · same for `knowledge.ts` · `cd client && pnpm typecheck`.
2. After Task 2: `cd server && pnpm typecheck` · `git diff server/src/db/migrations/meta/_journal.json` shows one appended entry only · `pnpm db:migrate` ends `✓ migrations applied`.
3. After Tasks 3–9 (each): `cd server && pnpm typecheck` then `pnpm test -- <the task's test file>`.
4. After Task 9: `cd server && ./node_modules/.bin/depcruise --config .dependency-cruiser.cjs src` — zero violations. Do **not** use `pnpm arch`.
5. After Tasks 10–11: `cd server && pnpm test -- eval.it` and `pnpm test -- eval-seed` — confirm from the reporter both **ran** (Docker present), not self-skipped.
6. Type-check the new test files once (`server/test/**` is not type-checked by `pnpm typecheck` and vitest strips types):
   ```
   cd server && printf '{"extends":"./tsconfig.json","compilerOptions":{"noEmit":true},"include":["test/eval-scoring.test.ts","test/eval-cases.test.ts","test/eval-run.test.ts","test/eval-routes.test.ts","test/eval.it.test.ts","test/eval-seed.it.test.ts","test/helpers/eval.ts","src/**/*.ts"]}' > .tsc-testcheck.json && ./node_modules/.bin/tsc --noEmit -p .tsc-testcheck.json; rm .tsc-testcheck.json
   ```
   (`src/**` must stay in `include`; expect to fix a stale shared-helper fixture if one is dragged in — 2026-08-29 entry.)
7. After Tasks 12–16 (each): `cd client && pnpm typecheck` then `pnpm test -- <the task's test file>`.
8. After Task 16: `cd client && pnpm test` (full suite — the `TABS`/nav edits touch shared machinery) and `pnpm build` (**not while `next dev` is running** — it destroys `.next/`; recover with `rm -rf client/.next` + restart, `client/INSIGHTS.md` 2026-08-29).
9. After Task 17, from the repo root: `pnpm verify:l06` exits 0 · `git status --porcelain` shows no lockfile or workspace file · break-one-lane probe exits non-zero.
10. Final: `cd server && pnpm typecheck && pnpm test` (both lanes) · `cd client && pnpm typecheck && pnpm test`.
11. Task 18's manual experiment, last.

---

## Constraints & risks

**Ordering constraints that bind this plan.** Contracts land in `server/src/vendor/shared/` **and** the `client/src/vendor/shared/` hand-mirror before any consumer (Task 1 gates 3–9 and 13–16). The schema change is a **new** migration via `pnpm db:generate` + `pnpm db:migrate`; no existing migration is edited; migrations do not run on boot. The new module is registered in `server/src/modules/index.ts` as an explicit line item in Task 9 (`import evalRoutes` — `eval` is a reserved identifier). **No new external dependency**, so the port-first ladder does not apply: the model call goes through the existing injected `LLMProvider`, and `MockLLMProvider` is the double (spec: "Adapters needed — None"). Every task names its lane: `*.it.test.ts` = DB-backed, everything else hermetic. No `pnpm arch` task exists.

**Architectural rules this plan is written against.** `no-cross-module-internals`: the eval module imports no sibling's `service/repository/helpers/routes`; cross-domain data comes off the container (`reviewRepo`, `agentsRepo`), and the one pure mapper it needs (`toSkillPromptBlock`) is duplicated on purpose (sanctioned, `server/INSIGHTS.md` 2026-08-05). `transport-never-queries`: `eval/routes.ts` imports neither `db/schema` nor `drizzle-orm`. `platform/grounding.ts` is a re-export shim — the gate is applied by calling `reviewPullRequest`, never bypassed, never edited. Every route resolves tenancy via `getContext` and declares `schema.response`. `reviewer-core` is not modified (Decision 4).

**Known dead ends this plan routes around.**

- Vacuous inert/baseline tests when a facade is absent (`server/INSIGHTS.md` 2026-08-28) → the Task 6 harness wires every dependency present-and-empty; AC-30 asserts on spies that exist.
- `db:generate` on a diverged journal rewrites history (2026-08-05) → Task 2 preflight/post-check.
- it-tests reaching a real provider on keyed machines (2026-08-14) → Task 10 overrides all three provider ids.
- `*.it.test.ts` self-skip without Docker (2026-07-29) → step 5 confirms the suites ran.
- `server/test/**` is not type-checked (2026-08-17) → verification step 6.
- Rate limit inert under `NODE_ENV=test` (2026-08-29) → Task 9's AC-NF-02 case builds a `development` app with `LOG_LEVEL: 'silent'`.
- The `?tab=` double whitelist (`client/INSIGHTS.md` 2026-08-29) → the agent editor already derives `VALID_TABS` from `TABS`; Task 15 adds only the `TABS` entry and leans on the existing page-level round-trip test.
- Pre-staged copy is a proposal (root, 2026-08-05/29) → Task 12 deletes the `caseEditor`, per-case `run`, and `metricTrend` keys outright.
- `user-event` is not a client dependency (2026-08-20) → all client tests use `fireEvent`, overriding the `react-testing-library` skill's rule.
- Seeded data has zero findings (2026-08-04) → Task 11's cases are hand-authored fragments; the finding-born path is exercised hermetically and via Task 10.

**Skill/repo conflicts, resolved in favour of the repo:** `react-testing-library`'s "always `userEvent`" (above), and `onion-architecture`'s narrow-deps preference for new services — `EvalService` takes the whole `Container` like every sibling; trade-off recorded in Task 6.

**Risks.**

- *Task 16 edits vendored `client/src/vendor/ui/nav.ts`* — the only "do not touch" exception in the plan; it follows the conventions-feature precedent (commit `641b637`) and is confined to two appended entries. Run the full client suite after it.
- *`agent_version` labelling blind spot is inherited, not fixed*: relinking skills does not bump `agents.version` (`server/INSIGHTS.md` 2026-08-05), so two batches can share a label yet differ in prompt. The spec accepts this explicitly; the batch also records `model`, and Task 18's demo uses a prompt edit (which does bump the version).
- *`EvalCaseOutcome` inside `actual_output`* (Decision 3) means the batch aggregates depend on a jsonb parse; the repository parses with zod so a corrupt row fails loudly, and Task 10 round-trips the shape against real Postgres.
- *A crashed batch leaves fewer rows than cases* — accepted and specified (AC-NF-11); history simply shows that batch with a lower `cases_total`. No reaper, no status column.

## Technical open questions

**None.** Decisions 1–12 above resolve everything the spec delegated (route ownership, index set, error storage, per-call bounds, `verify:l06` composition, sidebar mechanism); each records the rejected alternative.
