# Eval Pipeline — regression protection for review agents

**Status:** draft
**Packages touched:** server, client
**Created:** 2026-08-29
**Supersedes:** None

## Problem

A maintainer who edits an agent's system prompt, swaps its model, or links a
skill has **no way to know whether the agent got better or worse**. The only
feedback loop today is anecdotal: run the changed agent on a live PR, eyeball
the findings, and pay for a model call every time. Nothing remembers what the
agent *used to* find, so a regression — a security reviewer that quietly stops
flagging leaked keys, or starts drowning users in noise — is invisible until a
user notices it on a real review.

Meanwhile the system already collects exactly the ground truth this needs and
throws it away as a UI state: every finding a user **accepts** is a labelled
true positive ("this agent must keep finding this"), and every finding a user
**dismisses** is a labelled false positive ("this agent must stop commenting on
this"). `server/src/modules/reviews/findings.ts:7-9` says so in as many words:
"These decisions are the dataset later lessons build on (eval cases from
accept/dismiss…)". This is that lesson.

The infrastructure is pre-staged and inert: `eval_cases` / `eval_runs` tables
exist and are empty (`server/src/db/schema/eval.ts`; listed among the twelve
lesson-staged tables in `server/INSIGHTS.md` *Codebase Patterns*, 2026-07-29),
base contracts exist (`contracts/knowledge.ts:50-85`), API shapes are sketched
(`contracts/eval-ci.ts:15-89`), an i18n namespace ships unused
(`client/messages/en/eval.json`), and the sidebar helper already maps `/eval`
(`client/src/components/app-shell/helpers.ts:35`).

What is missing is the loop: **finding → one-click eval case → frozen input →
batch run → mechanical score → comparable numbers across prompt versions.**

## Scope — in / out

**In**

- One-click eval-case creation from an accepted or dismissed finding, with the
  case's inputs frozen at creation time.
- Listing and deleting an agent's eval cases in a new **Evals** tab of the
  agent editor.
- `POST /agents/:id/eval-runs` — run the agent over **all** cases in its set,
  persisting one per-case result row per case under one shared batch identity.
- **Mechanical scoring, zero LLM calls**: file-equality + line-range-overlap
  matching, and the recall / precision / citation-accuracy formulas below,
  computed entirely in code.
- Run history per agent and a two-batch side-by-side comparison in the Evals
  tab.
- An **Eval Dashboard** page at `/eval`, linked from the left sidebar, showing
  recent eval runs across agents.
- The contract additions in `@devdigest/shared` (canonical copy first, client
  hand-mirror second) and the minimal `eval_runs` schema extension.
- A seed path producing ≥ 8 demo cases for a built-in agent.
- A `verify:l06` gate runnable as `pnpm verify:l06` from the repo root.
- Rewriting `client/messages/en/eval.json` to describe only what is built.

**Out**

- **Export-to-CI, `AgentManifest`, `ci_installations` / `ci_runs`.** Same
  contracts file (`contracts/eval-ci.ts:130-239`), different lesson feature;
  nothing here reads or writes them.
- **Skill-owned eval sets.** `EvalOwnerKind` keeps `'skill'`
  (`contracts/knowledge.ts:71`) and the schema stays contract-compatible with
  it, but no route or UI targets `owner_kind='skill'` — out because the
  homework's stories are all agent-scoped and a second owner surface doubles
  the UI for no dataset.
- **Any LLM-judge scoring.** A hard constraint, not a deferral: the agent
  execution calls the model, the scoring never does.
- **A manual eval-case editor** (hand-typed diff, editable expected-output
  JSON) and **a per-case run button**. Both are *proposed* by the pre-staged
  `eval.json` (`caseEditor.*`, `evalsTab.run`) — which root `INSIGHTS.md`
  (*Codebase Patterns*, 2026-08-05, refined 2026-08-29) says to treat as a past
  author's proposal, not a spec. Out because the dataset story is "your
  accept/dismiss decisions ARE the cases"; hand-authored cases dilute that, and
  a per-case run adds a second spend path for no metric.
- **A metric trend chart on the dashboard.** Also only proposed by the i18n
  file (`dashboard.metricTrend`). The two-batch comparison already answers
  "did the numbers move"; a chart can come later.
- **Conformance, compose, hooks, memory** — adjacent staged features in the
  same files; untouched.
- **MCP exposure.** `server/specs/01-mcp-server.md` fixes the tool set.
- **`e2e/` flows.** Done-ness is demonstrated through the server and client
  test lanes plus the seed path; a browser flow can follow once the surfaces
  are stable.

