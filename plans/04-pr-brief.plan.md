# Development Plan: PR Brief — the Why + Risk card

**Spec:** `specs/04-pr-brief.md` (Status: agreed; all 14 clarifications resolved 2026-08-29)
**AC-IDs in scope:** AC-01 … AC-47, AC-NF-01 … AC-NF-12 (59 total)
**Produced by:** `implementation-planner`, 2026-08-29
**Maintainer rulings on the planner's two interpretation flags:** both accepted — see "Constraints & risks".

## Goal & scope

**In.** A `brief` server module that assembles the brief's inputs from existing modules, makes **one** structured model call, grounds the result against those inputs, persists it, and serves it via `GET /pulls/:id/brief` (stored only, 404 when none) and `POST /pulls/:id/brief` (generate/regenerate, rate-limited). A `PrBriefCard` on the PR Overview tab beside `IntentCard` and `BlastCard`, with generate, regenerate, outdated and degraded states, and a clickable review-focus list plus the cross-tab deep link that makes it navigable. The `Brief` contract in `@devdigest/shared` (canonical first, then the client hand-mirror). A migration adding `head_sha`, `model`, `generated_at` to `pr_brief`.

**Non-goals (do not build).** Replacing the review; consuming the PR's review findings; reading the linked issue's body; feeding the brief into the review prompt; reading diff hunk bodies; a verdict banner or PR score; classifying intent on demand; the CI/GitHub path; MCP exposure. Changing `IntentCard`/`BlastCard`; changing the existing `PrBrief` schema; changing Smart Diff classification or Project Context discovery; widening `FeatureModelId` or changing the `risk_brief` default; a per-repository brief-context selector; any second model call.

## Context consulted

| Source | What it constrained |
| --- | --- |
| `specs/04-pr-brief.md` | Everything. AC-IDs, input provenance, contract shapes, cache semantics, drop order. |
| `INSIGHTS.md` (root), *What Doesn't Work* 2026-07-29 + 2026-08-28 refinement | `client/src/vendor/shared/` is a hand-copy with no sync script; **the client typecheck is the mechanism that catches an incomplete mirror**. Forces Task 1's shape and its verification command. `brief.ts` is currently *in sync* (verified: `diff -rq server/src/vendor/shared client/src/vendor/shared` reports only `adapters.ts`, `contracts/eval-ci.ts`, `contracts/productionize.ts`). |
| `server/INSIGHTS.md`, *Codebase Patterns* 2026-08-05 (`no-cross-module-internals`) + 2026-08-16/2026-08-17 (narrow structural ports) | Decision 1 below: facades on the container, ports in each module's `types.ts`. |
| `server/INSIGHTS.md`, *Codebase Patterns* 2026-07-29 (three `platform/` re-export shims) | `platform/grounding.ts` must not be edited; `platform/prompt.ts` is still a legal *import* target. |
| `server/INSIGHTS.md`, *What Doesn't Work* 2026-08-28 (vacuous inert test) | Every hermetic harness wires its facades and has them **resolve to empty**, never be absent. Shapes Tasks 8 and 11. |
| `server/INSIGHTS.md`, *What Doesn't Work* 2026-08-05 (`_journal.json` rewriting) + *Tool & Library Notes* 2026-08-05 (interactive `db:generate`) | Task 2's preflight and post-check. |
| `server/INSIGHTS.md`, *Recurring Errors & Fixes* 2026-08-17 (`server/test/**` is not type-checked) | The throwaway-tsconfig recipe in the Verification plan. |
| `server/INSIGHTS.md`, *Recurring Errors & Fixes* 2026-08-14 (it-tests reach a real provider) | Every brief it-test must override `llm` for **every** provider id it could resolve. |
| `server/INSIGHTS.md`, *What Doesn't Work* 2026-08-05 ("not one route declares `schema.response`") | **Now stale** — `blast/routes.ts:22`, `intent/routes.ts:24,38` and `smart-diff/routes.ts:21` all declare it. Follow those, not the entry. |
| `client/INSIGHTS.md`, *Codebase Patterns* 2026-08-29 (`?tab=` double whitelist) | Checked: the PR page has **no** tab whitelist (`page.tsx:60` falls back to `"overview"`, each tab is a `tab === "…"` branch), so the deep link needs no whitelist edit. Recorded so Task 16 does not go looking for one. |
| `client/INSIGHTS.md`, *Codebase Patterns* 2026-08-16 (query-key prefix invalidation) | Task 13's key choice, and its inverse: AC-41 forbids riding `["reviews", prId]`. |
| `client/INSIGHTS.md`, *Tool & Library Notes* 2026-08-20 (`user-event` not a dependency) | All client tests use `fireEvent`. Overrides the `react-testing-library` skill's "NEVER fireEvent" rule — see Constraints. |
| `.claude/skills/postgresql-table-design/SKILL.md` | Task 2's column types, the `timestamptz` rule, and the deliberate no-index decision. |
| `.claude/skills/onion-architecture/SKILL.md` | Decisions 1–3; module promotion ladder; ports & adapters ordering; test lanes. |
| `.claude/skills/react-testing-library/SKILL.md` | Test-per-component budget, query priority, `screen`-only, no snapshot tests. |
| Source read | `server/src/vendor/shared/contracts/{brief,review-api,platform}.ts`; `server/src/db/schema/reviews.ts:92-126`; `server/src/platform/{container,prompt,grounding,prompt-log}.ts`; `server/src/modules/intent/{service,routes,types,prompt,constants}.ts`; `server/src/modules/blast/{service,routes,types,helpers,constants}.ts`; `server/src/modules/smart-diff/{service,routes,types,constants}.ts`; `server/src/modules/project-context/{service,types,constants}.ts`; `server/src/modules/settings/feature-models.ts`; `server/src/modules/reviews/repository.ts` + `repository/pull.repo.ts`; `server/src/modules/pulls/repository.ts`; `server/src/adapters/mocks.ts`; `server/src/app.ts:90-134`; `server/.dependency-cruiser.cjs`; `server/test/{blast-service.test.ts,blast.it.test.ts,routes-smoke.test.ts,helpers/{pg,run-executor}.ts}`; `reviewer-core/src/{index,prompt,grounding}.ts`; `client/src/app/repos/[repoId]/pulls/[number]/page.tsx`, `_components/{OverviewTab,IntentCard,DiffTab,SmartDiffViewer}/`, `client/src/components/diff-viewer/FileCard/FileCard.tsx`; `client/src/lib/{api.ts,types.ts,hooks/{intent,blast,smart-diff,index}.ts}`; `client/messages/en/brief.json`; `client/src/i18n/request.ts`. |

## Modules touched

| Module | Package manager | Typecheck | Tests |
| --- | --- | --- | --- |
| `server/` | **pnpm** | `cd server && pnpm typecheck` | `cd server && pnpm test` (hermetic + `*.it.test.ts`; it-tests self-skip without Docker) |
| `server/src/vendor/shared/` | pnpm (part of `server/`) | as above | `server/test/contracts.test.ts` |
| `client/` | **pnpm** | `cd client && pnpm typecheck` | `cd client && pnpm test` |
| `reviewer-core/` | — | **not touched** (see Decision 2) | — |
| `e2e/` | — | not touched | — |

---

## Contract changes

