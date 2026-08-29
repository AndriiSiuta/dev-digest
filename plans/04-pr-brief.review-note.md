# Cross-family review of `plans/04-pr-brief.plan.md`

**Reviewer:** `deepseek/deepseek-v4-pro` via OpenRouter — a different model family from the
one that wrote the spec and the plan (both Claude Opus 5).
**Date:** 2026-08-29 · **Cost:** $0.056 · 36,117 prompt / 6,657 completion tokens.
**Input:** the full spec + full plan, with instructions to report only real problems.
**Verdict returned:** `needs revision` — 20 findings.

**Triage: 14 accepted, 6 rejected.** Three of the rejections were factual errors that
would have caused real damage if applied blind, which is the argument for the step.

## Accepted — folded into the plan

| # | Finding | Fix |
| - | ------- | --- |
| 1 | AC-08's endpoint gate can pass vacuously: if a test's stubbed draft omits `endpoint_refs`, the filtering path never runs. | The AC-08 case must stub `endpoint_refs: ['POST /nonexistent']` on a risk whose `file_refs` are all valid, and assert that risk is **dropped**. |
| 2 | AC-25 asserted `llm.calls` grows "by at most two" — that also passes at 0 or 1 calls. | Assert **exactly** 2, plus both responses carrying fresh `generated_at`. |
| 3 | `fitToBudget` dropped individual documents before dropping the whole lower-priority section, contradicting the spec's "drop whole inputs". | Treat the assembled document section as **one atomic input** at the lowest priority. Per-document culling belongs to `selectSpecDocs` (AC-35), before budget fitting. |
| 4 | The AC-30 test only proved the model's `risk_level` is overridden when it *disagrees*. | Stub `risk_level: 'none'` with surviving `high` risks and assert `'high'` — proves the field is never read. |
| 5 | Task 11 spied on `BriefFacade.generate`, which both false-positives (a cache hit spends nothing) and false-negatives. | Assert **no `PrBriefDraft` structured completion** occurred, and no `saveBrief`. That is what AC-38 protects: the paid call. |
| 7 | The zero-files early return happened after gathering blast and documents. | Move it immediately after the smart-diff call, before any other input is gathered. |
| 8 | The grounding file set was the smart-diff path set, which can be a **subset** of the PR's changed files — a model citing a real-but-unclassified file would be wrongly dropped. | Build the grounding universe from the PR's full changed-path list; smart-diff supplies classification and stats only. |
| 9 | The log line carried `dropped: <counts only>`, losing which invention was caught. | Log the full `{ target, ref, reason }` records. These are identifiers, not content, so AC-NF-02 still holds. |
| 10 | The `brief.json` test asserted `why` is a string but never that the old `why.title` / `why.blame` / `why.noHistory` / `why.noCommits` are gone. | Assert each is `undefined`. |
| 12 | `PrBriefCard`'s `headSha` prop was threaded through `OverviewTab` and never read — the envelope already carries both SHAs. | Remove the prop. |
| 15 | The AC-41 it-test needs to mutate the document fixture mid-test, with no stated mechanism. | `MockProjectContextDocs` reads from a variable the test reassigns between generate and verify. |
| 16 | A throw from `reposRepo.getSearchRoots` was uncaught, failing the whole generate. | Catch it; record `{ kind: 'project_context', status: 'unreachable' }` and continue with no documents. |
| 17 | `logger` was optional, so AC-NF-05's "SHALL record model, tokens, cost" could silently not happen. | Make the logger required on the `generate` path. |
| 18 | `getBrief`'s description only mentioned `Brief.parse(row.json)`; a `select({ json })` would leave `headSha` undefined and defeat the cache check on every request. | State explicitly that the query selects `head_sha`, `model` and `generated_at` alongside `json`. |

## Rejected — with the evidence

| # | Claim | Why it is wrong |
| - | ----- | --------------- |
| 6 | The route should not throw `NotFoundError` with its own message. | That is exactly the house precedent: `intent/routes.ts:28` throws `NotFoundError('Intent not classified yet')` and the shared handler maps it. |
| 11 | `?focus=` / `?line=` are never cleared after navigation. | Deliberate. Keeping them is what makes the deep link shareable and survive a reload — the same property `?trace=` has. |
| 13 | `projectContextDocs` is not on the container, so Task 8 will fail at runtime. | False. It is a getter at `server/src/platform/container.ts:198`. |
| 14 | `resolveFeatureModel`'s signature may not match the call. | False. `server/src/modules/settings/feature-models.ts:51-55` is `(container, workspaceId, id)`, exactly as planned. |
| 19 | Re-clicking the same focus item will not re-fire the effect without a nonce. | The card renders only on the Overview tab, so activating a focus item always crosses an `overview → diff` tab change, which remounts the viewer. |
| 20 | The plan invents `reviewRepo.getIntent`, duplicating the intent module's read logic. | False, and the most dangerous of the three. `IntentService.get` is itself `return this.container.reviewRepo.getIntent(prId)` (`server/src/modules/intent/service.ts:46`). The plan uses the identical path; the "fix" would have added a redundant facade method. |

## What this says about the artefacts

No finding challenged the feature's shape, the contract, the cache key or the
architecture — the disagreements were entirely about **test rigour**. Eight of the
fourteen accepted findings (1, 2, 4, 5, 10, 15, 18 and part of 9) are tests that would
have passed without proving what their AC claims. That is the class of defect a
same-family reviewer is least likely to catch, and it is worth the $0.06.
