# PR Brief — the Why + Risk card

**Status:** shipped
**Packages touched:** server, client
**Created:** 2026-08-29
**Clarifications resolved:** 2026-08-29 (all 14 — see "Resolution log")
**Supersedes:** None

## Problem

A reviewer opening a PR page today gets four disconnected answers and no
summary. `IntentCard` says what the author *claims* the PR does. `BlastCard`
says which symbols and endpoints sit downstream. The Files-changed tab says
which files are `core` and which are `boilerplate`. The Findings tab says what
some agent found, but only after a review has been paid for and run.

Nothing joins them, and nothing tells the reviewer where to start. The reviewer
has to hold four panels in their head and derive "so, how worried should I be,
and what do I read first?" themselves — which is exactly the judgement they
opened the page to get help with. The cost is that reviewers either read the
whole diff in GitHub order (the problem Smart Diff already named,
`specs/01-smart-diff.md`) or skim and miss the one file that mattered.

The system already computed every input this needs. `pr_intent` holds a
classification with scope and risk areas
(`server/src/db/schema/reviews.ts:92-119`). `GET /pulls/:id/blast` returns
changed symbols, callers, endpoints and crons, plus a `degraded` flag and a
`head_sha` (`server/src/modules/blast/service.ts:23-38`). `GET
/pulls/:id/smart-diff` returns per-file `core`/`wiring`/`boilerplate` roles and
churn (`specs/01-smart-diff.md`). Project Context discovers the repository's own
specs and docs (`server/src/modules/project-context/types.ts:11-27`). The
`@devdigest/shared` `Risk` shape has existed since the contracts were staged
(`server/src/vendor/shared/contracts/brief.ts:80-92`), the `risk_brief` feature
model id is already in the registry
(`server/src/vendor/shared/contracts/platform.ts:58-64`), and the `pr_brief`
table is already declared and never written
(`server/src/db/schema/reviews.ts:121-126`).

`specs/02-blast-radius.md` explicitly deferred this: "`pr_brief` persistence and
the composed `PrBrief` route — the table stays empty by design" and "the verdict
banner … a later brief lesson". This is that lesson.

## Goals

1. One card on the PR Overview tab that answers **what**, **why**, **how risky**
   and **what to check first**, before the reviewer opens any code.
2. A single risk level the reviewer can act on at a glance, arrived at
   deterministically rather than asserted by a model.
3. Concrete risks that each point at real files in this PR — not generic advice.
4. A review-focus list that is *navigable*: clicking an item takes the reviewer
   to the code it names, in the Files-changed view, at the line if there is one.
5. Assembled from facts the system already holds, at a cost of **one** model
   call, with **no diff hunk bodies** in the prompt.

## Non-goals

- **Replacing the review.** The brief orients a human; it does not produce
  `Finding` rows, does not run agents, and does not affect any agent's verdict
  or score. Out because findings have their own grounding gate, their own
  severity vocabulary (`CRITICAL`/`WARNING`/`SUGGESTION`,
  `contracts/findings.ts`) and their own persistence, and conflating the two
  would make the brief's `risk_level` look like a review verdict.

- **Consuming the PR's existing review findings.** `SmartDiffFile.findings`
  would supply them free (`contracts/brief.ts:139`), and the brief deliberately
  does not read them. Out because the brief must **mean the same thing before
  and after a review has run**, and must be generatable on a PR that has never
  been reviewed. A brief that silently got better once an agent ran would be a
  brief nobody could reason about. Deferred, not permanently excluded — see
  "Deferred follow-ups".

- **Reading the linked issue's body.** The brief passes the issue *reference*
  and its status, never its text. The consequence is deliberate and worth
  stating plainly: **the model knows that a PR claims to close `#123` without
  knowing what `#123` says.** Out because `IntentSource` is contractually
  reference-only — "Human-readable reference (issue number, doc path, URL) —
  never content" (`contracts/brief.ts:38`) — and re-fetching through
  `container.github()` would add a network dependency, a failure mode and a
  second source of truth for the same fact.

- **Feeding the brief back into the review prompt.** Out because
  `run-executor` already resolves intent, callers, repo map, skills and project
  context into the prompt independently; adding a brief would be a second,
  redundant summarisation of the same facts and a second prompt budget.

- **Reading diff hunk bodies.** A hard constraint, not a deferral — see
  "Constraints from the repo".

- **A verdict banner or PR score.** `VerdictBanner`
  (`client/src/app/repos/[repoId]/pulls/[number]/_components/VerdictBanner/`)
  already exists and belongs to a *review run*, not to the brief. Out because
  reusing it would attach a reviewer agent's verdict to a card that never ran an
  agent.

- **Classifying intent on demand.** The brief reads the persisted `pr_intent`
  record and never calls `IntentFacade.getOrClassify`. Out because that is what
  keeps "one structured model call" literally true rather than
  true-on-a-good-day.

- **The CI / GitHub review path.** Studio only. Out for the same reason
  `specs/03-project-context-folder.md` gave: the CI runner has no studio DB and
  resolves its own inputs from its checkout
  (`server/src/modules/reviews/helpers.ts:11-18`).

- **MCP exposure of the brief.** No new MCP tool. Out because
  `server/specs/01-mcp-server.md` fixes the tool set and nothing in this request
  asks an MCP client for a brief.

## Scope — in / out

**In**

- A server module that assembles the brief's inputs from existing modules, makes
  one structured model call, grounds the result against those inputs, persists
  it, and serves it.
- `GET /pulls/:id/brief` — the stored brief, no model call, 404 when none exists.
- `POST /pulls/:id/brief` — generate or regenerate, rate-limited.
- `PrBriefCard` on the PR Overview tab, alongside `IntentCard` and `BlastCard`,
  with an explicit generate action, a distinct regenerate action, an outdated
  indication and a degraded indication.
- A clickable review-focus list, and **the cross-tab deep link that makes it
  work** — navigating to the Files-changed view, expanding the target file even
  when its group is collapsed, and scrolling to the line when the item has one.
- The `Brief` contract in `@devdigest/shared`, canonical copy first, then the
  client hand-mirror.
- A migration adding `head_sha`, `model` and `generated_at` to `pr_brief`.

**Out**

- Everything under "Non-goals" above.
- Changing `IntentCard` or `BlastCard`. Out because both are shipped surfaces
  with their own specs; the brief sits beside them.
- Changing the existing `PrBrief` schema (`contracts/brief.ts:165-172`). It is
  not extended, renamed or replaced — `Brief` is added alongside it. Out because
  `PrBrief` is exported from `server/src/vendor/shared/index.ts:6` and
  re-exported at `client/src/lib/types.ts:35`, and editing a published shape to
  make room for a new one is a breaking change bought for nothing.
