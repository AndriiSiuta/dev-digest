# Smart Diff — reviewer-ordered "Files changed" tab

**Status:** shipped
**Packages touched:** server, client

## Problem

Reviewers currently see a PR's changed files in raw GitHub order — lock-files,
generated code, and business logic all mixed together. There is no signal
telling a reviewer which files matter, and no way to jump straight from "this
file has findings" to the line that has them.

## Scope — in / out

In scope:

- Deterministic classification of every changed file into `core` / `wiring` /
  `boilerplate`, computed from the path alone (no model call).
- Reordering the "Files changed" tab so `core` sorts first, `boilerplate`
  collapses by default.
- Overlaying the latest review's findings (per-agent union, dismissed
  included) as clickable badges that expand a file and scroll to the line.
- A split suggestion when the reviewable (core+wiring) surface is too big.

Out of scope (left for a later lesson):

- `pseudocode_summary` — the field exists on the contract and stays `null`.
- Any model-assisted classification. Smart Diff is a pure recombination of
  already-imported PR files and already-computed review findings.

## Contract changes

`@devdigest/shared` (`server/src/vendor/shared/contracts/brief.ts`, hand-mirrored
into `client/src/vendor/shared/contracts/brief.ts`):

- New `SmartDiffFinding` schema: `{ id, line, end_line, severity, title }` —
  `line` is the new-side start line, the scroll anchor.
- `SmartDiffFile` gains a `findings: SmartDiffFinding[]` field alongside the
  existing `finding_lines: number[]` (kept for CI/brief consumers that only
  need line numbers).
- `SmartDiffRole`, `SmartDiffGroup`, `ProposedSplit`, `SmartDiff`,
  `SmartDiffResponse` are unchanged.

New route: `GET /pulls/:id/smart-diff` → `SmartDiffResponse`
(`server/src/modules/smart-diff/`).

## Design notes

- **"Latest review"** = each agent's latest `kind:'review'`, findings unioned
  across agents — the same rule `modules/pulls/helpers.ts`'s
  `pickCountedReviews` applies to the PR-list finding counts.
- **Classification** is a deterministic path-pattern match
  (`modules/smart-diff/classifier.ts` + `constants.ts`): lock-file basename →
  `boilerplate`; boilerplate path pattern → `boilerplate`; wiring path
  pattern → `wiring`; else `core`. Docs (`*.md`, `docs/`) and migration
  `*.sql` classify `wiring`; migration `*_snapshot.json` stays `boilerplate`.
- **Sort within a group**: has-findings → max severity → findings count →
  source-before-tests → churn (additions+deletions) desc → path asc (a
  deterministic tiebreak, since `pr_files` reads back in no guaranteed order).
- **Split suggestion** is computed over `core`+`wiring` files only, keyed by
  each file's top-2 path segments; empty when under threshold or when fewer
  than 2 distinct keys exist (nothing meaningful to propose).
- Computed **fresh on every request** — nothing about Smart Diff is
  persisted, so it always reflects the PR's current files and the latest
  review.

## Acceptance criteria

- A lock-file (`package-lock.json`, `pnpm-lock.yaml`, …) is always
  `boilerplate` and starts collapsed in the UI, regardless of size or
  findings.
- Clicking a file's findings badge expands the file and scrolls to the
  finding's line, showing a severity chip.
- No new model call is made by this route (`grep -rn "llm\|resolveFeatureModel
  \|prompt-log" server/src/modules/smart-diff/` returns nothing; every
  `MockLLMProvider.calls` stays `[]` across the integration tests).
- Every threshold and pattern lives in a `constants.ts` (server:
  `modules/smart-diff/constants.ts`; client:
  `SmartDiffViewer/constants.ts`), nothing inline.

## Open questions

- Whether `pseudocode_summary` should eventually be filled in by a cheap
  model call per `core` file — deliberately deferred; Smart Diff v1 makes no
  model call at all.