**These land first, in both copies, in the same task.** `server/src/vendor/shared/contracts/brief.ts` is canonical; `client/src/vendor/shared/contracts/brief.ts` is a hand-copy with no sync script (root `INSIGHTS.md`, *What Doesn't Work*, 2026-07-29 / 2026-08-28).

Added to `contracts/brief.ts` (append below `PrBrief`; **nothing existing is edited, renamed or removed** — `PrBrief`, `Risk`, `RiskSeverity` stay exactly as they are):

- `BriefRiskLevel` — `z.enum(['high','medium','low','none'])`. Whole-PR level; distinct from `RiskSeverity`, which stays three-valued and per-risk.
- `BriefFocusItem` — `{ file: z.string().min(1), line: z.number().int().nullish(), reason: z.string().min(1) }`.
- `BriefInputKind` — `z.enum(['intent','blast','smart_diff','project_context'])`.
- `BriefInputStatus` — `z.enum(['absent','degraded','unreachable'])`, following the `IntentSourceStatus` (`contracts/brief.ts:33`) / `SpecRead.status` (`contracts/trace.ts:63-69`) precedent of distinguishing "not there" from "referenced but unreachable".
- `BriefMissingInput` — `{ kind: BriefInputKind, status: BriefInputStatus }`.
- `Brief` — `{ what: z.string(), why: z.string(), risk_level: BriefRiskLevel, risks: z.array(Risk), review_focus: z.array(BriefFocusItem), degraded: z.boolean(), missing_inputs: z.array(BriefMissingInput) }`.
- `PrBriefRecord` (the response envelope, named after the `PrIntentRecord` precedent) — `{ pr_id: z.string(), brief: Brief, head_sha: z.string(), pr_head_sha: z.string(), model: z.string().nullable(), generated_at: z.string() }`. `head_sha` is what the brief was generated against; `pr_head_sha` is the PR's current head, so the card renders the outdated state without a second fetch (`BlastPanel.head_sha` precedent, `contracts/brief.ts:117`).

`contracts/platform.ts` is **not touched**: `FeatureModelId` keeps its five members and the `risk_brief` entry keeps `openai` / `gpt-4.1` (AC-NF-11).

The barrel (`vendor/shared/index.ts`) already does `export * from './contracts/brief.js'`, so no barrel edit is needed on either side.

---

## Design decisions this plan makes (the four the spec delegated)

**Decision 1 — how the brief reaches blast and smart-diff facts: module facades on the container.**

`BlastService` is constructed in-plugin (`blast/routes.ts:18`) and smart-diff likewise; `no-cross-module-internals` (`server/.dependency-cruiser.cjs:29-40`) bans importing either module's `service.ts`. Three shapes were available:

- *Recompute from `container.repoIntel` + `pullsRepo` inside the brief.* Rejected: it duplicates `buildBlastRadius`'s 50 lines of grouping and the whole smart-diff classifier, and AC-02 says "without recomputing any of them from scratch" — a second implementation would drift from the panel the reviewer sees on the same page.
- *Import the sibling service directly.* Rejected: the arch rule forbids it, and the spec requires the rules stay green.
- **Chosen: promote each to a container facade.** Add `BlastFacade` to `blast/types.ts` and `SmartDiffFacade` to `smart-diff/types.ts`, have the existing services `implements` them, expose `container.blast` / `container.smartDiff` as lazy getters, add `ContainerOverrides.blast` / `.smartDiff`, and rewire `blast/routes.ts` and `smart-diff/routes.ts` to read the container getter instead of constructing.

Why it is the right one against `onion-architecture`: the container is the *named* sanctioned seam for cross-module data access ("Cross-module access is via the container"), it is exactly the `repoIntel` / `intent` / `projectContext` / `reviewRunner` pattern already in `container.ts:167-214`, the ports live in each module's own `types.ts` (its published surface), and the port earns its keep on the second criterion the skill sets — `ContainerOverrides` is the test seam, and `server/INSIGHTS.md` 2026-08-28 shows an absent facade makes a best-effort test pass vacuously. `BriefService` gets the same treatment (`BriefFacade`, `container.brief`) so the AC-38 inertness test has a real seam to spy on rather than a spy nothing can reach.

**Decision 2 — where the brief's grounding lives: `server/src/modules/brief/grounding.ts`, brief-local and pure.**

`groundFindings` needs a `Finding` and line-numbered hunks (`reviewer-core/src/grounding.ts:23-37,52-83`); a `Risk` has `file_refs: string[]` and no lines, and this feature never loads hunks. `server/src/platform/grounding.ts` is a re-export shim and must not be edited. Adding a path-set gate to `reviewer-core` was considered and rejected: it would widen the engine's public API for exactly one consumer, and the engine's two-dependency purity is the property `onion-architecture` §Core Principle 4 names. A brief-local pure module is unit-testable with no mocks, which is the same property that made the existing gate testable.

The rule it enforces, stated as `reviewer-core/INSIGHTS.md` *Decisions* 2026-07-31 applied to a brief:

- A `review_focus` item survives iff its `file` is in the input file set; otherwise it is dropped with a reason (AC-07, AC-44).
- A `Risk`'s `file_refs` are filtered to the input file set; each removed ref is recorded (AC-06).
- **A `Risk` survives only if at least one of its `file_refs` is an input file.** *Interpretation flag (maintainer: accepted):* AC-06 alone only requires removing the reference, but AC-09 ("WHEN the system drops a risk…") and AC-31 ("IF no risk survives grounding…") both presuppose risks can fail the gate, and the cited precedent is "cite a real X or be dropped". A risk citing nothing in this PR is therefore dropped, not kept ref-less.
- **AC-08 — endpoints.** *Interpretation flag (maintainer: accepted).* Neither `Risk` nor `Brief` has a field able to hold an endpoint reference, and the spec forbids extending either. The implementable form: the **model's draft schema** (brief-local, `prompt.ts`, never a wire type) carries `endpoint_refs: string[]` per risk; the gate filters those against the blast summary's endpoint set, records every removal (AC-09), counts a surviving endpoint ref as grounding evidence alongside `file_refs`, and then discards `endpoint_refs` when mapping the draft to the wire `Risk`. Net effect, and what the test asserts: an invented endpoint can never survive into the stored brief nor keep a risk alive, and the drop is recorded. This is a real, verifiable mechanism — it is *not* a string scan over model prose, which `reviewer-core/src/review/scope.ts:5-8` forecloses ("in code, like the grounding gate — a model instruction alone is not a guarantee").

**Decision 3 — the deep link: query params, threaded as props.**

`?focus=<path>` + `?line=<n>` alongside the existing `?tab=` / `?trace=` (`page.tsx:60-68`), threaded `page.tsx → DiffTab → SmartDiffViewer → FileCard`. Rejected: a React context (a new provider for a two-hop prop chain, and `client/INSIGHTS.md` 2026-08-04 says thread the prop first) and state lifted into `page.tsx` without a URL (loses shareability and reload, and diverges from the mechanism the page already uses for `trace`). Query params also make the page-level RTL test possible with the `next/navigation` mock the repo already uses.

One concrete trap: `page.tsx:62-67`'s `setParam` writes one key and calls `router.replace` immediately, so three sequential calls each rebuild from the stale `search` object and only the last survives. Task 16 adds a `setParams(entries: Record<string, string | null>)` that mutates one `URLSearchParams` and calls `router.replace` **once**; `setParam` is re-expressed in terms of it.

**Decision 4 — `POST` regenerate signal: a querystring enum, not a body.**

`POST /pulls/:id/brief?force=true`. `schema.querystring: z.object({ force: z.enum(['true','false']).default('false') })`; the handler reads `req.query.force === 'true'`. Rejected: a JSON body — `client/src/lib/api.ts:26-31` deliberately omits `content-type` on a body-less POST so Fastify does not raise "Body cannot be empty", and a required body schema would then 400 the first-generation call. Also rejected: `z.coerce.boolean()`, which parses the string `"false"` as `true`.

---

## Tasks

### Task 1 — `@devdigest/shared`: the `Brief` contract, both copies

- **Module:** `server/` (canonical) + `client/` (hand-mirror). Package manager: pnpm both sides.
- **Files:** `server/src/vendor/shared/contracts/brief.ts` (append only); `client/src/vendor/shared/contracts/brief.ts` (identical append); `client/src/lib/types.ts` (add `Brief`, `BriefRiskLevel`, `BriefFocusItem`, `BriefMissingInput`, `BriefInputKind`, `BriefInputStatus`, `PrBriefRecord` to the existing `export type { PrBrief, SmartDiff, … }` line at :35).
- **Do:** add exactly the shapes listed under **Contract changes**. Do not edit `Risk`, `RiskSeverity`, `PrBrief`, or `contracts/platform.ts`. Append below the `PrBrief` block with a header comment `// ---- PR Brief v2 (the Why + Risk card) ----`.
- **Then, in the same task:** `diff server/src/vendor/shared/contracts/brief.ts client/src/vendor/shared/contracts/brief.ts` must be empty, and `cd client && ./node_modules/.bin/tsc --noEmit` must pass — that typecheck is the only mechanism that catches an incomplete hand-copy (root `INSIGHTS.md`, 2026-08-28).
- **covers:** [AC-01, AC-32, AC-40, AC-44, AC-45, AC-NF-11]
- **skills:** [zod, onion-architecture]
- **Tests:** extend `server/test/contracts.test.ts` with a round-trip: a fully-populated `PrBriefRecord` fixture parses; a `risk_level` outside the four values fails; a `review_focus` item with an empty `reason` fails; `PrBrief` still parses its original `{intent, blast, risks, history}` shape (the "left alone deliberately" guarantee).
- **Verify:** `cd server && pnpm typecheck && pnpm test -- contracts` · `cd client && pnpm typecheck`

### Task 2 — `pr_brief` gains `head_sha`, `model`, `generated_at`

- **Module:** `server/` (pnpm). **Depends on:** nothing.
- **Files:** `server/src/db/schema/reviews.ts:121-126`; a new `server/src/db/migrations/00NN_*.sql` + its snapshot + `meta/_journal.json` (all generated).
- **Do:** extend the existing `prBrief` declaration **in place** — do not move the table to another schema file, and do not edit an existing migration.
  ```ts
  export const prBrief = pgTable('pr_brief', {
    prId: uuid('pr_id').primaryKey().references(() => pullRequests.id, { onDelete: 'cascade' }),
    json: jsonb('json').notNull(),
    /** PR head SHA the brief was generated against — the cache key. A key
     *  inside the jsonb blob could not be queried or indexed. */
    headSha: text('head_sha').notNull(),
    model: text('model'),
    generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
  });
  ```
  Design notes to carry into the code comment: `head_sha` is `NOT NULL` because every write sets it and the table is empty today (`server/INSIGHTS.md`, *Codebase Patterns*, 2026-07-29 lists `pr_brief` among the twelve never-written tables), so there is no backfill and the `NOT NULL`-with-`now()`-default rewrite hazard the `postgresql-table-design` skill flags costs nothing here. `model` is nullable, mirroring `pr_intent.model` (`reviews.ts:106`). `generated_at` is `timestamptz`, never bare `timestamp`. **No index is added**: the only access path is by `pr_id`, which the PK already covers; an index on `head_sha` would be an index for a query nobody issues.
- **Migration mechanics (this is the part nothing reminds you about):**
  1. Preflight: `cd server && git status --porcelain src/db/migrations` must be clean before generating — `pnpm db:generate` on a diverged journal silently **rewrites** committed `_journal.json` history (`server/INSIGHTS.md`, 2026-08-05).
  2. `cd server && pnpm db:generate`. This change only **adds** columns, so the interactive rename prompt (`server/INSIGHTS.md`, *Tool & Library Notes*, 2026-08-05) should not appear; if it does, stop and re-read that entry rather than answering blind.
  3. Post-check: `git diff src/db/migrations/meta/_journal.json` must show a **single appended entry** (`"idx": 19` — the last committed entry today is `0018_confused_newton_destine`, `"idx": 18`) and **zero** modifications to entries 0–18.
  4. `cd server && pnpm db:migrate`. **Migrations do not run on boot** — skipping this leaves the developer's own DB failing at request time with a raw Postgres `column pr_brief.head_sha does not exist`, while `pnpm typecheck` and both test lanes stay green because the integration lane migrates a fresh testcontainer.
- **covers:** [AC-27, AC-43]
- **skills:** [drizzle-orm-patterns, postgresql-table-design]
- **Tests:** none of its own; AC-27 and AC-43 are completed by Task 10's it-tests.
- **Verify:** `cd server && pnpm typecheck` · `cd server && pnpm db:migrate` ends with `✓ migrations applied` (raw Postgres `NOTICE` lines about the `vector` extension are idempotent skips, not errors — `server/INSIGHTS.md`, 2026-07-29)

### Task 3 — container facades for `blast` and `smart-diff`

- **Module:** `server/` (pnpm). **Depends on:** nothing.
- **Files:** `server/src/modules/blast/types.ts`; `server/src/modules/smart-diff/types.ts`; `server/src/modules/blast/service.ts`; `server/src/modules/smart-diff/service.ts`; `server/src/modules/blast/routes.ts`; `server/src/modules/smart-diff/routes.ts`; `server/src/platform/container.ts`.
- **Do:**
  - In `blast/types.ts` add `export interface BlastFacade { get(workspaceId: string, prId: string): Promise<BlastPanel>; }`; `BlastService implements BlastFacade` (its `get` already has that signature — this is a declaration, not a behaviour change).
  - In `smart-diff/types.ts` add `export interface SmartDiffFacade { get(workspaceId: string, prId: string): Promise<SmartDiffResponse>; }`; `SmartDiffService implements SmartDiffFacade`.
  - In `container.ts`: `import type { BlastFacade }` / `SmartDiffFacade`, `import { BlastService }` / `SmartDiffService`; add `blast?: BlastFacade` and `smartDiff?: SmartDiffFacade` to `ContainerOverrides` (documented like the `repoIntel` / `intent` slots at :63-70); add lazy getters mirroring `get intent()` at :177-181, constructing `new BlastService(this.pullsRepo, this.repoIntel)` and `new SmartDiffService(this.pullsRepo, this.reviewRepo)` — i.e. the exact wiring the two route files do today.
  - Rewire `blast/routes.ts:18` and `smart-diff/routes.ts:18` to `const service = app.container.blast;` / `app.container.smartDiff;`. Routes reaching the container is legal at the delivery ring (`onion-architecture` §Enforcement allows `modules/*/routes.ts` → `platform/container.js`).
- **covers:** [AC-02]
- **skills:** [onion-architecture, fastify-best-practices]
- **Tests:** `server/test/blast-service.test.ts` and `server/test/smart-diff-helpers.test.ts` must stay green unchanged (the services' constructors and behaviour do not move). Add nothing here; AC-02 is completed by Task 8.
- **Verify:** `cd server && pnpm typecheck && pnpm test` · `cd server && ./node_modules/.bin/depcruise --config .dependency-cruiser.cjs src` reports no violations (**note:** run it this way — `pnpm arch` does not exist in `server/package.json` on `main`, per root `INSIGHTS.md`, *Tool & Library Notes*, 2026-08-14)

### Task 4 — `brief` module skeleton: `constants.ts` + `types.ts`

- **Module:** `server/` (pnpm). **Depends on:** Task 1.
- **Files:** new `server/src/modules/brief/constants.ts`, `server/src/modules/brief/types.ts`.
- **Do:** `constants.ts` holds **every** threshold this feature introduces, none inline anywhere else (AC-NF-12, mirroring `smart-diff/constants.ts` and `project-context/constants.ts`), each with a one-line comment naming the AC it comes from:
  ```
  BRIEF_MAX_INPUT_CHARS    = 24_000   // AC-NF-04 — assembled model input cap
  BRIEF_MAX_SPEC_DOCS      = 6        // AC-35
  BRIEF_MAX_SPEC_DOC_CHARS = 12_000   // AC-35 — combined, across documents
  BRIEF_MAX_TOKENS         = 1_500    // AC-NF-10
  BRIEF_TIMEOUT_MS         = 60_000   // AC-NF-10
  BRIEF_TEMPERATURE        = 0.1      // matches CLASSIFY_TEMPERATURE
  BRIEF_RATE_LIMIT         = { max: 10, timeWindow: '1 minute' } as const // AC-NF-06
  BRIEF_SCHEMA_NAME        = 'PrBriefDraft'  // AC-05 — targets MockLLMProvider.structuredBySchema
  BRIEF_SPEC_DOC_TYPE      = 'spec'   // AC-35 — ProjectContextDocType is z.string(), not an enum
  BRIEF_INPUT_PRIORITY     = [...] as const  // AC-NF-04 drop order, lowest priority last
  SEVERITY_RANK            = { high: 3, medium: 2, low: 1 } as const // AC-30
  ```
  `types.ts` declares the module's published surface: `BriefFacade { get(workspaceId, prId): Promise<PrBriefRecord | undefined>; generate(workspaceId, prId, opts: { force: boolean; logger: PinoLike; correlationId?: string }): Promise<PrBriefRecord>; }`. **`logger` is required, not optional** — AC-NF-05 is a SHALL ("the system SHALL record the model, the token counts and the cost of each brief generation"), and an optional `logger?` that some caller omits is a silent observability hole rather than a degraded mode; that exact bug already bit the intent classifier on the review path (`server/INSIGHTS.md`, *What Doesn't Work*, 2026-08-14). The route already has `req.log` in hand, and no other caller exists. Also in `types.ts`: the internal `BriefFacts` shape the prompt and the gate both consume (`{ pull, repo, changedPaths, intent, blast, smartDiff, docs, missing }`) and the narrow structural ports over `pullsRepo` / `reviewRepo` / `reposRepo` in the `SmartDiffPullsRepo` style (`server/INSIGHTS.md`, 2026-08-16) if the service needs them.
- **covers:** [AC-NF-12]
- **skills:** [onion-architecture, typescript-expert]
- **Tests:** none of its own — the constants are asserted through Tasks 5, 6, 8 and 9.
- **Verify:** `cd server && pnpm typecheck`

### Task 5 — `brief/helpers.ts` + `brief/grounding.ts` (pure core)

- **Module:** `server/` (pnpm). **Depends on:** Tasks 1, 4.
- **Files:** new `server/src/modules/brief/helpers.ts`, `server/src/modules/brief/grounding.ts`; new `server/test/brief-grounding.test.ts`.
- **Do:** no I/O, no container, no `process.env` — everything here is a pure function over fixtures.
  - `grounding.ts`: `groundBrief(draft, facts: { files: ReadonlySet<string>; endpoints: ReadonlySet<string> }): { risks: Risk[]; reviewFocus: BriefFocusItem[]; dropped: { target: 'risk' | 'file_ref' | 'endpoint_ref' | 'review_focus'; ref: string; reason: string }[] }`. Rules exactly as Decision 2 states them. The `dropped` shape mirrors `GroundingResult.dropped` (`reviewer-core/src/grounding.ts:19-21`) and exists so nothing goes silent (`reviewer-core/src/review/run.ts:111`).
  - `helpers.ts`:
    - `computeRiskLevel(risks: Risk[]): BriefRiskLevel` — max of `SEVERITY_RANK` over the **surviving** risks, `'none'` on an empty list. The model's own level is never an argument to this function; that is what makes AC-30 structural rather than disciplinary.
    - `selectSpecDocs(docs: ProjectContextDoc[]): ProjectContextDoc[]` — filter to `type === BRIEF_SPEC_DOC_TYPE`, sort by `path` (explicitly here, never relying on the adapter's ordering), take at most `BRIEF_MAX_SPEC_DOCS`, and stop before the document that would cross `BRIEF_MAX_SPEC_DOC_CHARS` — whole documents only.
    - `fitToBudget(sections: { priority: number; text: string }[]): { kept: …; droppedPriorities: number[] }` — drop **whole sections**, lowest priority first, until the join fits `BRIEF_MAX_INPUT_CHARS`. Priority 1 (PR title, number, head SHA, changed-path list) is never dropped, and nothing is ever truncated part-way. **The assembled `## Project context` block is ONE atomic input at the lowest priority and is dropped whole** — per-document culling belongs to `selectSpecDocs` (AC-35) and has already happened before `fitToBudget` is called. Two caps, two stages, in that order: `selectSpecDocs` enforces AC-35's 6-document / 12,000-character document budget by whole documents; `fitToBudget` then enforces AC-NF-04's 24,000-character prompt budget by whole inputs. `fitToBudget` never reaches inside the document section, which is what makes "SHALL drop whole inputs … SHALL NOT truncate an input part-way" literally true of both stages.
    - `toMissingInputs(...)` / `toDegraded(missing)` — `degraded === missing_inputs.length > 0`. **Availability only:** a budget-driven drop (AC-NF-04) is *not* a `missing_input`, and an empty spec-document list produces no entry (AC-36).
- **covers:** [AC-06, AC-07, AC-08, AC-09, AC-30, AC-31, AC-35, AC-36, AC-44, AC-NF-04]
- **skills:** [onion-architecture, zod, typescript-expert]
- **Tests:** `server/test/brief-grounding.test.ts`, hermetic, **no mocks** (the pure-core rule): an invented `file_refs` path is stripped and recorded; a risk citing only invented paths is dropped whole and recorded; a `review_focus` item naming a file outside the inputs is dropped and recorded; **a risk whose `file_refs` are all valid but whose `endpoint_refs` name an endpoint absent from the blast set has that ref removed and recorded** — the stub must actually populate `endpoint_refs`, because a draft that omits the field never executes the filtering branch and the test then proves nothing (AC-08); `computeRiskLevel` returns `'high'` for surviving `{high, low}`, `'low'` for surviving `{low}`, `'none'` for `[]` — note the function takes no `risk_level` parameter at all, which is the *structural* half of AC-30; the "the model's value is discarded" half is asserted at the service ring in Task 8 (AC-30, AC-31); a `docs/` document is excluded, the 7th spec is excluded, and an over-cap set truncates by whole documents (AC-35); an oversized section set drops the whole `## Project context` section, then history, then the per-symbol downstream detail — never truncating a section and never dropping priority 1 (AC-NF-04).
- **Verify:** `cd server && pnpm typecheck && pnpm test -- brief-grounding`

### Task 6 — `brief/prompt.ts`

- **Module:** `server/` (pnpm). **Depends on:** Tasks 4, 5.
- **Files:** new `server/src/modules/brief/prompt.ts`; new `server/test/brief-prompt.test.ts`.
- **Do:** model on `server/src/modules/intent/prompt.ts`.
  - `BriefDraftSchema` — the structured-output schema, brief-local, never a wire type: `{ what, why, risks: [{ kind, title, explanation, file_refs, endpoint_refs, severity }], review_focus: [{ file, line?, reason }], risk_level }`. **Field order is generation order** (`server/INSIGHTS.md`, *What Works*, 2026-08-05): `severity` comes last inside a risk, and `risk_level` last overall — the model commits to the evidence before it scores it. The server discards `risk_level` regardless (AC-30); asking for it costs a token and keeps the model from smuggling a level into prose.
  - `SYSTEM_PROMPT` — a brief-local constant. It must **not** instruct the model to produce findings, run a review, or emit a verdict (AC-26, and "a `risk_level` is not a verdict"), and it must carry its own injection-guard paragraph in the shape of `reviewer-core/src/prompt.ts:16-28`. *Interpretation note:* `INJECTION_GUARD` itself is module-private in `reviewer-core` and its text tells the model to "REPORT it as a finding with its true severity" — importing it would instruct the brief to do precisely what its Non-goals forbid. Exporting it from the engine was therefore rejected in favour of a brief-local guard; AC-NF-08 is satisfied by the delimiter discipline plus that guard, and AC-37's parenthetical citation of `INJECTION_GUARD` is read as naming the pattern, not mandating the import.
  - `buildUserPrompt(facts)` — assembles the sections in the input-priority order, `wrapUntrusted(label, text)` imported from `../../platform/prompt.js` (a legal *import* of the shim; only *editing* it is banned). Section names and rules:
    - `## Pull request` — repo, number, title (`wrapUntrusted('pr-title', …)`), head SHA. Never dropped.
    - `## PR description` — `wrapUntrusted('pr-description', …)`.
    - `## Derived intent & scope` — from the persisted record; includes `sources` entries of kind `linked_issue` as **`ref` + `status` only** (`#123`, `included`), never issue text (AC-34). No `container.github()` call exists anywhere in this module.
    - `## Blast radius` — the deterministic `summary` string, `changed_symbols`, then per-symbol `callers` / `endpoints_affected` / `crons_affected` as a lower-priority sub-section.
    - `## Changed files` — path, role (`core`/`wiring`/`boilerplate`), `+additions/-deletions` per file, plus `split_suggestion.total_lines` and `too_big`. **Paths and counts only.** The module reads `SmartDiffResponse`, which carries no `patch` field, so AC-03 is structural rather than disciplinary — never call `pullsRepo.getFiles()` for its `patch` column.
    - `## Prior PRs touching these files` — from `BlastPanel.history`.
    - `## Project context` — one `wrapUntrusted(doc.path, \`${doc.path}\n\n${doc.text}\`)` block per selected document, matching `assemblePrompt`'s specs convention (`reviewer-core/src/prompt.ts:127-133`) so a model can cite the document by path (AC-37).
- **covers:** [AC-03, AC-05, AC-34, AC-37, AC-NF-08]
- **skills:** [zod, onion-architecture, security]
- **Tests:** `server/test/brief-prompt.test.ts`, hermetic, fixtures only: the assembled prompt contains a sentinel string planted in a fixture `pr_files.patch` **nowhere** (AC-03); it contains `#123` and neither the fixture issue's title nor its body (AC-34); every `## Project context` document body sits inside `<untrusted source="…">` and the system prompt carries the guard paragraph (AC-37, AC-NF-08); the PR title and description are delimiter-wrapped (AC-NF-08); `BriefDraftSchema`'s key order puts `severity` last within a risk and `risk_level` last overall (AC-05's schema half); and **`BriefDraftSchema` parses a risk carrying `endpoint_refs: ['POST /x']`** — without that assertion the field could be silently absent from the schema, the model would never emit it, and Task 5's AC-08 gate would be dead code that its own test still passes (AC-08's schema half).
- **Verify:** `cd server && pnpm typecheck && pnpm test -- brief-prompt`

### Task 7 — `brief/repository.ts`

- **Module:** `server/` (pnpm). **Depends on:** Tasks 1, 2.
- **Files:** new `server/src/modules/brief/repository.ts`.
- **Do:** the only code that touches `pr_brief`. The brief module owns the table, so the repository is brief-local rather than a fourth aggregate on `ReviewRepository` (`onion-architecture`, promotion ladder stage 3: "the module owns tables"). Two domain-shaped methods:
  - `getBrief(prId): Promise<{ brief: Brief; headSha: string; model: string | null; generatedAt: Date } | undefined>` — **the query must select `head_sha`, `model` and `generated_at` alongside `json`**; a `db.select({ json: t.prBrief.json })` compiles fine, leaves `headSha` `undefined`, makes Task 8's `stored?.headSha === pull.headSha` cache check always false, and turns every single request into a paid model call — a silent, expensive failure no type error catches. Prefer a bare `db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId))` (all columns) over a projection, exactly as `getIntent` does at `modules/reviews/repository/pull.repo.ts:83`. Then `Brief.parse(row.json)` at the boundary so a legacy/garbage payload surfaces as a parse failure rather than a malformed response; Drizzle row types stop here.
  - `saveBrief(prId, { brief, headSha, model }): Promise<void>` — `insert(...).onConflictDoUpdate({ target: t.prBrief.prId, set: { json, headSha, model, generatedAt: new Date() } })`. **The upsert on the primary key is the whole answer to AC-25 and AC-42**: one row per PR, last writer wins, no accumulation per head SHA, and no lock needed — which matters because nothing in this server runs in a transaction (`server/INSIGHTS.md`, 2026-08-05). It is also a single write, which is what lets AC-15 hold: the row is only ever touched after the model call and the gate have both succeeded.
- **covers:** [AC-10, AC-25, AC-42, AC-43]
- **skills:** [drizzle-orm-patterns, onion-architecture, zod]
- **Tests:** none of its own; completed by Task 10's it-tests (never mock the database).
- **Verify:** `cd server && pnpm typecheck`

### Task 8 — `brief/service.ts` + `container.brief`

- **Module:** `server/` (pnpm). **Depends on:** Tasks 3, 4, 5, 6, 7.
- **Files:** new `server/src/modules/brief/service.ts`; `server/src/platform/container.ts`; new `server/test/helpers/brief.ts`; new `server/test/brief-service.test.ts`.
- **Do:** `export class BriefService implements BriefFacade { constructor(private container: Container) {} }` — the whole `Container`, matching `IntentService` and `ProjectContextService`. *Trade-off recorded:* `onion-architecture` prefers narrow deps for a **new** service, but `resolveFeatureModel(container, workspaceId, id)` takes a `Container` by signature (`modules/settings/feature-models.ts:52`), and this service legitimately touches eight capabilities (`pullsRepo`, `reviewRepo`, `reposRepo`, `blast`, `smartDiff`, `projectContextDocs`, `llm`, `tokenizer`) — a narrow port set would be eight interfaces plus a second seam for the model resolver, for no testing gain over `ContainerOverrides`.

  `get(workspaceId, prId)`:
  1. `pullsRepo.getPull(workspaceId, prId)` → `NotFoundError('Pull request not found')` on a miss (the `BlastService.get` precedent at `blast/service.ts:25`) — this is the whole of AC-13 and AC-NF-01 at the service ring.
  2. `briefRepo.getBrief(prId)`; `undefined` → return `undefined` (the route turns it into a 404).
  3. Return `{ pr_id, brief, head_sha: stored.headSha, pr_head_sha: pull.headSha, model, generated_at }`. **No model call, ever** (AC-40).

  `generate(workspaceId, prId, { force, logger, correlationId })` — `logger` is required (Task 4):
  1. Resolve the pull (404 as above) and its repo.
  2. `const stored = await briefRepo.getBrief(prId)`. If `!force && stored?.headSha === pull.headSha` → return it unchanged, **without a model call** (AC-11).
  3. `const changedPaths = (await pullsRepo.getFiles(prId)).map((f) => f.path)` — the PR's **full** changed-path list, the `BlastService.get` move at `blast/service.ts:27`. Map to `path` on the same line and never read `.patch`, which is what keeps AC-03 structural. **If `changedPaths` is empty, return here: no model call, and no other input gathered.** A file-less PR must cost nothing, so this guard sits before blast, intent, documents *and* smart-diff rather than after any of them (AC-14).
  4. Gather the rest, all best-effort — each failure becomes a `missing_inputs` entry rather than a throw (the `run-executor.ts:196-245` house pattern):
     - `container.smartDiff.get(workspaceId, prId)` — per-file `core`/`wiring`/`boilerplate` roles, `additions`/`deletions`, `split_suggestion`. **Classification and stats only.** A throw → `{ kind: 'smart_diff', status: 'unreachable' }`.
     - `container.reviewRepo.getIntent(prId)` — the persisted record, read directly. This is the intent module's own read path: `IntentService.get` is itself `return this.container.reviewRepo.getIntent(prId)` (`modules/intent/service.ts:46`), so nothing is duplicated and no new facade method is needed. **`container.intent.getOrClassify` is never called from this module** (AC-29); assert that by never importing the intent facade at all. Absent row → `{ kind: 'intent', status: 'absent' }`.
     - `container.blast.get(workspaceId, prId)` — summary, symbols, downstream, history. `BlastPanel.degraded === true` → `{ kind: 'blast', status: 'degraded' }`; a throw → `{ kind: 'blast', status: 'unreachable' }`.
     - Documents: `reposRepo.getSearchRoots(workspaceId, pull.repoId)` falling back to `DEFAULT_SEARCH_ROOTS`, then `projectContextDocs.list(ref, roots)` → `selectSpecDocs` → `projectContextDocs.read` per survivor. **The whole document step, `getSearchRoots` included, sits inside one `try`** — an unwrapped `getSearchRoots` throw would fail the entire generate and break the best-effort contract AC-32 rests on. Any throw in this step → `{ kind: 'project_context', status: 'unreachable' }` and continue with an empty document list; an **empty** result with no throw → no entry at all (AC-36).

     Each source is called **exactly once** per generate (AC-02).
  5. `fitToBudget` over the assembled sections (AC-NF-04), then `buildUserPrompt`.
  6. `resolveFeatureModel(this.container, workspaceId, 'risk_brief')` → `container.llm(choice.provider)` → **one** `completeStructured({ model, schema: BriefDraftSchema, schemaName: BRIEF_SCHEMA_NAME, messages: [system, user], temperature: BRIEF_TEMPERATURE, maxTokens: BRIEF_MAX_TOKENS, timeoutMs: BRIEF_TIMEOUT_MS })` (AC-04, AC-05, AC-NF-03, AC-NF-10). A throw propagates — nothing is written, so a previously persisted brief is untouched (AC-15).
  7. `groundBrief(draft, { files, endpoints })`. **`files` is `new Set(changedPaths)` from step 3 — the PR's full changed-path list, NOT the smart-diff path set.** Smart Diff may legitimately omit a changed file (binary, oversized, unparseable), so grounding against its output would drop a risk citing a real-but-unclassified file — a false drop the reviewer never sees. Smart Diff contributes classification and stats to the prompt; it does not define the grounding universe (AC-06, AC-07). `endpoints` is the union of `blast.downstream[].endpoints_affected` (AC-08). **Then** `computeRiskLevel(kept.risks)`, discarding `draft.risk_level` (AC-30, AC-31). Order matters: gate first, level second.
  8. `briefRepo.saveBrief(...)` — the single write (AC-10, AC-25, AC-42).
  9. Emit **one** structured log line `'brief: generated'` via `logger.info`, built with `describeSections` from `platform/prompt-log.ts` plus `{ feature: 'risk_brief', model, provider, tokens_in, tokens_out, cost_usd, missing_inputs, dropped: groundingResult.dropped }`. **Log the full `{ target, ref, reason }` drop records, not counts.** A count says something was caught but not what, which defeats AC-09's purpose — the whole reason the gate records reasons rather than a tally (`reviewer-core/src/grounding.ts:19-21`). This does **not** weaken AC-NF-02: a `ref` is a file path, an endpoint string or a focus-item file — identifiers, the same class `IntentSource.ref` already logs ("Human-readable reference … never content", `contracts/brief.ts:38`) — and a `reason` is one of a fixed set of gate strings. Stated here so a later reader does not "fix" it back to counts. `describeSections`' return types have no field able to hold section content, which is what makes the prompt half of AC-NF-02 structural. **Never log** a title, body, document, prompt section or model output. Model on `intent/service.ts:109-136`.
  10. Return the same envelope shape as `get`.

  Container: `import type { BriefFacade } from '../modules/brief/types.js'`, `import { BriefService }`, add `brief?: BriefFacade` to `ContainerOverrides`, add a lazy `get brief(): BriefFacade` getter.
- **covers:** [AC-01, AC-02, AC-03, AC-04, AC-05, AC-06, AC-07, AC-08, AC-10, AC-11, AC-12, AC-13, AC-14, AC-15, AC-26, AC-29, AC-30, AC-31, AC-32, AC-35, AC-36, AC-40, AC-NF-01, AC-NF-02, AC-NF-03, AC-NF-04, AC-NF-05, AC-NF-10, AC-NF-11]
- **skills:** [onion-architecture, zod, fastify-best-practices, drizzle-orm-patterns]
- **Tests:** `server/test/helpers/brief.ts` — a hermetic harness in the shape of `test/helpers/run-executor.ts` (object-literal container cast through `never`, because `Container` has private fields and TypeScript compares those nominally — `server/INSIGHTS.md`, 2026-08-17). **Every** dependency is wired and resolves to empty by default — `blast` returns an empty non-degraded panel, `smartDiff` returns empty groups, `projectContextDocs` is a `MockProjectContextDocs`, `reviewRepo.getIntent` resolves `undefined`, `llm` is a `MockLLMProvider` keyed by `structuredBySchema['PrBriefDraft']`, `tokenizer.count` is a spy — **never absent**, or a best-effort `catch` swallows `Cannot read properties of undefined` and the test proves nothing (`server/INSIGHTS.md`, 2026-08-28). Include a chainable `db.select().from().where()` stub returning the `settings` rows a case needs, so `resolveFeatureModel` runs for real.

  `server/test/brief-service.test.ts` asserts: the response parses against `PrBriefRecord` (AC-01); each input source is called exactly once (AC-02); the captured prompt holds no fixture patch sentinel (AC-03); `llm.calls.filter(c => c.method === 'completeStructured').length === 1` across a full generate (AC-04) and carries `schemaName: 'PrBriefDraft'`, `maxTokens: 1500`, `timeoutMs: 60000` (AC-05, AC-NF-10); **a risk citing a real changed file that Smart Diff did not classify survives** while an invented path is stripped from the stored payload (AC-06) — the first half is what proves the grounding universe is the PR's changed-path list, not the classifier's subset; an invented focus file's item is gone (AC-07); **a risk whose `file_refs` are all valid but whose `endpoint_refs` is `['POST /nonexistent']` is dropped, with the drop recorded** — stub the field explicitly, or the filtering branch never runs (AC-08); a second `generate` at the same head SHA leaves `llm.calls` unchanged (AC-11) while `{force:true}` adds exactly one (AC-12); an unknown PR rejects with `NotFoundError` and a PR from another workspace does likewise (AC-13, AC-NF-01); **a PR with no `pr_files` rows leaves `llm.calls` empty AND leaves the `blast`, `smartDiff` and `projectContextDocs` spies uncalled** — the early return is a cost guard, so proving nothing was gathered is the point (AC-14); an injected provider error propagates and `saveBrief` was never called (AC-15); `reviewRepo.insertReview` / `insertFindings` / `createAgentRun` and `container.reviewRunner` are never invoked — the hermetic equivalent of "row counts unchanged" (AC-26); the intent facade's `getOrClassify` spy is never called and `llm.calls.length` stays 1 even with no `pr_intent` row (AC-29); **the model returns `risk_level: 'none'` while a `high` risk survives grounding, and the stored level is `'high'`** — a stub that merely *disagrees downward* cannot distinguish "recomputed" from "coincidentally overridden", so the stub must contradict the computed answer in the direction the model would benefit from (AC-30), and zero survivors yields `'none'` (AC-31); absent intent / degraded blast / unreachable documents each produce the right `missing_inputs` entry and set `degraded`, **including a `getSearchRoots` that throws, which must yield `{kind:'project_context', status:'unreachable'}` and still return a brief** (AC-32), while a repo with no spec docs does neither (AC-36); a `docs/` document, the 7th spec and an over-cap set behave per AC-35; both head SHAs come back on a stale hit with `llm.calls` unchanged (AC-40); a workspace override for `risk_brief` is honoured and its absence resolves `openai`/`gpt-4.1` (AC-NF-03), with a companion assertion pinning `FEATURE_MODELS`' `risk_brief` entry and `FeatureModelId`'s five members (AC-NF-11); the captured log line contains the model, token counts, cost and the full `dropped` records (AC-NF-05, AC-09) and no section text, PR body, issue text or document content (AC-NF-02); an oversized fixture still produces a brief with the whole `## Project context` section gone and nothing truncated (AC-NF-04).
- **Verify:** `cd server && pnpm typecheck && pnpm test -- brief-service`

### Task 9 — `brief/routes.ts` + module registration

- **Module:** `server/` (pnpm). **Depends on:** Tasks 1, 8.
- **Files:** new `server/src/modules/brief/routes.ts`; `server/src/modules/index.ts`; new `server/test/brief-routes.test.ts`.
- **Do:** mirror `intent/routes.ts:22-47` exactly, including its comment that both routes declare `schema.response` — "the serializer strips anything the handler did not promise (an output allowlist, not a formality)".
  ```
  GET  /pulls/:id/brief   schema: { params: IdParams, response: { 200: PrBriefRecord } }
  POST /pulls/:id/brief   schema: { params: IdParams,
                                    querystring: z.object({ force: z.enum(['true','false']).default('false') }),
                                    response: { 200: PrBriefRecord } },
                          config: { rateLimit: BRIEF_RATE_LIMIT }
  ```
  Both resolve tenancy through `getContext(app.container, req)` and delegate to `app.container.brief`. `GET` throws `NotFoundError('Brief not generated yet')` when the service returns `undefined`; the single error handler in `app.ts` maps it (AC-39's server half). `POST` passes `req.log` and `req.id` as logger/correlation id, exactly as `intent/routes.ts:45` does. Handlers parse, resolve context, delegate and map — no queries, no error bodies built by hand.

  **Registration is its own line item:** add `import brief from './brief/routes.js';` and a `brief,` entry to the `modules` record in `server/src/modules/index.ts` (`server/CLAUDE.md` §Conventions — registration is static, not autoloaded).
- **covers:** [AC-01, AC-12, AC-13, AC-39, AC-40, AC-NF-06, AC-NF-07]
- **skills:** [fastify-best-practices, zod, onion-architecture]
- **Tests:** `server/test/brief-routes.test.ts`, hermetic, via `buildApp({ config, overrides: { auth: new MockAuthProvider(), brief: fakeFacade } })` — the `routes-smoke.test.ts` pattern; `MockAuthProvider` is required because `LocalNoAuthProvider` hits the DB. Assert: `GET` on a PR with no brief → 404 with the shared error envelope (AC-39); the facade throwing `NotFoundError` → 404 (AC-13); a 200 body parses against `PrBriefRecord` and carries both `head_sha` and `pr_head_sha` (AC-01, AC-40); a facade that returns an extra field has it **stripped** from the wire body (AC-NF-07); `POST …?force=true` reaches the facade with `force: true` and a bare `POST` with `force: false` (AC-12); an invalid uuid `:id` → 422.

  **AC-NF-06 needs a different app build, and this is the trap:** `app.ts:94-97` registers `@fastify/rate-limit` **only when `config.nodeEnv !== 'test'`**, so a route's `config.rateLimit` is inert under the config every other test uses. Build this one case with `loadConfig({ ...process.env, NODE_ENV: 'development', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv)` — `logLevel === 'silent'` keeps `logger: false` so no pino-pretty transport spins up — then inject 11 `POST`s at the same route on a fresh app instance and expect the 11th to be `429`.
- **Verify:** `cd server && pnpm typecheck && pnpm test -- brief-routes` · `cd server && ./node_modules/.bin/depcruise --config .dependency-cruiser.cjs src`

### Task 10 — DB-backed integration tests (`brief.it.test.ts`)

- **Module:** `server/` (pnpm). **Depends on:** Tasks 2, 7, 8, 9.
- **Files:** new `server/test/brief.it.test.ts`.
- **Do:** model on `server/test/blast.it.test.ts` — `startPg()` + `dockerAvailable()` gate, `buildApp` over the real Drizzle handle, real `pull_requests` / `pr_files` / `pr_intent` / `pr_brief`, with `blast` / `smartDiff` / `projectContextDocs` / `llm` injected through `ContainerOverrides`. **Override every LLM provider id the path could resolve** (`llm: { openai, anthropic, openrouter }`), because an it-test that triggers a feature model call otherwise falls through to a real adapter on any machine holding keys in `~/.devdigest/secrets.json` (`server/INSIGHTS.md`, *Recurring Errors & Fixes*, 2026-08-14). Cases:
  - `POST` then `select … from pr_brief where pr_id = …` returns exactly one row (AC-10).
  - `select … where head_sha = <sha>` returns the row — the cache key is a column, not a jsonb path (AC-43).
  - Three regenerations across two head SHAs leave `count(*) = 1` (AC-42).
  - Two concurrent `POST …?force=true` (`Promise.all` over two `app.inject`s) leave exactly one row, the payloads do not interleave, and `llm.calls` grows by **exactly 2** — not "at most 2", which also passes at 0 or 1 and would silently accept a deadlock or a swallowed request. Assert alongside it that **both responses carry a `generated_at` newer than the pre-test timestamp**, proving neither was served from cache: two forced regenerations are two charged calls, and AC-25's "no more than the model calls those requests were each charged for" is an upper bound on a number the test must first pin from below (AC-25).
  - `delete from pull_requests where id = …` removes the `pr_brief` row via the existing `ON DELETE CASCADE` (AC-27).
  - Generate; then re-`upsertIntent`, mutate the document fixture, and insert a review + findings; `GET` still reports `head_sha === pr_head_sha` and the payload is byte-identical (AC-41). **Mechanism for the document mutation:** construct the `MockProjectContextDocs` over a `let files: Record<string, string>` the test owns, and reassign that variable between the generate step and the verify step (or call the mock's own `set(path, content)` / `delete(path)` methods, which exist for exactly this — `src/adapters/mocks.ts:351-358`). Re-instantiating the mock would not work: the container getter memoizes the override for the app's lifetime.
  - A `GET` and a `POST` for a PR belonging to a second workspace both 404 (AC-NF-01).
- **covers:** [AC-10, AC-25, AC-27, AC-41, AC-42, AC-43, AC-NF-01]
- **skills:** [drizzle-orm-patterns, postgresql-table-design, fastify-best-practices]
- **Verify:** `cd server && pnpm test -- brief.it` — and confirm it actually **ran**: a green `pnpm test` on a machine without a Docker daemon means every `*.it.test.ts` self-skipped (`server/INSIGHTS.md`, 2026-07-29). Check the reporter for skipped suites.

### Task 11 — the inertness test: nothing generates a brief as a side effect

- **Module:** `server/` (pnpm). **Depends on:** Tasks 8, 9.
- **Files:** new `server/test/brief-inert.test.ts`; possibly a small extension to `server/test/helpers/run-executor.ts`'s `HarnessOptions.container` passthrough.
- **Do:** the spec's `## How it is checked` assigns AC-38 to a hermetic test, and the only way to make that non-vacuous is to give it a real seam. Wire a `BriefFacade` onto the harness container that is **present and resolving to empty** (`{ get: async () => undefined, generate: async () => EMPTY_RECORD }`) — an absent facade lets a best-effort `try/catch` swallow `Cannot read properties of undefined` and the test proves nothing (`server/INSIGHTS.md`, 2026-08-28). Then drive (a) a full `ReviewRunExecutor` run via `test/helpers/run-executor.ts`, and (b) the PR-sync path via `container.pullsRepo.replaceDetail` / the pulls service, and assert the two things AC-38 actually protects:
  1. **No structured completion with `schemaName: 'PrBriefDraft'` occurred** — `llm.calls.filter(c => c.method === 'completeStructured' && (c.req as StructuredRequest<unknown>).schemaName === 'PrBriefDraft')` is empty. The review run makes its own model calls, so the filter has to be on the schema name, not on `calls.length`.
  2. **`briefRepo.saveBrief` was never called.**

  Do **not** spy on `BriefFacade.generate` instead: it false-positives (a cache-hit `generate` returns the stored brief and spends nothing, yet trips the spy) and false-negatives (a future path calling `BriefService` directly rather than through the facade slips past it). The paid call and the write are what "SHALL NOT generate a brief as a side effect" means; assert those. If someone later wires the brief into either path, both assertions fail — which is the entire point.
- **covers:** [AC-26, AC-38]
- **skills:** [onion-architecture]
- **Verify:** `cd server && pnpm typecheck && pnpm test -- brief-inert`

### Task 12 — rewrite `client/messages/en/brief.json`

- **Module:** `client/` (pnpm). **Depends on:** nothing.
- **Files:** `client/messages/en/brief.json`; new `client/src/app/repos/[repoId]/pulls/[number]/_components/PrBriefCard/messages.test.ts` (or fold the key-absence assertions into Task 14's test file).
- **Do:** apply the spec's key table verbatim — it is the resolution of AC-28 and is not open to re-derivation.
  - **Keep as-is:** `block.risks`, `noRisks`, `unavailable`.
  - **Rewrite:** `unavailableHint` — the current "Run a review or open the PR to compute it." is factually wrong under AC-38; replace with copy that says generation is an explicit action on this card.
  - **Remove:** `block.intent`, `block.blast`, `block.history`, `noHistory`, `overlap`, and the entire `why` object (`why.title` "git-why", `why.blame`, `why.noHistory`, `why.noCommits` — an unrelated git-blame feature).
  - **Add:** `what`, `why` (the brief's own "why", a plain string key — note it replaces the removed `why` **object**, so this is a type change in the namespace, not an addition beside it), the four risk-level labels, review-focus heading and item affordance, generate, regenerate, pending, outdated, degraded (including a "which inputs were unavailable" template taking the input names), and provenance ("Generated by {model} · {when}").
  - Every added string must describe only what this card does. Nothing may claim a review, a verdict, a score, or automatic computation. This is the third time this repo has had to rewrite over-promising copy (`skills.json`, root `INSIGHTS.md` 2026-08-05; `context.json`, `specs/03-project-context-folder.md` AC-33).
  - `loadMessages` reads **every** file in `messages/en/` (`client/src/i18n/request.ts:17-26`), so no registration step exists — the file ships as soon as it is saved.
- **covers:** [AC-23, AC-28, AC-33]
- **skills:** [frontend-ui-architecture]
- **Tests:** a plain assertion over the parsed JSON, not an RTL render: import `brief.json` and assert `typeof msgs.why === "string"`; that `block.intent`, `block.blast`, `block.history`, `noHistory` and `overlap` are each `undefined`; and — separately, because `why` changing from object to string does not by itself prove the old leaves are gone — that **`msgs.why.title`, `msgs.why.blame`, `msgs.why.noHistory` and `msgs.why.noCommits` are each `undefined`**. A namespace that shipped both shapes would satisfy the first assertion and still leave the git-blame copy AC-28 removes (AC-28).
- **Verify:** `cd client && pnpm typecheck && pnpm test`

### Task 13 — `client/src/lib/hooks/brief.ts`

- **Module:** `client/` (pnpm). **Depends on:** Task 1.
- **Files:** new `client/src/lib/hooks/brief.ts`; `client/src/lib/hooks/index.ts` (add `export * from "./brief";` beside `"./blast"`).
- **Do:** components never fetch and never name a query key (`frontend-ui-architecture` §Business Logic Placement).
  - `usePrBrief(prId)` — `queryKey: ["pr-brief", prId]`, `api.get<PrBriefRecord>(\`/pulls/${prId}/brief\`)`, **404 → `null`**, everything else rethrows. This is the `usePrIntent` pattern verbatim (`client/src/lib/hooks/intent.ts:13-27`): a 404 is an empty state the card renders a CTA for, not an error (AC-39, AC-NF-09).
  - `useGenerateBrief(prId)` — `useMutation` over `(vars?: { force?: boolean }) => api.post<PrBriefRecord>(\`/pulls/${prId}/brief${vars?.force ? "?force=true" : ""}\`)`, `onSuccess` seeds the cache with `qc.setQueryData(["pr-brief", prId], record)` rather than triggering a refetch — the response *is* the fresh record, and a refetch would be a second HTTP round trip for data already in hand. One mutation hook serves both the generate and regenerate controls; the card differentiates them, not the data layer. `isPending` drives AC-21.
  - **Key choice, and why it is load-bearing:** `["pr-brief", prId]` is its own top-level key, deliberately **not** the `["reviews", prId]` prefix `useSmartDiff` piggybacks on (`client/INSIGHTS.md`, 2026-08-16). AC-41 says a new review must **not** change the brief's currency, so riding review invalidations would be wrong behaviour, not merely a wasted refetch. Document that reasoning in the file, as `hooks/blast.ts` documents its own.
- **covers:** [AC-21, AC-22, AC-39, AC-41, AC-NF-09]
- **skills:** [react-best-practices, frontend-ui-architecture, next-best-practices]
- **Tests:** none of its own — exercised through Task 14's component tests (`react-testing-library`: "if a hook just fetches data or manages simple state, test it through the component that uses it").
- **Verify:** `cd client && pnpm typecheck`

### Task 14 — `PrBriefCard`

- **Module:** `client/` (pnpm). **Depends on:** Tasks 1, 12, 13.
- **Files:** new `client/src/app/repos/[repoId]/pulls/[number]/_components/PrBriefCard/{PrBriefCard.tsx, constants.ts, styles.ts, index.ts, PrBriefCard.test.tsx}`.
- **Do:** a route-private `_components/` folder with a single forwarder `index.ts` — the shape every sibling card uses. Model the component on `IntentCard.tsx`: a `'use client'` leaf, `useTranslations("brief")`, a private `CardShell` and private `RiskItem` / `FocusItem` subcomponents **in the same file** (exactly one parent — `frontend-ui-architecture`: one component per file is not a rule). Props: `{ prId: string | null; onFocusFile: (file: string, line?: number | null) => void }`. **No `headSha` prop** — unlike `IntentCard`, which needs the page's head SHA because `PrIntentRecord` carries only its own, the `PrBriefRecord` envelope already carries **both** `head_sha` and `pr_head_sha` (that is why the contract has the second field), so the staleness comparison is entirely internal to the record. Threading a third source of the same fact would be a prop the component never reads.

  Mutually exclusive states as **separate early-return branches** sharing `CardShell`, never nested ternaries:
  - loading → skeleton rows;
  - error → an inline note (reached only on a non-404; a 404 is `null` data, not an error — AC-NF-09);
  - `record === null` → `EmptyState` with `t("unavailable")` / `t("unavailableHint")` and a single **Generate** CTA wired to `generate.mutate()`. **No mutation fires on mount** — the CTA's `onClick` is the only call site, and there is no `useEffect` anywhere in this component that calls a mutation (AC-16, and the `useEffect` anti-pattern the react skill names);
  - populated → the card.

  The populated card renders, in order: `what`; `why`; a risk-level badge using a `constants.ts` `as const` map from `BriefRiskLevel` → `{ labelKey, color }` (four entries, `none` included) — copy that reads as "how much attention this PR needs", **never** as approve / request-changes (AC-17); the risk list, or `t("noRisks")` when `risks` is empty, never an empty `<ul>` (AC-23); the review-focus list as `<button type="button">` controls, each showing its `reason` and its `file`, calling `onFocusFile(item.file, item.line ?? null)` (AC-18, AC-19's card half); a **Regenerate** control in the header slot that is visually and functionally distinct from the empty-state Generate CTA — different label, different placement, `kind="primary"` when outdated and `"ghost"` otherwise, following `IntentCard.tsx:113-125`'s reclassify button (AC-20); an outdated warning when `record.head_sha !== record.pr_head_sha`, following `IntentCard`'s stale block at :158-161 (AC-22); a degraded indication naming each `missing_inputs` entry by its localized kind (AC-33); and `t("generatedBy", { model, when })` (AC-45). While `generate.isPending`, both controls are `disabled` and show `loading`, so a second generation cannot start from this card (AC-21).
- **covers:** [AC-16, AC-17, AC-18, AC-19, AC-20, AC-21, AC-22, AC-23, AC-28, AC-33, AC-38, AC-39, AC-45, AC-NF-09]
- **skills:** [react-best-practices, frontend-ui-architecture, react-testing-library, next-best-practices]
- **Tests:** `PrBriefCard.test.tsx`, module-mocking `@/lib/hooks/brief` in the `BlastCard.test.tsx` style (a mutable `mockState` reset in `beforeEach`), wrapped in `NextIntlClientProvider` with the real `messages/en/brief.json`. **`fireEvent`, not `userEvent`** — see Constraints. Aim for a handful of flow tests, not one per assertion: (1) *no brief yet* — empty state renders, no error state, the generate spy is **not** called on mount, then clicking the CTA calls it once (AC-16, AC-39, AC-NF-09, AC-38's client half); (2) *populated* — risk level, `what`/`why`, provenance, focus items with reasons; clicking a focus item calls `onFocusFile` with `("src/a.ts", 12)` (AC-17, AC-18, AC-19, AC-45); (3) *edge states* — zero risks shows `t("noRisks")` and no list (AC-23), a head-SHA mismatch shows the outdated warning and offers regenerate (AC-22), `missing_inputs` are named (AC-33), `isPending` disables both controls (AC-21); (4) *controls* — the regenerate control is present and distinct from the empty-state CTA (AC-20). Add the `brief.json` key-absence assertions here if Task 12 did not create its own file (AC-28).
- **Verify:** `cd client && pnpm typecheck && pnpm test -- PrBriefCard`

### Task 15 — `OverviewTab` composition

- **Module:** `client/` (pnpm). **Depends on:** Task 14.
- **Files:** `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx`; `.../OverviewTab/OverviewTab.test.tsx`; possibly `.../OverviewTab/styles.ts`.
- **Do:** add `onFocusFile: (file: string, line?: number | null) => void` to `OverviewTabProps` and render `<PrBriefCard prId={prId} onFocusFile={onFocusFile} />` **above** the existing `s.briefGrid` (the brief is the summary the reviewer reads before the two detail cards). No `headSha` is passed — the brief envelope carries both SHAs itself (Task 14); `OverviewTab`'s existing `headSha` prop stays, because `IntentCard` still needs it. `IntentCard` and `BlastCard` are untouched and neither is replaced — that is an explicit spec Out.
- **covers:** [AC-19, AC-24]
- **skills:** [frontend-ui-architecture, react-best-practices, react-testing-library]
- **Tests:** extend `OverviewTab.test.tsx` — add the `@/lib/hooks/brief` module mock beside the existing `intent` / `blast` ones and the `brief` namespace to the `NextIntlClientProvider` messages; assert all three card titles plus the description render together (AC-24), and that a focus-item click propagates to the `onFocusFile` prop (AC-19's composition hop).
- **Verify:** `cd client && pnpm typecheck && pnpm test -- OverviewTab`

### Task 16 — the cross-tab deep link (page → DiffTab → SmartDiffViewer → FileCard)

- **Module:** `client/` (pnpm). **Depends on:** Task 15.
- **Files:** `client/src/app/repos/[repoId]/pulls/[number]/page.tsx`; `.../_components/DiffTab/DiffTab.tsx`; `.../_components/SmartDiffViewer/SmartDiffViewer.tsx`; `client/src/components/diff-viewer/FileCard/FileCard.tsx`; new `client/src/app/repos/[repoId]/pulls/[number]/page.test.tsx`; `.../SmartDiffViewer/SmartDiffViewer.test.tsx`; `client/src/components/diff-viewer/FileCard/FileCard.test.tsx`.
- **Do:** this is the only part of the feature that touches shared client machinery; everything else is additive. Four hops:
  1. **`page.tsx`** — add `setParams(entries: Record<string, string | null>)` that builds **one** `URLSearchParams` from `search` and calls `router.replace` **once**; re-express the existing `setParam` as `setParams({ [key]: val })` so `?trace=` behaviour is unchanged. Read `const focusFile = search.get("focus")`, `const focusLine = search.get("line")`. Pass `onFocusFile={(file, line) => setParams({ tab: "diff", focus: file, line: line != null ? String(line) : null })}` to `OverviewTab`, and `focus={focusFile ? { file: focusFile, line: focusLine != null ? Number(focusLine) : null } : null}` to `DiffTab`. *Why one call:* the existing `setParam` at :62-67 replaces the URL immediately, so three sequential calls each rebuild from the stale `search` object and only the last key survives. No tab whitelist exists on this page (`tab` falls back to `"overview"` at :60 and each tab is a `tab === "…"` branch at :137-175), so `client/INSIGHTS.md`'s 2026-08-29 double-whitelist trap does **not** apply here — recorded so nobody goes hunting for a `VALID_TABS` to update.
  2. **`DiffTab`** — accept `focus?: { file: string; line: number | null } | null` and forward it to `<SmartDiffViewer>`. Do not touch the `order === "original"` branch: AC-46's group-expansion outcome is a Smart Diff concept and `order` already defaults to `"smart"`.
  3. **`SmartDiffViewer`** — accept the same `focus` prop. Find the group whose `files` contain `focus.file`; if that role is in `collapsedRoles`, remove it (an effect on `focus?.file`, which is genuinely synchronizing UI state with an external navigation event, not derived state). Pass `focus` down to that one file's `FileCard` and `undefined` to every other. The `boilerplate` group's files start closed by `computeDefaultOpen` at :29-33 — that is precisely the collapsed case AC-46 names.
  4. **`FileCard`** — add `focus?: { line: number | null } | null`. An effect on `focus` calls `setOpen(true)` and, when `focus.line != null`, `setJumpLine(focus.line)`. The existing effect at :67-72 then does the `querySelector('[data-new-line="…"]')` + `scrollIntoView({ behavior: "smooth", block: "center" })`. `open` is `useState`-initialized from `defaultOpen`, so a changed `defaultOpen` alone would never reopen the card — the effect is what makes AC-46 work. No nonce/token param is needed: the card lives on the Overview tab, so re-activating the same item always crosses a `tab` change and remounts the viewer.
- **covers:** [AC-19, AC-46, AC-47]
- **skills:** [react-best-practices, frontend-ui-architecture, next-best-practices, react-testing-library]
- **Tests:**
  - New `page.test.tsx` — the page-level guard `client/INSIGHTS.md` (2026-08-29) prescribes: mock `next/navigation` (`useParams`/`useSearchParams`/`useRouter`), the app shell, the data hooks, and the tab components down to stubs (`({ focus }) => <div>focus: {focus?.file}</div>`). Assert that invoking `OverviewTab`'s `onFocusFile("src/a.ts", 12)` results in **one** `router.replace` whose URL carries `tab=diff`, `focus=src%2Fa.ts` and `line=12` together, and that with those params set the `DiffTab` stub receives the parsed focus object. This test **completes AC-19**.
  - `SmartDiffViewer.test.tsx` — with a `boilerplate`-classified target file, passing `focus` renders that file's contents (the group's file is expanded) while its siblings stay collapsed (AC-46).
  - `FileCard.test.tsx` — spy `Element.prototype.scrollIntoView` exactly as the existing test at :61-63,80 does; render with `defaultOpen: false` and a `focus={{ line: 3 }}`; assert the lines render and `scrollIntoView` was called with `{ behavior: "smooth", block: "center" }` (AC-47).
- **Verify:** `cd client && pnpm typecheck && pnpm test`

---

## AC coverage

| AC-ID | Tasks | Completed by | Verified by |
| ----- | ----- | ------------ | ----------- |
| AC-01 | 1, 8, 9 | 9 | `server/test/brief-routes.test.ts`, `server/test/brief-service.test.ts`, `server/test/contracts.test.ts` |
| AC-02 | 3, 8 | 8 | `server/test/brief-service.test.ts` |
| AC-03 | 6, 8 | 8 | `server/test/brief-prompt.test.ts`, `server/test/brief-service.test.ts` |
| AC-04 | 8 | 8 | `server/test/brief-service.test.ts` |
| AC-05 | 6, 8 | 8 | `server/test/brief-prompt.test.ts`, `server/test/brief-service.test.ts` |
| AC-06 | 5, 8 | 8 | `server/test/brief-grounding.test.ts`, `server/test/brief-service.test.ts` |
| AC-07 | 5, 8 | 8 | `server/test/brief-grounding.test.ts`, `server/test/brief-service.test.ts` |
| AC-08 | 5, 6, 8 | 8 | `server/test/brief-grounding.test.ts`, `server/test/brief-service.test.ts` |
| AC-09 | 5, 8 | 5 | `server/test/brief-grounding.test.ts` |
| AC-10 | 7, 8, 10 | 10 | `server/test/brief.it.test.ts` |
| AC-11 | 8 | 8 | `server/test/brief-service.test.ts` |
| AC-12 | 8, 9 | 8 | `server/test/brief-service.test.ts`, `server/test/brief-routes.test.ts` |
| AC-13 | 8, 9 | 9 | `server/test/brief-routes.test.ts` |
| AC-14 | 8 | 8 | `server/test/brief-service.test.ts` |
| AC-15 | 7, 8 | 8 | `server/test/brief-service.test.ts` |
| AC-16 | 14 | 14 | `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-17 | 14 | 14 | `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-18 | 14 | 14 | `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-19 | 14, 15, 16 | 16 | `client/…/pulls/[number]/page.test.tsx` |
| AC-20 | 14 | 14 | `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-21 | 13, 14 | 14 | `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-22 | 13, 14 | 14 | `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-23 | 12, 14 | 14 | `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-24 | 15 | 15 | `client/…/OverviewTab/OverviewTab.test.tsx` |
| AC-25 | 7, 10 | 10 | `server/test/brief.it.test.ts` |
| AC-26 | 8, 11 | 8 | `server/test/brief-service.test.ts`, `server/test/brief-inert.test.ts` |
| AC-27 | 2, 10 | 10 | `server/test/brief.it.test.ts` |
| AC-28 | 12, 14 | 12 | `client/…/PrBriefCard` messages assertions over `client/messages/en/brief.json` |
| AC-29 | 8 | 8 | `server/test/brief-service.test.ts` |
| AC-30 | 5, 8 | 8 | `server/test/brief-grounding.test.ts`, `server/test/brief-service.test.ts` |
| AC-31 | 5, 8 | 8 | `server/test/brief-grounding.test.ts`, `server/test/brief-service.test.ts` |
| AC-32 | 1, 5, 8 | 8 | `server/test/brief-service.test.ts` |
| AC-33 | 12, 14 | 14 | `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-34 | 6, 8 | 6 | `server/test/brief-prompt.test.ts` |
| AC-35 | 4, 5, 8 | 8 | `server/test/brief-grounding.test.ts`, `server/test/brief-service.test.ts` |
| AC-36 | 5, 8 | 8 | `server/test/brief-service.test.ts` |
| AC-37 | 6 | 6 | `server/test/brief-prompt.test.ts` |
| AC-38 | 11, 14 | 11 | `server/test/brief-inert.test.ts`, `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-39 | 9, 13, 14 | 14 | `server/test/brief-routes.test.ts`, `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-40 | 1, 8, 9 | 8 | `server/test/brief-service.test.ts`, `server/test/brief-routes.test.ts` |
| AC-41 | 10, 13 | 10 | `server/test/brief.it.test.ts` |
| AC-42 | 7, 10 | 10 | `server/test/brief.it.test.ts` |
| AC-43 | 2, 7, 10 | 10 | `server/test/brief.it.test.ts` |
| AC-44 | 1, 5, 8 | 5 | `server/test/contracts.test.ts`, `server/test/brief-grounding.test.ts` |
| AC-45 | 1, 14 | 14 | `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-46 | 16 | 16 | `client/…/SmartDiffViewer/SmartDiffViewer.test.tsx` |
| AC-47 | 16 | 16 | `client/src/components/diff-viewer/FileCard/FileCard.test.tsx` |
| AC-NF-01 | 8, 9, 10 | 10 | `server/test/brief.it.test.ts` |
| AC-NF-02 | 8 | 8 | `server/test/brief-service.test.ts` |
| AC-NF-03 | 8 | 8 | `server/test/brief-service.test.ts` |
| AC-NF-04 | 4, 5, 8 | 8 | `server/test/brief-grounding.test.ts`, `server/test/brief-service.test.ts` |
| AC-NF-05 | 8 | 8 | `server/test/brief-service.test.ts` |
| AC-NF-06 | 4, 9 | 9 | `server/test/brief-routes.test.ts` (non-`test` `NODE_ENV` app build) |
| AC-NF-07 | 9 | 9 | `server/test/brief-routes.test.ts` |
| AC-NF-08 | 6 | 6 | `server/test/brief-prompt.test.ts` |
| AC-NF-09 | 13, 14 | 14 | `client/…/PrBriefCard/PrBriefCard.test.tsx` |
| AC-NF-10 | 4, 8 | 8 | `server/test/brief-service.test.ts` |
| AC-NF-11 | 1, 8 | 8 | `server/test/brief-service.test.ts` |
| AC-NF-12 | 4 | 4 | code review against `server/src/modules/brief/constants.ts` |

59 rows, 59 AC-IDs, no blanks.

---

## Verification plan

In execution order. **`server/` and `client/` use pnpm; never npm in either.**

1. After Task 1 (contract): `cd server && pnpm typecheck` · `diff server/src/vendor/shared/contracts/brief.ts client/src/vendor/shared/contracts/brief.ts` (must be empty) · `cd client && pnpm typecheck` — the client typecheck is the only mechanism that catches an incomplete hand-mirror.
2. After Task 2 (migration): `cd server && pnpm typecheck` · `git diff server/src/db/migrations/meta/_journal.json` shows one appended entry only · `cd server && pnpm db:migrate` ends `✓ migrations applied`.
3. After Tasks 3–9 (each): `cd server && pnpm typecheck` then `cd server && pnpm test -- <the task's test file>`.
4. After Task 9: `cd server && ./node_modules/.bin/depcruise --config .dependency-cruiser.cjs src` — expect zero violations. Do **not** use `pnpm arch`; the script does not exist in `server/package.json` on `main`.
5. After Task 10: `cd server && pnpm test -- brief.it` — and confirm from the reporter that the suite **ran** rather than self-skipping for want of a Docker daemon.
6. After Task 11: `cd server && pnpm test` (full server suite, both lanes).
7. Type-check the new test files once, since `server/tsconfig.json` includes only `src/**/*.ts` and vitest's esbuild strips types without checking them:
   ```
   cd server && printf '{"extends":"./tsconfig.json","compilerOptions":{"noEmit":true},"include":["test/brief-service.test.ts","test/brief-grounding.test.ts","test/brief-prompt.test.ts","test/brief-routes.test.ts","test/brief.it.test.ts","test/brief-inert.test.ts","test/helpers/brief.ts","src/**/*.ts"]}' > .tsc-testcheck.json && ./node_modules/.bin/tsc --noEmit -p .tsc-testcheck.json; rm .tsc-testcheck.json
   ```
   (`src/**` must stay in `include` or the path aliases resolve against nothing.)
8. After Tasks 12–16 (each): `cd client && pnpm typecheck` then `cd client && pnpm test -- <the task's test file>`.
9. Final: `cd server && pnpm typecheck && pnpm test` · `cd client && pnpm typecheck && pnpm test && pnpm build`.
10. `reviewer-core/` and `e2e/` are untouched; do not run npm in either.

---

## Constraints & risks

**Ordering constraints that bind this plan.** The contract lands in `server/src/vendor/shared/` **and** its hand-mirror in `client/src/vendor/shared/` before any consumer (Task 1 gates Tasks 4–9 and 13–16). The schema change creates a **new** migration via `pnpm db:generate` + `pnpm db:migrate`; no existing migration file is edited, and migrations do not run on boot. The new module is registered in `server/src/modules/index.ts` as an explicit line item in Task 9. No new external dependency is introduced, so the port-first ladder does not apply — every input is already on the container (`pullsRepo`, `reviewRepo`, `reposRepo`, `projectContextDocs`, `llm`, `tokenizer`, plus the two facades Task 3 adds). No `pnpm arch` task exists in this plan.

**Architectural rules this plan is written against.**

- `no-cross-module-internals` (`server/.dependency-cruiser.cjs:29-40`): the brief imports no sibling module's `service.ts` / `repository.ts` / `helpers.ts` / `routes.ts`. Only `constants.ts` and `types.ts` cross module boundaries, with `settings/feature-models.ts` as the single sanctioned exception the service uses for `resolveFeatureModel`.
- `transport-never-queries`: `brief/routes.ts` imports neither `db/schema` nor `drizzle-orm`.
- `platform/grounding.ts`, `platform/prompt.ts`, `platform/structured.ts` are re-export shims — imported freely, edited never.
- Every route resolves tenancy through `getContext` and declares `schema.response`.

**Known dead ends this plan routes around.**

- A best-effort feature whose facade is **absent** from a test container passes vacuously (`server/INSIGHTS.md`, 2026-08-28). Tasks 8 and 11 wire every facade and have it resolve to empty.
- `pnpm db:generate` on a diverged journal rewrites committed history (`server/INSIGHTS.md`, 2026-08-05). Task 2 has a preflight and a post-check.
- An it-test that triggers a feature model call reaches a **real** provider on any machine with keys in `~/.devdigest/secrets.json` (`server/INSIGHTS.md`, 2026-08-14). Task 10 overrides all three provider ids.
- `*.it.test.ts` self-skips without Docker, so a green `pnpm test` is not proof the DB paths ran (`server/INSIGHTS.md`, 2026-07-29).
- `server/test/**` is not type-checked at all (`server/INSIGHTS.md`, 2026-08-17); step 7 of the Verification plan is the throwaway-config remedy.
- `@fastify/rate-limit` is **not registered under `NODE_ENV=test`** (`server/src/app.ts:94-97`), so a route's `config.rateLimit` is inert in every other test. Discovered while planning; Task 9's AC-NF-06 case builds its app with `NODE_ENV: 'development'`.

**Two skill/repo conflicts, resolved in favour of the repo.**

- `react-testing-library` says "NEVER `fireEvent` — always `userEvent`". `@testing-library/user-event` is **not a dependency of `client/`** (`client/INSIGHTS.md`, *Tool & Library Notes*, 2026-08-20; `BlastCard.test.tsx:6-9` says so in a comment), and the spec's Constraints section says the same. **All client tests use `fireEvent`. Do not add the package.**
- `onion-architecture` says a *new* service should take narrow dependencies, not the whole `Container`. `BriefService` takes the `Container` (Task 8) because `resolveFeatureModel` requires one; the trade-off is recorded in the task and in the file's header comment.

**Risks.**

- *AC-08's fit to the contract* is the weakest point in the plan — see Decision 2. **Maintainer ruling: the draft-only `endpoint_refs` mechanism is accepted.** It satisfies the AC structurally without changing the wire contract.
- *The grounding rule "a risk with no surviving `file_refs` is dropped"* is an inference from AC-06 + AC-09 + AC-31 rather than a literal reading of any one of them. **Maintainer ruling: accepted** — it matches the engine's "cite a real file or be dropped" precedent that AC-09 and AC-31 presuppose.
- *Task 16 touches shared client machinery* (`FileCard`, `SmartDiffViewer`, the PR page's query state) — the only non-additive part of the feature, and the one most likely to regress an existing test. Run the full `cd client && pnpm test` after it, not just the three touched files.
- *`brief.json`'s `why` key changes type* from an object (`why.title`, `why.blame`, …) to a string. Any stray consumer would break at build; there are none today (`client/messages/en/brief.json` has zero usages in `client/src`), but `pnpm build` in step 9 is the check.

## Technical open questions

**None.** Decisions 1–4 resolve the four the spec delegated; the two AC readings that required judgment carry maintainer rulings above.

---

## Revision log

**2026-08-29 — cross-family plan review.** `plans/04-pr-brief.plan.md` v1 was reviewed by
`deepseek/deepseek-v4-pro` via OpenRouter (a different model family from the one that wrote
both the spec and the plan). 20 findings returned; the maintainer triaged **14 accepted, 6
rejected**. Full triage with per-finding evidence: `plans/04-pr-brief.review-note.md`.

No finding challenged the feature's shape, the `@devdigest/shared` contract, the `head_sha`
cache key, or the architecture decisions (container facades, brief-local grounding, query-param
deep link). Every accepted finding was about **test rigour or a defensive gap** — eight of the
fourteen were tests that would have passed green without proving what their AC claims.

What changed in this revision:

| Fix | Task(s) | Change |
| --- | ------- | ------ |
| 1 | 5, 6, 8 | AC-08's endpoint gate could pass vacuously — a stubbed draft omitting `endpoint_refs` never runs the filter. Tests now stub `endpoint_refs: ['POST /nonexistent']` on a risk with all-valid `file_refs` and assert the risk is dropped; `brief-prompt.test.ts` asserts `BriefDraftSchema` parses the field at all. |
| 2 | 10 | AC-25 asserted `llm.calls` grows "by at most two", which also passes at 0 or 1. Now **exactly 2**, plus both responses carrying a fresh `generated_at`. |
| 3 | 5 | `fitToBudget` no longer culls individual documents. The assembled `## Project context` block is one atomic input at the lowest priority, dropped whole; per-document culling is `selectSpecDocs`'s job (AC-35), before budget fitting. |
| 4 | 5, 8 | AC-30's discard test now stubs `risk_level: 'none'` with surviving `high` risks and expects `'high'` — a downward disagreement could not distinguish "recomputed" from "coincidentally overridden". |
| 5 | 11 | AC-38 no longer spies on `BriefFacade.generate` (false-positives on a cache hit, false-negatives on a direct service call). It asserts no `PrBriefDraft` structured completion occurred and no `saveBrief` — the paid call and the write. |
| 6 | 8 | The zero-files early return moved ahead of **all** input gathering (step 3), not just ahead of blast/intent/documents. A file-less PR now costs nothing at all. |
| 7 | 8 | The grounding universe is the PR's **full** changed-path list (`pullsRepo.getFiles(prId).map(f => f.path)`), not the smart-diff path set, which can be a strict subset — a risk citing a real-but-unclassified file was being wrongly dropped. Smart Diff supplies classification and stats only. |
| 8 | 8 | The `brief: generated` log line carries the full `{ target, ref, reason }` drop records instead of counts; the AC-NF-02 justification (refs are identifiers, not content) is stated inline so it is not "fixed" back. |
| 9 | 12 | The `brief.json` check also asserts `why.title`, `why.blame`, `why.noHistory` and `why.noCommits` are `undefined`. |
| 10 | 14, 15 | `PrBriefCard`'s unread `headSha` prop removed from the component and the `OverviewTab` hop; the envelope already carries both SHAs. |
| 11 | 10 | AC-41's document mutation now has a stated mechanism — the test owns the `MockProjectContextDocs` backing record and reassigns it (or uses the mock's `set`/`delete`) between generate and verify. |
| 12 | 8 | `reposRepo.getSearchRoots` is inside the document step's `try`; a throw records `{ kind: 'project_context', status: 'unreachable' }` and generation continues with no documents. |
| 13 | 4, 8 | `logger` is **required** on `BriefFacade.generate`, so AC-NF-05's SHALL cannot silently not happen (the `intent/service.ts` optional-logger bug, `server/INSIGHTS.md` 2026-08-14). |
| 14 | 7 | `getBrief` explicitly selects `head_sha`, `model` and `generated_at` alongside `json` — a `select({ json })` would leave `headSha` undefined and force a paid model call on every request, with no type error. |

Six findings were rejected. Three were factual errors verified against source and would have
caused real damage if applied blind: that `container.projectContextDocs` is not on the container
(it is, `platform/container.ts:198`), that `resolveFeatureModel`'s signature might not match
(it does, `modules/settings/feature-models.ts:51-55`), and that `reviewRepo.getIntent` is an
invented path duplicating the intent module (`IntentService.get` *is* that call,
`modules/intent/service.ts:46`). The other three — the route throwing `NotFoundError` with its
own message, leaving `?focus=`/`?line=` in the URL, and the no-nonce deep-link reasoning — were
deliberate choices the note re-argues.

**Task numbering, task count, the AC coverage table and all 59 AC-IDs are unchanged.** Every fix
sharpened how a task is executed or verified; none moved an AC between tasks.