## Actors & triggers

**Case creation** — a maintainer, in the studio, on the PR detail page. The
precondition is a finding that has already been **accepted or dismissed**
(`FindingRecord.accepted_at` / `dismissed_at`,
`contracts/review-api.ts:15-20`); the decision *is* the label, so an undecided
finding offers no eval action. The case lands in the set of **the agent whose
review produced the finding** — no owner picker.

**Batch run** — a maintainer, explicitly, from the agent's Evals tab. Each
trigger is a paid action (one model call per case, on the agent's own model —
today all five configured agents run `deepseek/deepseek-v4-flash`, per the live
`devdigest_list_agents` read). Nothing runs evals on a schedule, on agent save,
or on render.

**Reading** — the Evals tab (cases, history, comparison) and the Eval
Dashboard page perform cached reads only and never spend money.

**Not a trigger:** a review run. Review execution and eval execution never
invoke each other.

## The dataset and the score — normative definitions

These definitions are the feature; they are stated here rather than left to
the plan because "scoring is 100% code" is only auditable if the code has a
spec to be audited against.

**Frozen case input.** At creation time the case stores, and every future run
reads *only*:

- the stored per-file diff fragment for the finding's file (the persisted
  `pr_files.patch` text — a valid unified-diff fragment, which is what lets
  the grounding gate build its line index over it);
- the PR's title and body as they were at creation time;
- the expectation (below);
- provenance: the source finding's id, plus repo/PR display references.

**Expectation** (stored in `expected_output`): `{ kind, file, start_line,
end_line }` where `kind` is `must_find` (born from an accepted finding) or
`must_not_flag` (born from a dismissed finding), and the file/range are the
source finding's citation.

**Match rule.** A finding matches an expectation **exactly when** the files
are equal and the line ranges `[start_line, end_line]` overlap. Severity,
category and title are deliberately not considered.

**Per-case execution.** The agent's *current* configuration — provider, model,
system prompt, and its enabled linked skills — is run through the review
engine over the frozen diff + meta, with the mandatory grounding gate applied
(`reviewer-core/src/grounding.ts`). Live-PR enrichments (intent, blast,
project context, repo map) are deliberately **not** assembled: they belong to
a live PR, and a case must produce the same prompt inputs on every run so that
two batches differ only by the agent's configuration.

**Per-case verdict.**

- `must_find` case: **pass** iff ≥ 1 finding *surviving the grounding gate*
  matches the expectation.
- `must_not_flag` case: **pass** iff **no** surviving finding matches the
  expectation.

**Batch metrics** (computed from raw counts across all non-errored case runs
in the batch, never by averaging per-case values):

- **recall** = passed `must_find` cases ÷ total `must_find` cases
  (1.0 when the batch has no `must_find` cases);
- **precision** = 1 − (noise ÷ surviving findings across the batch), where
  *noise* = surviving findings that match their own case's `must_not_flag`
  expectation (1.0 when the batch produced no surviving findings);
- **citation_accuracy** = surviving findings ÷ model-proposed findings across
  the batch (1.0 when the model proposed none). Only grounding-gate drops
  count against it; scope-filter drops do not (with no intent block in the
  prompt the scope filter is a no-op anyway,
  `contracts/findings.ts` `in_scope` note).

**Vocabulary note.** The pre-staged `eval_runs` table is **per-case** — one
row per case execution. This spec keeps that as given: a DB row is a *case
result*; the user-facing "eval run" is a **batch** — the set of case-result
rows sharing one `batch_id` (see Schema changes). History and comparison
operate on batches.

## Contract changes

Canonical copy first: `server/src/vendor/shared/`. Then the hand-mirror in
`client/src/vendor/shared/` — which for `contracts/eval-ci.ts` **already
lags** the canonical copy (root `INSIGHTS.md`, *What Doesn't Work*,
2026-07-29 + 2026-08-28 refinement). This change brings the mirrored
`contracts/eval-ci.ts` and `contracts/knowledge.ts` fully into sync; the
client typecheck is the mechanism that proves the copy complete.

**Reused unchanged.** `EvalOwnerKind`, `EvalCase`
(`contracts/knowledge.ts:71-85`) — `expected_output` is henceforth documented
as carrying an `EvalExpectation`, but the schema field stays `z.unknown()`.
The agent's own `Agent` / `AgentVersion` shapes are consumed as they stand.