- Changing how Smart Diff classifies files, or how Project Context discovers
  documents. Out because the brief consumes both as they stand.
- Widening `FeatureModelId` or changing the registered `risk_brief` default. Out
  because both are contract edits visible in Settings, and the registered entry
  already fits.
- A per-repository "brief context" selector. Out because discovery over the
  repository's configured search roots already answers "which specs" without a
  new table, a new picker or a new attachment vocabulary.
- Any second model call. Out because requirement 3 says one structured call.

## Actors & triggers

**A reviewer or maintainer, in the studio, explicitly.** A brief is generated
**only** by a user action on the PR page. Opening the Overview tab performs a
cached read and never spends money. Nothing generates a brief on a review run,
on PR sync, on polling, or on render.

The card is on `OverviewTab`, which
`client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx:1-2`
already calls "the PR Brief surface" and which the PR page renders as the
default tab (`page.tsx:60,137`).

**Preconditions for reachability:** the PR exists in the workspace and resolves
through `getContext`, and its files are persisted in `pr_files` — every input is
keyed off the changed-path list.

**No precondition for quality.** A missing intent record, an unindexed
repository, a `degraded` blast result or a repository with no spec documents
each reduce what the brief can say; none of them prevents it being generated.
The brief reports what it was missing rather than refusing or guessing.

**Regeneration:** any workspace member, through a control distinct from the
first-generation action. Rate-limited per route. The workspace model expresses
no roles, so no role restriction is stated.

**Not a trigger:** a review run. `run-executor` does not read the brief and the
brief does not read a review's findings.

## Input provenance

Every input the brief consumes, where it comes from, and what was decided about
it. This table is the evidence behind "assembles its inputs from what the system
already computed".

| Input | Source of truth | Evidence | Decision |
|-------|-----------------|----------|----------|
| **Intent** — `intent`, `in_scope`, `out_of_scope`, `risk_areas`, `confidence`, `sources`, `head_sha` | The persisted `pr_intent` row, read through the existing intent read path | `server/src/modules/intent/service.ts:43-47` (`get`); contract `server/src/vendor/shared/contracts/review-api.ts:63-76`; facade on the container `server/src/platform/container.ts:177-180` | **Read-only.** `IntentFacade.getOrClassify` (`service.ts:145-154`) is **not** called from the brief path. An absent row is a missing input, not a trigger. The row's own `head_sha` travels with the brief so the card can show that the intent predates the current head. |
| **Blast summary** — `changed_symbols`, `downstream` (callers + `endpoints_affected` + `crons_affected`), the deterministic `summary` string, `degraded` | `BlastService.get` → `BlastPanel` | `server/src/modules/blast/service.ts:23-38`; contract `contracts/brief.ts:110-118`; route `server/src/modules/blast/routes.ts:20-27` | Consumed. `BlastPanel.degraded` propagates into the brief's own degraded state. **Reaching it is a constraint the plan must solve** — see "Constraints from the repo". |
| **Prior-PR history** — PRs overlapping ≥ 1 changed path | `pullsRepo.listOverlapping`, capped at `HISTORY_LIMIT = 5` | `server/src/modules/blast/constants.ts`; `server/src/modules/blast/types.ts` (`BlastPullsRepo`) | Consumed as context for the model. Lowest input priority — first to be dropped after documents when the input cap binds (AC-NF-04). |
| **Diff stats** — per-file `additions` / `deletions`, total lines, `too_big` | `SmartDiff.split_suggestion.total_lines`, `SmartDiffFile.additions/deletions` | `contracts/brief.ts:133-163`; `specs/01-smart-diff.md` | Consumed. Same reachability constraint as blast. |
| **Per-file classification** — `core` / `wiring` / `boilerplate` | `SmartDiffGroup.role` | `contracts/brief.ts:121-147`; classifier `server/src/modules/smart-diff/classifier.ts` | Consumed. Deterministic, no model call (`specs/01-smart-diff.md` "Design notes"). |
| **Existing findings on the PR** | `SmartDiffFile.findings` | `contracts/brief.ts:124-140` | **Not consumed.** See Non-goals. |
| **Linked issue** | The `IntentSource` entries already on the intent record | `contracts/brief.ts:36-44`; `server/src/modules/intent/service.ts:179-191` | **Reference and status only** — `{kind:'linked_issue', ref:'#123', status}`. No `container.github()` call, no persistence of issue text. The "never content" comment stands unamended. |
| **Relevant specs** | Project Context **discovery**, not attachment | Port `server/src/modules/project-context/types.ts:11-27` (`list(repo, roots)` / `read(repo, roots, path)`), on the container as `projectContextDocs` (`server/src/platform/container.ts:198`); roots via `ContextSearchRootsRepo.getSearchRoots` (`types.ts:51-54`) | The repository's discovered markdown documents under its configured search roots, **filtered to document type `spec`**, ordered by path, capped (AC-35). No attachment table, no picker, no dependency on which agent has what attached. `ProjectContextDocType` is `z.string()`, not an enum (`contracts/project-context.ts:10-18`), so a repository whose roots produce no `spec` type simply contributes no documents. Path containment is already enforced inside `read` (`types.ts:20-26`). |
| **PR title / body / head SHA / status** | `pullsRepo.getPull` / the PR detail payload | `server/src/modules/blast/types.ts` (`BlastPull { id, repoId, headSha }`); `page.tsx:137` passes `pr.head_sha`, `pr.body` | Consumed. Highest input priority — never dropped. |
| **Model choice** | `resolveFeatureModel(container, workspaceId, 'risk_brief')` | `server/src/modules/settings/feature-models.ts`; registry entry `contracts/platform.ts:58-64` — label "Risk Brief", description "Assesses merge risks for a pull request.", default `openai` / `gpt-4.1` | Used **exactly as registered**. The enum is not widened and the default is not changed. |

## Contract changes

Canonical copy is `server/src/vendor/shared/contracts/brief.ts`; the client's
`client/src/vendor/shared/contracts/brief.ts` is a hand-copy with no sync
script and is already known to lag, so every shape below must be mirrored there
as a deliberate second step (root `INSIGHTS.md`, *What Doesn't Work*,
2026-07-29, and its 2026-08-28 refinement: the **client typecheck** is the
mechanism that catches an incomplete hand-copy — run `cd client &&
./node_modules/.bin/tsc --noEmit` immediately after touching the canonical
copy).

**Reused unchanged.** `Risk` and `RiskSeverity` already carry exactly what a
risk needs — `{ kind, title, explanation, severity: high|medium|low, file_refs:
string[] }` (`contracts/brief.ts:76-92`). This spec introduces **no second risk
shape** and does not touch `RiskSeverity`: it stays the three-valued *per-risk*
vocabulary. `Intent`, `IntentSource`, `BlastRadius`, `DownstreamImpact`,
`PrHistory`, `BlastPanel` and the Smart Diff shapes are all consumed as they
stand.

**Left alone deliberately.** `PrBrief` (`contracts/brief.ts:165-172`, `{ intent,
blast, risks, history }`) is **not** extended, renamed or replaced. It stays
exported and unused. `Brief` is added alongside it.

**New shapes.**

- **`BriefRiskLevel`** — a four-value enum, `high | medium | low | none`. It is
  the *whole-PR* level and is distinct from `RiskSeverity` precisely because it
  needs a fourth value: `none` is what a brief with zero surviving risks
  reports. Its copy must not read as a review verdict (see "Constraints").

- **A review-focus item** — `{ file, line?, reason }`. `file` is required and
  must appear in the brief's input data. `line` is optional, matching the
  optionality of a line on a `Risk` (which has none at all) and the anchor
  convention `SmartDiffFinding.line` establishes as "the new-side start line —
  the scroll anchor" (`contracts/brief.ts:126`). `reason` is the one-line "why
  check this first" the reviewer reads before clicking.

- **`Brief`** — `{ what, why, risk_level, risks, review_focus, degraded,
  missing_inputs }`:
  - `what` — a short factual statement of what the PR changes.
  - `why` — the reason it is being made, as the PR and its inputs state it.
  - `risk_level` — `BriefRiskLevel`, **server-computed** (AC-30).
  - `risks` — `Risk[]`, reused verbatim, post-grounding.
  - `review_focus` — the ordered item list above, post-grounding.
  - `degraded` — `boolean`, following `BlastPanel.degraded`
    (`contracts/brief.ts:114`) as the established way to tell a client "this was
    computed on partial inputs".
  - `missing_inputs` — a machine-readable list of which inputs were unavailable,
    so the card can say *what* was missing rather than only *that* something
    was. The status vocabulary follows the two precedents already in the repo:
    `IntentSourceStatus` (`contracts/brief.ts:33`) and `SpecRead.status`
    (`contracts/trace.ts:63-69`), both of which distinguish "absent" from
    "referenced but unreachable".

- **A response envelope** carrying the brief plus what the card must render
  around it: the head SHA the brief was generated against, the PR's current head
  SHA (so the client can show the outdated state without a second fetch — the
  `BlastPanel.head_sha` precedent, `contracts/brief.ts:117`), the model that
  produced it, and its generated-at timestamp.

## Routes

Both routes mirror the intent module exactly
(`server/src/modules/intent/routes.ts:22-47`), including its comment that both
declare `schema.response` — "the serializer strips anything the handler did not
promise (an output allowlist, not a formality)".

- **`GET /pulls/:id/brief`** — params `IdParams`, workspace-scoped via
  `getContext`, declared `schema.response`. Returns the stored brief. **404 when
  none exists** — which the client treats as an empty state, not an error, the
  way `usePrIntent` already maps intent's 404 to `null`
  (`client/src/lib/hooks/intent.ts:13-27`). No model call, ever.

- **`POST /pulls/:id/brief`** — same params, scoping and response declaration.
  Generates when no brief exists for the PR's current head SHA; regenerates
  unconditionally when the caller asks for it. Declares
  `config: { rateLimit: { max: 10, timeWindow: '1 minute' } }`, matching
  `server/src/modules/intent/routes.ts:39` and its comment "Tight per-route
  limit: each call is a paid model call".

- **Registration.** One plugin, one import plus one `app.register` in
  `server/src/modules/index.ts` (`server/CLAUDE.md` §Conventions).

## Schema changes

The table exists — `pr_brief` is `{ pr_id uuid PK → pull_requests(id) ON DELETE
CASCADE, json jsonb NOT NULL }` (`server/src/db/schema/reviews.ts:121-126`) —
with no repository method reading or writing it anywhere in `server/src`.

**A migration adds three columns**, mirroring `pr_intent`, which already carries
`model`, `head_sha` and `classified_at` as first-class columns
(`server/src/db/schema/reviews.ts:106-109`):

- `head_sha` — the cache key. It has to be a column because a cache key that
  lives inside a `jsonb` blob cannot be queried or indexed.
- `model` — provenance the card renders.
- `generated_at` — provenance the card renders.

The `Brief` payload itself stays in the existing `json` column.

**Cache semantics.** One row per PR. `head_sha` alone is the key:

- Stored `head_sha` **equals** the PR's current head → a hit. `GET` returns it;
  `POST` returns it without a model call.
- Stored `head_sha` **differs** → a miss, but a *visible* one: the stored brief
  is still returned, flagged outdated, and the card offers Regenerate. Nothing
  is auto-deleted and nothing is auto-regenerated.
- Regeneration overwrites the row, setting `head_sha` to the current head.

**Nothing else invalidates.** A re-classified intent, a changed set of project
context documents, a new review, an edited PR body — none of these mark a brief
outdated. That is stated as a criterion (AC-41) rather than left implicit,
because a staleness rule that is only *almost* right is worse than one whose
edges are written down.