**Left alone deliberately.** `EvalRun`, `EvalPerTrace`, `EvalCaseInput`,
`EvalRunResult`, `EvalTrendPoint`, `EvalDashboard`
(`contracts/knowledge.ts:51-69`, `contracts/eval-ci.ts:20-89`) — pre-staged
proposals this spec does not adopt (they model per-case runs, manual case
input, and a trend the dashboard does not build). They stay exported and
unused, the `PrBrief` precedent from `specs/04-pr-brief.md`.

**New / extended shapes** (field level; exact file placement within the
contracts barrel is the planner's choice):

- **`EvalExpectation`** — `{ kind: 'must_find' | 'must_not_flag', file:
  string, start_line: int, end_line: int }`. The shape inside
  `eval_cases.expected_output`.
- **`EvalRunRecord`** (`contracts/eval-ci.ts:33-46`) gains `batch_id: string`,
  `agent_version: number | null`, and `error: string | null` (null when the
  case executed; the failure message when it errored). Mirrors the extended
  row.
- **`EvalBatchSummary`** *(new)* — one batch, aggregated: `{ batch_id,
  agent_id, agent_version: number | null, model: string, ran_at, cases_total:
  int, cases_errored: int, cases_passed: int, recall, precision,
  citation_accuracy, duration_ms: int, cost_usd: number | null }`.
- **`EvalBatchDetail`** *(new)* — `EvalBatchSummary` plus `results:
  EvalRunRecord[]` (each carrying `case_id` and `case_name` so a comparison
  can align two batches case-by-case).
- **`EvalDashboardView`** *(new)* — `{ cases_total: int, recent: Array<
  EvalBatchSummary & { agent_name: string }> }`, newest first, capped.

## Routes

All routes are workspace-scoped, declare Zod `params`/`body` and
`schema.response` (the output-allowlist rule `specs/04-pr-brief.md`
AC-NF-07 established), and follow the existing path grammar
(`POST /findings/:id/(accept|dismiss)` at
`server/src/modules/reviews/routes.ts:144`; `/agents/:id/*` at
`server/src/modules/agents/routes.ts`).

- **`POST /findings/:id/eval-case`** — params `IdParams`, no body. Creates the
  eval case from the finding per the definitions above. `201` with the
  `EvalCase`; refusals per AC-05..AC-08.
- **`GET /agents/:id/eval-cases`** — the agent's case list, `EvalCase[]`.
- **`DELETE /eval-cases/:id`** — removes the case and its case-result rows.
- **`POST /agents/:id/eval-runs`** — runs the batch **synchronously** and
  returns `EvalBatchDetail`. Rate-limited (AC-NF-02): unlike the other paid
  routes, one request here is *N* model calls.
- **`GET /agents/:id/eval-runs`** — batch history, `EvalBatchSummary[]`,
  newest first.
- **`GET /agents/:id/eval-runs/:batchId`** — one batch, `EvalBatchDetail`
  (what the comparison view fetches twice).
- **`GET /eval/dashboard`** — `EvalDashboardView`.

Registration: one module plugin, one import + one `app.register` in
`server/src/modules/index.ts` (`server/CLAUDE.md` §Conventions). Which module
owns the `/findings/:id/eval-case` route (reviews-adjacent vs the new eval
module) is the planner's call; the path is the contract.

## Schema changes

The pre-staged tables are taken as given; **one minimal extension** to
`eval_runs` (`server/src/db/schema/eval.ts:22-35`), via `pnpm db:generate` →
`pnpm db:migrate`, add-only:

- `batch_id` — `uuid NOT NULL`. The grouping key that models a batch. Every
  case-result row written by one `POST /agents/:id/eval-runs` carries the same
  fresh `batch_id`. The table is empty in every real deployment (lesson-staged,
  never written), so `NOT NULL` needs no backfill.
- `agent_version` — `integer`, nullable. The agent's `version` at trigger
  time — what lets the comparison view label "v3 vs v5".

No `eval_batches` table. Rejected because the batch's aggregates are
derivable from its rows, a synchronous trigger needs no status column, and a
second table would be a second source of truth bolted onto a schema the lesson
says to take as given. The consequence is accepted and stated: a process crash
mid-batch leaves a batch with fewer rows than cases, not a wedged "running"
batch — there is no batch status to reap (AC-NF-11).

Indexes must cover the two hot reads — an agent's cases
(`eval_cases(owner_kind, owner_id)`) and a batch's rows / an agent's batch
history over `eval_runs` — because Postgres does not index FKs automatically
(`server/INSIGHTS.md`, 2026-08-05). Exact index set is the planner's choice.

Migration hazards to carry: `pnpm db:generate` on a diverged journal rewrites
committed history, and migrations do not run on boot
(`server/INSIGHTS.md` *What Doesn't Work* / *Tool & Library Notes*,
2026-08-05). This change only adds columns, so no interactive rename prompt.

## Adapters needed

**None.** Model calls go through the review engine with the injected
`LLMProvider` the container already resolves per provider; no GitHub call, no
filesystem, no new port. Hermetic tests use `MockLLMProvider`
(`server/src/adapters/mocks.ts`).

## Acceptance criteria

**Cases**

| ID | Criterion (EARS) | How it is checked |
| ----- | ---------------- | ----------------- |
| AC-01 | WHEN a maintainer creates an eval case from an **accepted** finding, the system SHALL create a case owned by the agent whose review produced the finding, with a `must_find` expectation carrying the finding's file and line range. | server hermetic test |
| AC-02 | WHEN a maintainer creates an eval case from a **dismissed** finding, the system SHALL create a case owned by that agent with a `must_not_flag` expectation carrying the finding's file and line range. | server hermetic test |
| AC-03 | WHEN a case is created, the system SHALL freeze into it the stored diff fragment for the finding's file, the pull request's title and body, and a provenance reference to the source finding. | server hermetic test (case payload asserted against the fixture's `pr_files.patch`) |
| AC-04 | WHILE a case exists, every eval execution of it SHALL read only the case's frozen inputs, regardless of later changes to the source pull request or its findings. | server hermetic test (mutate the PR after creation; the captured prompt is byte-identical across runs) |
| AC-05 | IF eval-case creation is requested for a finding that is neither accepted nor dismissed, THEN the system SHALL refuse and create nothing. | server hermetic test |
| AC-06 | IF a case already exists for the source finding, THEN the system SHALL refuse the duplicate and identify the existing case. | server hermetic test |
| AC-07 | IF no diff fragment is stored for the finding's file, THEN the system SHALL refuse with a distinct error and create nothing. | server hermetic test (fixture file with `patch = null`) |
| AC-08 | IF the agent that produced the finding cannot be resolved (deleted agent), THEN the system SHALL refuse and create nothing. | server hermetic test |
| AC-09 | WHEN a case is deleted, its per-case result rows SHALL be removed with it. | server `*.it.test.ts` (the existing `ON DELETE CASCADE`, `server/src/db/schema/eval.ts:24-26`) |
| AC-10 | WHEN the agent editor's Evals tab is opened, it SHALL list every case in the agent's set with its name, expectation kind, and file plus line range, and SHALL offer deletion per case. | client RTL |
| AC-11 | WHILE a finding is accepted or dismissed, the finding's card SHALL offer a single-activation eval-case control. | client RTL |
| AC-12 | WHILE a finding is neither accepted nor dismissed, the finding's card SHALL NOT offer an eval-case control. | client RTL |
| AC-13 | WHEN the eval-case control is activated, the system SHALL issue exactly one creation request and SHALL reflect the outcome — created, or already existing — without a page reload. | client RTL (`fireEvent`; mocked fetch counted) |

**Batch execution and scoring**

| ID | Criterion (EARS) | How it is checked |
| ----- | ---------------- | ----------------- |
| AC-14 | WHEN an eval run is triggered for an agent, the system SHALL execute the agent over every case in its set and persist one case-result row per case, all sharing one new batch identity. | server hermetic test (row set + shared `batch_id`) |
| AC-15 | WHEN a case is executed, the system SHALL call the model with the agent's current provider, model and system prompt, its enabled linked skills, and the case's frozen diff and PR meta — and with no live-PR enrichment. | server hermetic test (prompt captured by `MockLLMProvider`: skill body present, frozen diff present, no intent/blast/context sections) |
| AC-16 | WHEN a case execution returns findings, the system SHALL apply the mandatory citation-grounding gate before any scoring. | server hermetic test (stubbed output citing a line outside the frozen fragment is not scored as a match) |
| AC-17 | The system SHALL make exactly one model call per case in a batch and zero model calls for scoring. | server hermetic test (`MockLLMProvider.calls.length === cases_total`) |
| AC-18 | The system SHALL count a finding as matching an expectation exactly when the files are equal and the line ranges overlap, and SHALL NOT consider severity, category or title. | server hermetic test on the scorer (overlap / adjacency / other-file / severity-mismatch cases) |
| AC-19 | WHEN a `must_find` case is scored, it SHALL pass iff at least one surviving finding matches its expectation. | server hermetic test |
| AC-20 | WHEN a `must_not_flag` case is scored, it SHALL pass iff no surviving finding matches its expectation. | server hermetic test |
| AC-21 | WHEN a batch completes, its recall SHALL equal passed `must_find` cases divided by total `must_find` cases, and SHALL equal 1.0 when the batch has none. | server hermetic test |
| AC-22 | WHEN a batch completes, its precision SHALL equal 1 minus the share of surviving findings that match their own case's `must_not_flag` expectation, and SHALL equal 1.0 when the batch produced no surviving findings. | server hermetic test |
| AC-23 | WHEN a batch completes, its citation accuracy SHALL equal surviving findings divided by model-proposed findings across the batch, counting only grounding-gate drops, and SHALL equal 1.0 when none were proposed. | server hermetic test |
| AC-24 | The system SHALL compute batch metrics from raw counts across the batch's non-errored case runs, and SHALL NOT average per-case metric values. | server hermetic test (fixture where the two computations diverge) |
| AC-25 | WHEN a case run completes, its row SHALL record pass/fail, its own citation accuracy, its duration and its cost. | server hermetic test |
| AC-26 | WHEN a batch is triggered, the system SHALL record the agent's version and model at trigger time, and both SHALL be shown in run history and comparison. | server hermetic test + client RTL |
| AC-27 | IF a case's model call fails or times out, THEN the remaining cases SHALL still run, the errored case SHALL be recorded with its error and excluded from every metric denominator, and the batch result SHALL report the errored count. | server hermetic test (injected provider error on one case) |
| AC-28 | IF an eval run is triggered for an agent whose case set is empty, THEN the system SHALL refuse and make no model call. | server hermetic test |
| AC-29 | IF an eval run is triggered for an agent while another is already in flight for the same agent, THEN the system SHALL refuse the second without making any model call. | server hermetic test (two concurrent injected requests) |
| AC-30 | The system SHALL create no review, finding or agent-run rows and SHALL make no GitHub call as a side effect of an eval run. | server hermetic test (`reviews`, `findings`, `agent_runs` counts unchanged; the GitHub adapter wired and asserted uncalled — the vacuous-baseline trap, `server/INSIGHTS.md` 2026-08-28) |

**UI — runs, history, comparison, dashboard**

| ID | Criterion (EARS) | How it is checked |
| ----- | ---------------- | ----------------- |
| AC-31 | The agent editor SHALL offer an Evals tab whose tab key round-trips through the page's `?tab=` whitelist. | client RTL, page-level (the double-whitelist trap and its test pattern, `client/INSIGHTS.md` *Codebase Patterns*, 2026-08-29; `client/src/app/agents/[id]/page.test.tsx`) |
| AC-32 | WHILE a batch is in flight, the Evals tab SHALL show a pending state and SHALL NOT allow a second trigger from that surface. | client RTL |
| AC-33 | WHEN a batch completes, the Evals tab SHALL show its recall, precision and citation accuracy, and its passed/total case counts. | client RTL |
| AC-34 | WHEN the Evals tab is opened for an agent with past batches, it SHALL list them newest first with time, agent version, the three metrics, and cost. | client RTL |
| AC-35 | WHEN a maintainer selects two batches, the system SHALL show them side by side: the three metrics of each with their deltas, and the per-case outcomes aligned case-by-case. | client RTL |
| AC-36 | The studio SHALL offer an Eval Dashboard page, reachable from the left sidebar, listing recent batches across all agents with agent name, time and the three metrics. | client RTL |
| AC-37 | WHILE no batch has ever run, the Eval Dashboard SHALL render an explicit empty state rather than an error. | client RTL (`eval.json` `dashboard.noRuns` already holds this string) |
| AC-38 | The user-facing copy for this feature SHALL describe only what it builds, and no string describing an unbuilt surface (manual case editor, per-case run, metric trend) SHALL remain in `client/messages/en/eval.json`. | client RTL + a check on that file (the `brief.json`/`skills.json`/`context.json` rewrite precedent) |

**Operational**

| ID | Criterion (EARS) | How it is checked |
| ----- | ---------------- | ----------------- |
| AC-39 | WHEN the seed runs, at least 8 eval cases SHALL exist for a built-in seeded agent, including both expectation kinds, and re-running the seed SHALL NOT duplicate them. | `pnpm db:seed` twice against a fresh DB, then a row-count query (or a seed-covering `*.it.test.ts`) |
| AC-40 | WHEN `pnpm verify:l06` is run at the repository root, it SHALL run the server typecheck and hermetic test lane and the client typecheck and test lane, and SHALL exit non-zero when any of them fails. | run the command; break one lane and observe the non-zero exit |

## Non-functional criteria

| ID | Criterion (EARS) | How it is checked |
| ------- | ---------------- | ----------------- |
| AC-NF-01 | The system SHALL restrict every eval route to cases, findings, agents and batches of the requesting workspace. | server `*.it.test.ts` (cross-workspace request denied) |
| AC-NF-02 | The system SHALL limit batch triggering to 3 requests per minute per route, because each request is one model call per case. | server hermetic test with a non-test-env app — the rate-limit plugin is inert under `NODE_ENV=test` (`server/INSIGHTS.md` *Tool & Library Notes*, 2026-08-29) |
| AC-NF-03 | Every route this feature adds SHALL declare `schema.response`, so the serializer acts as an output allowlist. | server hermetic test (an extra handler field does not leak) |
| AC-NF-04 | The system SHALL resolve each case execution's model from the agent's own provider and model, and SHALL NOT add a member to `FeatureModelId`. | server hermetic test + contract review (`contracts/platform.ts`) |
| AC-NF-05 | The system SHALL bound each case's model call with a timeout of at most 60 seconds and an output-token cap, and SHALL run case calls with bounded concurrency of at most 3. | server hermetic test on the call options; concurrency asserted via the mock's in-flight counter |
| AC-NF-06 | The system SHALL NOT emit case diff text, PR bodies or prompt content into logs — only identifiers, counts, metrics and sizes. | server hermetic test on emitted log lines |
| AC-NF-07 | WHEN a batch completes, the system SHALL emit one structured log line carrying the agent, its version, case counts, the three metrics, total cost and duration. | server hermetic test (the `intent: classified` structured-log precedent) |
| AC-NF-08 | The client's vendored copies of the contracts this feature touches SHALL be byte-identical to the canonical copies, and the client typecheck SHALL pass against them. | `diff -q server/src/vendor/shared/contracts/{eval-ci,knowledge}.ts client/src/vendor/shared/contracts/` + `cd client && pnpm typecheck` (root `INSIGHTS.md` 2026-08-28: the typecheck is what catches an incomplete hand-copy) |
| AC-NF-09 | The `verify:l06` gate SHALL introduce no root dependencies, no root lockfile and no workspace configuration, and SHALL invoke each package with that package's own package manager. | inspect the repo root after the change; run the gate on a clean clone (root `INSIGHTS.md` *Tool & Library Notes*, 2026-07-29 — the pnpm/npm split) |
| AC-NF-10 | Every threshold this feature introduces (rate limit, concurrency, timeout, dashboard cap, seed count) SHALL live in a constants module rather than inline. | code review, the `specs/01-smart-diff.md` precedent |
| AC-NF-11 | IF the process crashes mid-batch, THEN the completed case rows SHALL remain valid, the batch SHALL simply hold fewer rows than the agent has cases, and no state SHALL require a boot-time reaper. | server hermetic test (provider throws after k cases → exactly k rows, all well-formed); stated against the no-transactions reality (`server/INSIGHTS.md`, 2026-08-05) |

## Constraints from the repo

- **The grounding gate is the citation-accuracy source, and it is mechanical
  by decision.** `reviewer-core/INSIGHTS.md` *Decisions*, 2026-07-31: "every
  finding must cite a real line in the diff or it is dropped… a citation check
  is verifiable where a self-reported confidence is not."
  `ReviewOutcome.dropped` carries dropped findings with reasons
  (`reviewer-core/src/review/run.ts:106-112`) — but it **merges grounding and
  scope drops** (`run.ts:230`), so AC-23's "only grounding-gate drops count"
  is a real requirement on how the engine outcome is consumed, not a given.
  The gate itself must not be bypassed or edited via the server's re-export
  shim (`server/src/platform/grounding.ts`; `server/INSIGHTS.md` *Codebase
  Patterns*, 2026-07-29).
- **The frozen diff must be groundable.** `groundFindings` builds its line
  index from parsed unified-diff hunks
  (`reviewer-core/src/grounding.ts:23-38`), so a case whose `input_diff` is
  not a parseable fragment scores every finding as ungrounded. AC-07 exists
  because `pr_files.patch` is nullable
  (`server/src/db/schema/pulls.ts:44`).
- **The schema is taken as given; `eval_runs` is per-case.** The batch
  concept is modelled by the minimal `batch_id` extension, not a redesign —
  see Schema changes for the rejected alternative and its accepted
  consequence (AC-NF-11).
- **Agent-version labelling has a known blind spot.** Relinking skills does
  not bump `agents.version` and is absent from the `agent_versions` snapshot
  logic (`server/INSIGHTS.md` *What Doesn't Work*, 2026-08-05), so two batches
  can share a version label yet have run different prompts. Accepted and
  inherited, not fixed here: the batch records `agent_version` + `model`, and
  fixing the snapshot gap is that module's own work.
- **An eval-triggering test can reach a real provider and spend money.**
  `server/INSIGHTS.md` *Recurring Errors & Fixes*, 2026-08-14: config built
  from `process.env` plus a machine with keys in `~/.devdigest/secrets.json`
  lets an unstubbed provider fall through. Every test that triggers a batch
  must stub every provider the agent under test can resolve.
- **Test lanes are fixed by filename** — `*.it.test.ts` is DB-backed
  testcontainers, everything else hermetic (root `CLAUDE.md`, `TESTING.md`);
  it-tests self-skip without Docker (`server/INSIGHTS.md`, 2026-07-29);
  `server/test/**` is not type-checked (`server/INSIGHTS.md`, 2026-08-17).
- **Nothing runs in a transaction** (`server/INSIGHTS.md`, 2026-08-05) —
  AC-27 and AC-NF-11 are stated against that reality.
- **Module boundaries:** `no-cross-module-internals` bans importing another
  module's `service.ts`/`repository.ts`/`helpers.ts`; capability access goes
  through the container or a narrow structural port in the consuming module's
  `types.ts` (`server/INSIGHTS.md` *Codebase Patterns*, 2026-08-05/16/17).
  Resolving "the agent that produced the finding" and reading `pr_files.patch`
  must respect this; the mechanism is the planner's.
- **The `?tab=` whitelist is defined twice** and the agent editor already
  derives `VALID_TABS` from `TABS`
  (`client/src/app/agents/[id]/_components/AgentEditor/constants.ts:19`);
  AC-31's page-level round-trip test is the guard `client/INSIGHTS.md`
  (*Codebase Patterns*, 2026-08-29) prescribes.
- **`@testing-library/user-event` is not a client dependency**
  (`client/INSIGHTS.md`, 2026-08-20) — the client RTL criteria use
  `fireEvent`.
- **Pre-staged copy is a proposal, not a spec** (root `INSIGHTS.md`
  *Codebase Patterns*, 2026-08-05, refined 2026-08-29, after misleading three
  features). AC-38 and the Scope-out entries for the manual editor, per-case
  run and trend chart are that rule applied to `eval.json`.
- **The pnpm/npm split** (root `INSIGHTS.md` *Tool & Library Notes*,
  2026-07-29) and the deliberate absence of a workspace (root `CLAUDE.md`)
  bound the `verify:l06` design: AC-NF-09 exists so the gate cannot quietly
  turn the repo into a workspace or add a competing lockfile.
- **Seeded data has zero findings** (`client/INSIGHTS.md`, 2026-08-04), so
  AC-39's seed cases are hand-authored fragments, not derived from seeded
  findings; the finding-born path (AC-01/02) is the live path.

## Decision log

Decisions made where the homework was silent, recorded so a reversal reads as
a change of decision rather than a gap.

| # | Question | Decision |
|---|----------|----------|
| 1 | Who owns a finding-born case? | The agent whose review produced the finding — no owner picker. The decision-maker labelled *that agent's* output. |
| 2 | What exactly is frozen? | The stored per-file patch of the finding's file plus PR title/body plus the expectation. Live-PR enrichments (intent, blast, context, repo map) are excluded from eval prompts so two batches differ only by agent configuration. |
| 3 | How is a batch modelled against a per-case `eval_runs`? | A `batch_id` column (plus `agent_version`), no batch table. Aggregates are derived; a synchronous trigger needs no status machinery. |
| 4 | Sync or async trigger? | Synchronous `POST` returning the full batch result — the MCP blocking-run precedent; per-case timeout × bounded concurrency bounds the wall clock. Rejected: async + polling, which would demand batch status storage the given schema lacks. |
| 5 | Precision formula | 1 − noise/surviving-findings across the batch, noise = matches of a case's own `must_not_flag` region. Only labelled regions count as noise — an unlabelled extra finding is not assumed wrong. |
| 6 | Vacuous metrics | A metric with an empty denominator reports 1.0. |
| 7 | Errored cases | Recorded with their error, excluded from metric denominators, surfaced as a count — a model outage must not read as a quality regression. |
| 8 | Duplicate/undecided/patch-less/orphaned findings | All four refuse creation (AC-05..AC-08) rather than creating a degraded case. |
| 9 | What of the pre-staged eval contracts and i18n? | Contracts not adopted stay exported and unused (the `PrBrief` precedent); `eval.json` is rewritten to the built surfaces (AC-38). Manual editor, per-case run and trend chart are out. |
| 10 | What is `verify:l06`? | A `verify:l06` script runnable as `pnpm verify:l06` at the repo root — no root `package.json` or `verify:*` script exists today — running server typecheck + hermetic tests and client typecheck + tests, under AC-NF-09's no-workspace/no-lockfile/no-deps constraint. The minimal shape satisfying both the literal command and the constraint is a scripts-only, private root `package.json`; the exact composition is the planner's. |
| 11 | Where do history and comparison live vs the dashboard? | Per-agent history + two-batch comparison in the Evals tab; the `/eval` dashboard is the cross-agent recent-batches view. |
| 12 | "Changing the prompt visibly moves the numbers" | Not an automatable AC — it depends on live model behaviour. What the spec guarantees is the machinery that makes the movement visible and attributable: frozen inputs (AC-04), version + model provenance (AC-26), and the comparison view (AC-35). The demonstration itself is a demo-day run over the seeded set. |

## Context consulted

**Specs.** `specs/README.md` (routing: cross-package → root `specs/`; `01`–`04`
exist, so `05` is next). `specs/04-pr-brief.md` (house style, EARS usage,
AC-ID permanence, the left-alone-contracts and i18n-rewrite precedents).
`server/specs/01-mcp-server.md` (fixed MCP tool set → no MCP surface here).

**INSIGHTS.** Root — read in full; load-bearing: vendored-shared lag incl.
`contracts/eval-ci.ts` (2026-07-29/2026-08-28), pre-staged-copy-as-proposal
(2026-08-05, refined 2026-08-29), pnpm/npm split, skills-wiring history.
`server/INSIGHTS.md` — read; load-bearing: per-case staged tables, no
transactions, `schema.response`, rate-limit inert under test, it-tests
reaching real providers, `agent_versions` skill blind spot, journal hazards,
vacuous-baseline trap. `client/INSIGHTS.md` — read; load-bearing: `?tab=`
double whitelist, no `user-event`, zero seeded findings. 
`reviewer-core/INSIGHTS.md` — read; the mechanical-grounding decision.

**Docs/READMEs/source.** Root/`server`/`client`/`reviewer-core` `CLAUDE.md`;
`server/README.md` (API map); `reviewer-core/README.md` (pipeline; `toReview`
and the L06 note). Source: `server/src/db/schema/{eval,runs,pulls,reviews}.ts`;
`server/src/vendor/shared/contracts/{knowledge,eval-ci,findings,review-api}.ts`;
`server/src/modules/reviews/{findings.ts,routes.ts}`;
`server/src/modules/agents/routes.ts`; `server/src/db/seed.ts`;
`reviewer-core/src/grounding.ts`, `reviewer-core/src/review/run.ts`
(`ReviewOutcome.dropped`, cost/duration); `client/messages/en/eval.json`;
`client/src/components/app-shell/helpers.ts:35`;
`client/src/app/agents/[id]/_components/AgentEditor/constants.ts`;
`client/src/app/repos/[repoId]/pulls/[number]/_components/FindingCard/FindingCard.tsx`.
Verified absent: any root `package.json`, any `verify:*` script in any
package, any existing eval module or route.

**MCP.** The `devdigest` server was reachable. `devdigest_list_agents`: five
reviewers, all on `deepseek/deepseek-v4-flash` (four enabled) — the agents an
eval batch would execute, confirming per-batch cost is N cheap-model calls and
no new reviewer agent is needed. `devdigest_get_conventions`
(`ai-agentic-engineering-neo/dev-digest`): two low-confidence rules, neither
of which this spec needs to re-require. `devdigest_get_findings` /
`devdigest_get_blast_radius` not called: no PR of this repo is synced, so
there is no finding baseline to read, and the change area is greenfield
server/client modules the index does not resolve.

## Open questions

**None.** Every gap the homework left is closed by a recorded decision in the
Decision log. This spec is plannable.