Two notes for whoever runs the migration, both from `server/INSIGHTS.md`:
`pnpm db:generate` on a machine whose journal diverged from upstream **rewrites**
committed `_journal.json` history (*What Doesn't Work*, 2026-08-05), and a schema
edit that drops a column blocks on an interactive tty prompt that `yes ''`
cannot satisfy (*Tool & Library Notes*, 2026-08-05). This migration only adds
columns, so the second should not bite.

## Adapters needed

**None.** Every input is reachable through existing container members —
`pullsRepo`, `repoIntel`, `db`, `llm`, `tokenizer`, and `projectContextDocs`
(`server/src/platform/container.ts:198`) for document discovery and reading. No
GitHub call is made (the linked issue is a reference only), so no new port and
no new dependency.

## Acceptance criteria

| ID | Criterion (EARS) | How it is checked |
| ----- | ---------------- | ----------------- |
| AC-01 | WHEN a brief is requested for a pull request, the system SHALL return a brief containing a `what`, a `why`, a single risk level, a list of risks and an ordered review-focus list. | server hermetic test (route response parses against the shared schema) |
| AC-02 | The system SHALL assemble the brief's inputs from the persisted intent record, the blast summary, the diff statistics, the per-file classification, the linked-issue reference and the repository's spec documents, without recomputing any of them from scratch. | server hermetic test with each input source mocked; each mock asserted called exactly once |
| AC-03 | The system SHALL NOT include any diff hunk body in the prompt sent to the model. | server hermetic test asserting the prompt captured by `MockLLMProvider` contains no patch text from the fixture PR's `pr_files` (assert on a sentinel string present only inside a hunk body) |
| AC-04 | The system SHALL produce a brief using exactly one structured model call. | server hermetic test (`MockLLMProvider.calls.length === 1` across a full generate) |
| AC-05 | The system SHALL request the model's output as a structured schema rather than parsing free text. | server hermetic test (the call carries a named `schemaName`, matching the `IntentClassification` precedent at `server/src/modules/intent/service.ts:77`) |
| AC-06 | WHEN the model returns a risk whose `file_refs` include a file that is not among the brief's input files, the system SHALL remove that reference before the brief is stored. | server hermetic test (stubbed model output containing an invented path; stored brief omits it) |
| AC-07 | WHEN the model returns a review-focus item whose `file` is not among the brief's input files, the system SHALL drop that item before the brief is stored. | server hermetic test |
| AC-08 | WHEN the model returns an endpoint reference that does not appear in the blast summary's endpoints, the system SHALL remove that reference before the brief is stored. | server hermetic test |
| AC-09 | WHEN the system drops a risk, a file reference or a review-focus item for failing grounding, it SHALL record that it did so, with the reason. | server hermetic test on the drop record — the `GroundingResult.dropped` precedent (`reviewer-core/src/grounding.ts:19-21`) and the "never go silent" rule (`reviewer-core/src/review/run.ts:111`) |
| AC-10 | WHEN a brief is generated, the system SHALL persist it against the pull request. | server `*.it.test.ts` (a `pr_brief` row exists for the PR after the call) |
| AC-11 | WHEN a brief is requested for a pull request whose stored brief matches the current head SHA, the system SHALL return the stored brief and SHALL NOT make a model call. | server hermetic test (`MockLLMProvider.calls` unchanged across the second request) |
| AC-12 | WHEN the reviewer explicitly requests regeneration, the system SHALL make a new model call and SHALL replace the persisted brief, even when the stored brief matches the current head SHA. | server hermetic test |
| AC-13 | IF a brief is requested for a pull request that does not exist in the requesting workspace, THEN the system SHALL respond 404 through the shared error handler. | server hermetic test (the `BlastService` precedent, `server/src/modules/blast/service.ts:25`) |
| AC-14 | IF the pull request has no changed files recorded, THEN the system SHALL respond without making a model call. | server hermetic test |
| AC-15 | IF the model call fails or times out, THEN the system SHALL leave any previously persisted brief intact and SHALL surface the failure to the caller rather than persisting a partial brief. | server hermetic test (injected provider error) |
| AC-16 | WHILE no brief has been generated for a pull request, the Overview tab SHALL show the card in an empty state with an explicit generate action, and SHALL NOT generate one on render. | client RTL (no mutation fires on mount) |
| AC-17 | WHEN a brief exists, the PR page SHALL show its risk level on the Overview tab. | client RTL |
| AC-18 | WHEN a brief exists, the PR page SHALL show its review-focus items as a list of clickable controls, each showing its reason. | client RTL |
| AC-19 | WHEN a reviewer activates a review-focus item, the system SHALL bring the reviewer to the Files-changed view showing the file that item names. | client RTL |
| AC-20 | The PR page SHALL offer a regeneration control that is visually and functionally distinct from the first-generation action. | client RTL |
| AC-21 | WHILE a brief is being generated, the card SHALL show a pending state and SHALL NOT allow a second generation to be started from the same card. | client RTL |
| AC-22 | WHERE a stored brief's head SHA differs from the pull request's current head SHA, the card SHALL tell the reviewer the brief is outdated and SHALL offer regeneration. | client RTL (the `IntentCard` stale-warning precedent, `IntentCard.tsx:104,158-161`) |
| AC-23 | WHILE a brief has no risks, the card SHALL render an explicit "no notable risks" state rather than an empty list. | client RTL (`client/messages/en/brief.json:8` already holds this string) |
| AC-24 | The brief card SHALL render on the Overview tab alongside the intent and blast cards, and SHALL NOT replace either. | client RTL (`OverviewTab.test.tsx`) |
| AC-25 | IF the same pull request receives two concurrent generation requests, THEN the system SHALL NOT persist two conflicting briefs, and SHALL NOT make more than the model calls those requests were each charged for. | server `*.it.test.ts` |
| AC-26 | The system SHALL make no `Finding` rows, no review, and no agent run as a side effect of generating a brief. | server hermetic test (`reviews`, `findings` and `agent_runs` row counts unchanged) |
| AC-27 | WHEN a pull request is deleted, its persisted brief SHALL be removed with it. | server `*.it.test.ts` (the existing `ON DELETE CASCADE`, `server/src/db/schema/reviews.ts:123-124`) |
| AC-28 | The user-facing copy for this feature SHALL describe only what the brief actually does, and no string describing a design this spec does not build SHALL remain in `client/messages/en/brief.json`. | client RTL + a check on that file (see "The pre-staged i18n namespace" below) |

Criteria added when the clarifications were resolved on 2026-08-29:

| ID | Criterion (EARS) | How it is checked |
| ----- | ---------------- | ----------------- |
| AC-29 | The system SHALL NOT trigger an intent classification while generating a brief. | server hermetic test (a spy on the intent facade's classify path is never called; `MockLLMProvider.calls.length` stays 1 even when the PR has no `pr_intent` row) |
| AC-30 | WHEN a brief is generated, the system SHALL discard the model's own risk level and SHALL set the brief's risk level to the maximum severity among the risks that survive grounding. | server hermetic test (model returns `high` with only `low` risks surviving → stored brief reports `low`) |
| AC-31 | IF no risk survives grounding, THEN the system SHALL set the brief's risk level to `none`. | server hermetic test |
| AC-32 | WHEN any of the brief's inputs is unavailable, the system SHALL mark the brief degraded and SHALL name the unavailable inputs in a machine-readable list. | server hermetic test (absent intent row; unindexed repo; `BlastPanel.degraded` true — each names the right input) |
| AC-33 | WHILE a brief is degraded, the card SHALL tell the reviewer which inputs were unavailable. | client RTL |
| AC-34 | WHEN the pull request references a linked issue, the system SHALL include that issue's reference and status in the prompt and SHALL NOT include the issue's body. | server hermetic test (the prompt contains `#123` and not the fixture issue's title or body) |
| AC-35 | WHEN a brief is generated, the system SHALL include the repository's discovered documents of type `spec`, ordered by path, up to at most 6 documents and 12,000 characters combined, and SHALL NOT include documents of any other type. | server hermetic test over a fixture tree (a `docs/` document is excluded; the 7th spec is excluded; a set exceeding the character cap is truncated by whole documents) |
| AC-36 | IF the repository has no documents of type `spec`, THEN the system SHALL generate the brief without them and SHALL NOT mark it degraded on that account. | server hermetic test |
| AC-37 | The system SHALL enclose every included document's content in untrusted delimiters within the assembled prompt's `## Project context` section. | server hermetic test on the assembled prompt (`wrapUntrusted` + `INJECTION_GUARD`, `reviewer-core/src/prompt.ts:19-28,107-110`) |
| AC-38 | The system SHALL NOT generate a brief as a side effect of a review run, a pull-request sync, or a page render. | server hermetic test (run a review and a sync; `pr_brief` stays empty) + client RTL (AC-16) |
| AC-39 | WHEN the stored brief is requested and none exists, the system SHALL respond 404, and the card SHALL render its empty state rather than an error state. | server hermetic test + client RTL (the `usePrIntent` 404→`null` precedent, `client/src/lib/hooks/intent.ts:13-27`) |
| AC-40 | WHEN the stored brief's head SHA differs from the pull request's current head SHA, the system SHALL return the stored brief together with both head SHAs, and SHALL NOT regenerate it. | server hermetic test (`MockLLMProvider.calls` unchanged) |
| AC-41 | WHILE a pull request's head SHA is unchanged, the system SHALL continue to report its stored brief as current, regardless of a re-classified intent, a changed set of project context documents, or a new review. | server `*.it.test.ts` (re-classify intent, change the documents, run a review — the brief stays current) |
| AC-42 | WHEN a brief is regenerated, the system SHALL overwrite the pull request's single stored brief, and SHALL NOT accumulate one row per head SHA. | server `*.it.test.ts` (row count stays 1 across three regenerations at two head SHAs) |
| AC-43 | WHEN a brief is persisted, the system SHALL store its head SHA, its model and its generation timestamp as queryable columns rather than inside the payload. | server `*.it.test.ts` (a query filtering on `head_sha` returns the row) |
| AC-44 | WHEN a review-focus item is returned, it SHALL name a file present in the brief's inputs, SHALL carry a one-line reason, and MAY carry a line number. | server hermetic test (schema + grounding) |
| AC-45 | WHEN a brief exists, the card SHALL show which model produced it and when. | client RTL |
| AC-46 | WHEN a reviewer activates a review-focus item whose file sits in a collapsed group, the system SHALL expand that file so its contents are visible. | client RTL (`boilerplate` always starts collapsed — `SmartDiffViewer.tsx:29-33`) |
| AC-47 | WHEN a reviewer activates a review-focus item that carries a line number, the system SHALL scroll the Files-changed view to that line. | client RTL (`Element.prototype.scrollIntoView` spied, as `FileCard.test.tsx:62-63,80` already does) |

**On AC-19, AC-46 and AC-47 — the deep link does not exist yet.** What exists is
*intra-component*: `FileCard` holds a `jumpLine` state set by its own findings
badge and scrolls to `[data-new-line="…"]`
(`client/src/components/diff-viewer/FileCard/FileCard.tsx:51-53,67-72`).
`SmartDiffViewer` takes `{ prId, files, commenting }` only
(`SmartDiffViewer.tsx:38-44`), `DiffTab` passes no focus (`DiffTab.tsx:84`), and
the PR page's query state carries only `?tab=` and `?trace=`
(`page.tsx:60-68`). Building the cross-tab entry point is therefore **in
scope**, and the three criteria above state it as an outcome. The mechanism —
query params, React context, or state lifted into `page.tsx` — is the planner's
choice. Note for whichever is picked: `client/INSIGHTS.md` *Codebase Patterns*,
2026-08-29 records that a `?tab=` whitelist is defined twice and that adding to
one alone ships a dead tab.

**The pre-staged i18n namespace.** `client/messages/en/brief.json` exists with
zero usages anywhere in `client/src`, and `loadMessages` reads **every** file in
`messages/en/` (`client/src/i18n/request.ts:17-26`), so it already ships. Its
keys describe the *old* `PrBrief` composition and a different feature. AC-28
resolves as follows, so a planner does not read the file as a requirement:

| Key | Verdict |
|-----|---------|
| `block.risks`, `noRisks` | **Used as-is.** |
| `unavailable` ("Brief not available yet.") | **Used** for the AC-16 empty state. |
| `unavailableHint` ("Run a review or open the PR to compute it.") | **Rewritten.** It is factually wrong under AC-38 — nothing computes a brief on a review or a page open. |
| `block.intent`, `block.blast`, `block.history`, `noHistory`, `overlap` | **Removed.** They label the old `{intent, blast, history}` composition, which this card does not render. |
| `why.title` ("git-why"), `why.blame`, `why.noHistory`, `why.noCommits` | **Removed.** A git-blame feature, unrelated to this one. Their presence in a file named `brief` is the trap. |
| everything the card needs beyond that | **Added** — `what`, `why`, the four risk-level labels, review-focus, generate, regenerate, pending, outdated, degraded and provenance strings. |

This follows the precedent set twice already: `client/messages/en/skills.json`
was rewritten when its copy outran the engine (root `INSIGHTS.md`, *What
Doesn't Work*, 2026-08-05), and `client/messages/en/context.json` was rewritten
for the same reason in `specs/03-project-context-folder.md` (AC-33).

## Non-functional criteria

| ID | Criterion (EARS) | How it is checked |
| ------- | ---------------- | ----------------- |
| AC-NF-01 | The system SHALL restrict brief generation and retrieval to pull requests in the requesting workspace. | server `*.it.test.ts` (cross-workspace request denied), via `getContext` |
| AC-NF-02 | The system SHALL NOT emit any diff hunk body, PR body, issue reference body or document content into the run log, the SSE stream or the persisted log — only sizes, counts, refs and identifiers. | server hermetic test on emitted log lines; structurally guarded by `server/src/platform/prompt-log.ts`, whose types have no field able to hold section content |
| AC-NF-03 | The system SHALL resolve its model from the workspace's `risk_brief` setting, falling back to the registered default. | server hermetic test (workspace override honoured; absent override uses `openai` / `gpt-4.1`) — `server/src/modules/settings/feature-models.ts` |
| AC-NF-04 | IF the assembled model input would exceed 24,000 characters, THEN the system SHALL drop whole inputs in the stated priority order until it fits, SHALL NOT truncate an input part-way, and SHALL NOT fail the request. | server hermetic test (an oversized fixture produces a brief; the dropped inputs are the low-priority ones and each is dropped whole) |
| AC-NF-05 | The system SHALL record the model, the token counts and the cost of each brief generation. | server hermetic test on the emitted structured log line (the `intent: classified` precedent, `server/src/modules/intent/service.ts:109-136`) |
| AC-NF-06 | The system SHALL limit brief generation to 10 requests per minute per route, because each call is a paid model call. | server hermetic test (the `POST /pulls/:id/intent` precedent, `server/src/modules/intent/routes.ts:39`) |
| AC-NF-07 | Every route this feature adds SHALL declare `schema.response`, so the serializer acts as an output allowlist. | server hermetic test (a handler returning an extra field does not leak it) |
| AC-NF-08 | The system SHALL treat the PR title, the PR body and any document content reaching the prompt as untrusted data. | server hermetic test on the assembled prompt (`wrapUntrusted` + `INJECTION_GUARD`, `reviewer-core/src/prompt.ts:19-28`) |
| AC-NF-09 | WHEN no brief has ever been generated, the Overview tab SHALL render without an error state. | client RTL |
| AC-NF-10 | The system SHALL request at most 1500 output tokens and SHALL abandon the model call after 60 seconds. | server hermetic test (the call's `maxTokens` and `timeoutMs`; the `CLASSIFY_MAX_TOKENS` / `CLASSIFY_TIMEOUT_MS` precedent, `server/src/modules/intent/service.ts:82-84`) |
| AC-NF-11 | The system SHALL NOT add a member to `FeatureModelId` and SHALL NOT change the registered `risk_brief` default. | contract review + a server hermetic test pinning the registry entry (`contracts/platform.ts:14-20,58-64`) |
| AC-NF-12 | Every threshold this feature introduces SHALL live in the module's `constants.ts` rather than inline. | code review against the `specs/01-smart-diff.md` acceptance criterion of the same shape and `server/src/modules/project-context/constants.ts` |

**Input priority, highest first.** The order AC-NF-04 drops from the bottom of:

1. PR title, number, head SHA and the changed-path list — **never dropped**.
2. The persisted intent record (`intent`, `in_scope`, `out_of_scope`,
   `risk_areas`, linked-issue refs).
3. The blast `summary` string and the changed-symbol list.
4. Diff statistics and the per-file `core`/`wiring`/`boilerplate` classification.
5. The per-symbol downstream detail — callers, endpoints, crons.
6. Prior-PR overlap history.
7. Spec documents — dropped last-listed-first, and capped independently at 6
   documents / 12,000 characters by AC-35 before this order is applied.

Documents go first because they are the largest and the least PR-specific;
everything above them is a fact about *this* PR.

## Constraints from the repo

- **The grounding gate is NOT reused as it stands, and the shim must not be
  edited.** `groundFindings(findings: Finding[], diff: UnifiedDiff)` requires a
  `Finding` — `{ file, start_line, end_line, severity, kind, … }` — and a parsed
  unified diff with hunk line numbers, which it uses to build a file →
  new-side-line index (`reviewer-core/src/grounding.ts:23-37,52-83`). A `Risk`
  has `file_refs: string[]` and no lines (`contracts/brief.ts:80-87`), and this
  feature never loads hunk bodies. Meanwhile
  `server/src/platform/grounding.ts` is a **pure re-export shim** over
  `reviewer-core` and is one of three files `server/INSIGHTS.md` *Codebase
  Patterns*, 2026-07-29 names as files that "must not be edited to change
  behaviour".

  So the brief's grounding is stated here as an **outcome**, not a mechanism:
  every `risks[].file_refs[]` entry and every `review_focus[].file` must appear
  in the brief's input data or be dropped before the brief is stored (AC-06,
  AC-07, AC-44), and every drop is recorded (AC-09). Where that check lives —
  brief-local, or a new path-set helper shared from `reviewer-core` — is the
  planner's decision.

  What is not negotiable is the principle: `reviewer-core/INSIGHTS.md`
  *Decisions*, 2026-07-31 — "every finding must cite a real line in the diff or
  it is dropped… the model reliably invents plausible line references, and a
  citation check is verifiable where a self-reported confidence is not."

- **The model's own score is never trusted.** `reviewer-core/CLAUDE.md`
  §Gotchas:26-31 — "The grounding gate is mandatory… The score is **recomputed
  deterministically** from the surviving findings. The model's own score is
  never trusted." AC-30 and AC-31 are that rule applied to `risk_level`, and the
  ordering matters: grounding runs first, the level is computed from what
  survived. A model that invents three `high` risks pointing at files not in the
  PR must not be able to colour the card red.

  `reviewer-core/src/review/scope.ts:5-8` is the same lesson stated for the
  scope filter, and worth quoting because it forecloses the cheap alternative:
  it is enforced "in code, like the grounding gate — a model instruction alone
  is not a guarantee." A prompt sentence saying "only reference files you were
  given" satisfies nothing on its own.

- **`BlastService` and the smart-diff service are not reachable from a new
  module, and the plan must solve that.** The container exposes `pullsRepo`,
  `reviewRepo`, `repoIntel`, `intent`, `projectContext` and
  `projectContextDocs` (`server/src/platform/container.ts:97-104,137-200`) — but
  `BlastService` is constructed inside its own route plugin from `pullsRepo` +
  `repoIntel` (`server/src/modules/blast/routes.ts:18`), and smart-diff
  likewise. `no-cross-module-internals` bans importing another module's
  `service.ts` / `helpers.ts` / `repository.ts`
  (`server/.dependency-cruiser.cjs:29-40`; `server/INSIGHTS.md` *Codebase
  Patterns*, 2026-08-05); only `constants.ts` and `types.ts` cross module
  boundaries, with `settings/feature-models.ts` as the single sanctioned
  exception.

  So "assembles its inputs from what the system already computed" costs
  something structural — a new facade on the container, a recomputation from
  `repoIntel` + `pullsRepo`, or an internal call. **This spec does not pick.**
  It requires only that the brief consume the same facts those modules produce
  (AC-02) and that the architecture rules stay green.

- **`getOrClassify` does not check staleness, and the brief does not call it
  anyway.** `IntentService.getOrClassify` returns any existing `pr_intent` row
  and only classifies when there is none
  (`server/src/modules/intent/service.ts:151-152`), even though the row carries
  a `head_sha` for exactly that purpose. The brief sidesteps this by reading the
  record rather than calling the facade (AC-29), and carries the record's own
  `head_sha` alongside its own so the card can show that the intent predates the
  current head. Whether the intent module should itself treat that as stale is a
  question about that module — see "Deferred follow-ups".

- **Best-effort pre-work is the house pattern, and this feature follows it.**
  Intent, callers, repo map, skills and project context each degrade to "section
  omitted" rather than failing a run
  (`server/src/modules/reviews/run-executor.ts:196-245`). AC-32 and AC-36 hold
  the brief to it, with the difference that the brief *reports* its degradation
  to the user rather than only to the trace.

- **A "the feature is inert" baseline test can pass vacuously.**
  `server/INSIGHTS.md` *What Doesn't Work*, 2026-08-28: a best-effort
  `try/catch` swallows `Cannot read properties of undefined` when a new facade
  is missing from the fake container, so the test proves nothing about the
  wiring it exists to guard. AC-26, AC-29, AC-32 and AC-38 must wire their
  dependencies in the harness and have them **resolve to empty**, not be absent.

- **Nothing in the server runs in a transaction.** `server/INSIGHTS.md` *What
  Doesn't Work*, 2026-08-05: `grep -rn "\.transaction(" src/` returns nothing,
  so a multi-write sequence is non-atomic by construction. AC-15, AC-25 and
  AC-42 are stated against that reality.

- **A `risk_level` is not a verdict.** `Verdict` and `VerdictBanner` already
  exist and belong to a review run
  (`client/src/app/repos/[repoId]/pulls/[number]/_components/VerdictBanner/VerdictBanner.tsx`),
  and `specs/02-blast-radius.md` put that banner out of its scope as "a later
  brief lesson", which makes the collision live. `BriefRiskLevel` is a separate
  four-value enum partly for this reason: its copy must read as "how much
  attention this PR needs", never as approve / request-changes. AC-26 backs it
  with behaviour — no run, no review, no findings.

- **Test lanes are fixed by filename.** DB-backed tests are `*.it.test.ts`
  against a testcontainers Postgres; everything else in `server/` must stay
  hermetic and use `server/src/adapters/mocks.ts` (root `CLAUDE.md`,
  `TESTING.md`). Two traps from `server/INSIGHTS.md` *Recurring Errors & Fixes*
  apply directly to a feature that makes a paid model call: `*.it.test.ts` files
  **self-skip when no Docker daemon is reachable** (2026-07-29), and an it-test
  that triggers a model call can **reach a real provider** on any machine with
  keys in `~/.devdigest/secrets.json` (2026-08-14).

- **`server/test/**` is not type-checked at all.** `tsconfig.json` includes only
  `src/**/*.ts` and vitest transpiles with esbuild, so a structurally wrong
  fixture passes green (`server/INSIGHTS.md` *Recurring Errors & Fixes*,
  2026-08-17, which also gives the throwaway-config recipe).

- **`@testing-library/user-event` is not a dependency of `client/`**
  (`client/INSIGHTS.md` *Tool & Library Notes*, 2026-08-20), so the eleven
  client RTL criteria above use `fireEvent`.

- **The client hand-mirror is caught by the client typecheck, not at runtime.**
  Root `INSIGHTS.md` 2026-08-28: an unmirrored field surfaced as three
  TS2741/TS2322 errors in `client/`. Three files still lag (`adapters.ts`,
  `contracts/eval-ci.ts`, `contracts/productionize.ts`) — all OpenRouter/CI
  gaps, none touching `brief.ts`.

## Resolution log

All fourteen clarifications raised in the 2026-08-29 draft were resolved the
same day. Recorded here so a reader can see what was *chosen* rather than only
what the spec now says — and so a later reversal is visibly a change of
decision, not a gap being filled.

| # | Question | Decision | Lands in |
|---|----------|----------|----------|
| 1 | Is `risk_level` model-chosen or derived? | Model proposes, **server discards it** and recomputes as the maximum severity over the risks that survive grounding. Follows `reviewer-core/CLAUDE.md` §Gotchas. | Goals; Constraints; AC-30, AC-31 |
| 2 | What happens on missing or degraded inputs? | Generate anyway, marked `degraded` with a machine-readable `missing_inputs` list. The brief **never** triggers a classification — that is what keeps "one model call" literally true. | Non-goals; Actors & triggers; Contract changes; AC-29, AC-32, AC-33 |
| 3 | How does the linked issue reach the brief? | **Reference and status only**, from the intent record. No GitHub re-fetch, no persistence of issue text. The model knows a PR claims to close `#123` without knowing what `#123` says. | Non-goals; Input provenance; AC-34 |
| 4 | How are "relevant specs" selected? | Reuse Project Context **discovery** — documents under the repo's configured search roots, filtered to type `spec`, path-ordered, capped at 6 documents / 12,000 characters. No new selector, no attachment dependency, no degradation when there are none. | Scope; Input provenance; AC-35, AC-36, AC-37 |
| 5 | When is a brief generated? | **Explicit user action only.** Rendering the Overview tab is a cached read. No generation on review runs, PR sync or render. | Actors & triggers; AC-16, AC-38 |
| 6 | Who regenerates, and is it limited? | Any workspace member; `rateLimit: { max: 10, timeWindow: '1 minute' }` mirroring `POST /pulls/:id/intent`. No role restriction — the workspace model expresses none. | Routes; AC-NF-06 |
| 7 | Which model? | `risk_brief` exactly as registered (`openai` / `gpt-4.1`). Enum not widened, default not changed. | Scope — out; AC-NF-03, AC-NF-11 |
| 8 | Cache key and invalidation? | **`head_sha` alone.** A mismatch is a visible miss: the stored brief is returned, flagged outdated, with Regenerate offered. Nothing else invalidates — stated as a criterion so the edge is known rather than surprising. | Schema changes; AC-22, AC-40, AC-41 |
| 9 | Columns or `json` blob? | `head_sha`, `model`, `generated_at` as **columns** (queryable key, renderable provenance); the payload stays in `json`. One row per PR, overwritten on regeneration. | Schema changes; AC-42, AC-43, AC-45 |
| 10 | Consume existing findings? | **No.** The brief must mean the same thing before and after a review, and be generatable on a never-reviewed PR. Deferred, not permanently excluded. | Non-goals; Deferred follow-ups |
| 11 | `risk_level` vocabulary? | New four-value `BriefRiskLevel` (`high`/`medium`/`low`/`none`). `RiskSeverity` untouched — it stays the three-valued per-risk vocabulary. | Contract changes |
| 12 | Review-focus addressing? | `{ file, line?, reason }`. `file` required and grounded; `line` optional; `reason` is the one-line why. | Contract changes; AC-44 |
| 13 | `PrBrief`, and which routes? | `PrBrief` untouched; `Brief` added alongside. `GET` returns the stored brief (404 when none), `POST` generates or regenerates — mirroring the intent module exactly. Plus: the pre-staged `brief.json` keys are enumerated so a planner does not read them as requirements. | Scope — out; Routes; AC-28 with its key table; AC-39 |
| 14 | Deep link, and what budget? | Deep link **in scope**: navigate to Files-changed, expand the file even in a collapsed group, scroll to `line`. Mechanism left to the planner. Budget: 24,000-character input cap with a stated drop order, `max_tokens` 1500, 60-second timeout. | Scope; AC-19, AC-46, AC-47; AC-NF-04, AC-NF-10 + the input-priority list |

Three consequences worth carrying forward rather than rediscovering:

- **Decisions 1 and 2 interact.** Grounding runs before the level is computed,
  so a degraded brief built on thin inputs will tend to report a *lower* risk
  level, not a higher one — the card's degraded indication (AC-33) is what stops
  that reading as reassurance.
- **Decisions 8 and 9 make staleness a UI property, not a data-integrity one.**
  A stored brief is never wrong, only possibly out of date, which is why nothing
  deletes or auto-regenerates and why AC-41 spells out what does *not* count.
- **Decision 14's deep link is the only part of this feature that touches shared
  client machinery** (`FileCard`, `SmartDiffViewer`, the PR page's query state).
  Everything else is additive.

## Context consulted

**Specs**

- `specs/README.md` — routing rule: "Forward-looking specs for work that spans
  more than one package… Work that lives inside a single package goes in that
  package's `specs/` instead." This feature touches `server` and `client`, so it
  routes to the root `specs/`. `01`, `02` and `03` are the existing files,
  making `04` the next free number.
- `specs/01-smart-diff.md` (shipped) — per-file classification, the
  `SmartDiffFinding.line` scroll anchor, the "no model call" assertion, and the
  constants-not-inline criterion AC-NF-12 mirrors.
- `specs/02-blast-radius.md` (agreed) — `BlastPanel`, `OverviewTab` as the PR
  Brief surface, and the two explicit deferrals this spec picks up.
- `specs/03-project-context-folder.md` (agreed) — the house format and
  provenance style this file matches; the discovery port and search-roots model
  decision 4 reuses; the `context.json` rewrite precedent AC-28 follows.
- `server/specs/01-mcp-server.md` — checked; the tool set is fixed and this
  feature adds nothing to it.
- `docs/specs/skills.md`, `docs/specs/conventions.md`,
  `docs/specs/project-context-acceptance.md` — checked for an existing PR-brief
  spec. There is none.

**INSIGHTS**

- Root `INSIGHTS.md` — read in full (feature spans two packages). Load-bearing:
  the vendored-shared drift entry and its 2026-08-28 refinement (*What Doesn't
  Work*, 2026-07-29 / 2026-08-28), the pre-staged-scaffolding entry (*Codebase
  Patterns*, 2026-08-05), and the `skills.json` over-promising-copy entry (*What
  Doesn't Work*, 2026-08-05).
- `server/INSIGHTS.md` — read. Load-bearing: the vacuous inert-feature test
  (2026-08-28), the `platform/` re-export shims (2026-07-29), no
  `schema.response` anywhere and no transactions (2026-08-05),
  `no-cross-module-internals` and the `feature-models.ts` exception
  (2026-08-05), `_journal.json` rewriting and the interactive `db:generate`
  prompt (2026-08-05), untyped `server/test/**` (2026-08-17), self-skipping
  it-tests (2026-07-29) and it-tests reaching a real provider (2026-08-14).
- `client/INSIGHTS.md` — read. Load-bearing: the `?tab=` double-whitelist entry
  (2026-08-29, directly relevant to the deep link), the query-key
  prefix-invalidation pattern (2026-08-16), the thread-the-prop-instead check
  (2026-08-04), and `user-event` not being a dependency (2026-08-20).
- `reviewer-core/INSIGHTS.md` — the 2026-07-31 mechanical-grounding-gate
  decision, quoted under Constraints as the reason AC-06..AC-09 exist.

**Docs and READMEs**

- `reviewer-core/CLAUDE.md` §Gotchas:26-34 — the mandatory gate, the
  deterministic score recomputation, and the optional prompt slots. The direct
  citation behind AC-30.
- Root `CLAUDE.md`, `server/CLAUDE.md`, `client/CLAUDE.md` — module
  conventions, contracts-first ordering, the test-lane split.
- `reviewer-core/README.md` — the grounding gate and the optional prompt slots.

**Source read**

`server/src/vendor/shared/contracts/{brief,review-api,platform,project-context,trace}.ts`;
`server/src/db/schema/reviews.ts`; `server/src/platform/{container,grounding}.ts`;
`server/src/modules/intent/{service,routes,types}.ts`;
`server/src/modules/blast/{service,routes,types,constants}.ts`;
`server/src/modules/project-context/{routes,types,constants}.ts`;
`server/src/modules/settings/feature-models.ts`; `server/test/grounding.test.ts`;
`reviewer-core/src/grounding.ts`; `reviewer-core/src/review/scope.ts`;
`client/src/app/repos/[repoId]/pulls/[number]/page.tsx`;
`client/src/app/repos/[repoId]/pulls/[number]/_components/{OverviewTab,IntentCard,DiffTab,SmartDiffViewer,VerdictBanner}/`;
`client/src/components/diff-viewer/FileCard/FileCard.tsx`;
`client/src/lib/hooks/{intent,smart-diff}.ts`; `client/src/i18n/request.ts`;
`client/messages/en/brief.json`.

**MCP**

The `devdigest` server was reachable. `devdigest_list_agents` returned five
configured reviewers, all on `deepseek/deepseek-v4-flash` (Security, API
Contract, Performance and General enabled; Test Quality disabled) — confirming
this feature needs **no new reviewer agent**, since the brief is not an agent
run. `devdigest_get_conventions` for `ai-agentic-engineering-neo/dev-digest`
returned only two low-confidence rules (constant grouping with `[T1]`/`[T2]`
phase tags; a hooks barrel re-exporting domain hook files), neither of which
this spec needs to re-require. `devdigest_get_blast_radius` over the five files
this feature's change area touches returned only the two `OverviewTab` symbols
with zero callers and zero impacted endpoints — the indexed snapshot does not
resolve the `server/src` paths, so it is **not** evidence that the server change
area is caller-free. `devdigest_get_findings` could not run: no pull request of
this repository is synced into DevDigest, so there is no finding baseline.

## Open questions

**None.** All fourteen clarifications from the 2026-08-29 draft are resolved and
no clarification markers remain in this document. This spec is plannable.

### Deferred follow-ups

Not gaps — decisions to build something *later*, recorded so the next session
does not re-derive them as open questions.

1. **A dedicated per-repository "brief context" selector.** Decision 4 uses
   discovery filtered to type `spec`, which needs no new storage and no new UI.
   If maintainers find the brief reading the wrong documents, the next step is a
   per-repo selection surface — a strictly larger feature than the search-roots
   setting `specs/03-project-context-folder.md` already added.

2. **Consuming the PR's existing review findings.** Decision 10 excludes them so
   the brief means one thing regardless of whether a review has run. A later
   feature could add a *separate*, clearly-labelled "after review" section
   rather than silently changing what the same field means.

3. **Whether `IntentFacade.getOrClassify` should itself check staleness.** It
   returns any existing row without comparing `head_sha`
   (`server/src/modules/intent/service.ts:151-152`). The brief works around it
   by reading the record directly (AC-29) and carrying both SHAs, so this
   feature is unblocked — but the review path still consumes a possibly-stale
   intent, and that is a question about the intent module, not this one.

4. **Whether a brief should be exposed over MCP.** Out of scope here
   (`server/specs/01-mcp-server.md` fixes the tool set), but a brief is exactly
   the kind of pre-read summary an MCP client would want, and the projection
   rules for it would need the same care `mcp/projections.ts` already applies.
