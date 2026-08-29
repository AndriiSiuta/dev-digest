# Insights — client

UI decisions and dead ends. Read before restructuring pages, state, or the data
layer.

Read at the start of a task, written at the end of one, by the
`engineering-insights` skill. Sections are fixed — add to the one that fits,
newest first. If it would be obvious to anyone reading the code, leave it out.

Formats — `Decisions` takes prose; every other section takes a dated bullet:

```markdown
### YYYY-MM-DD — <short title>

**What:** the decision, in one sentence.
**Why:** the constraint that forced it.
**Rejected:** what we tried or considered, and how it failed.
```

```markdown
- **YYYY-MM-DD** — <the claim, specific enough to act on cold>.
  `src/path/to/file.tsx:42`
```

Roughly 5 entries per section. Promote stable entries into `docs/` and delete
them here.

---

## Decisions

_None yet. Add the first one the next time a UI approach is tried and
abandoned — that is exactly what this file is for._

## What Works

_None yet._

## What Doesn't Work

- **2026-08-29** — An effect that reacts to an OBJECT prop rebuilt by the
  parent on every render, and whose body sets state another effect then
  clears, loops forever. `FileCard`'s deep-link effect (`setOpen(true)` +
  `setJumpLine(focus.line)`) with `[focus]` as its dependency re-fires after
  the scroll effect resets `jumpLine` to `null`, so the file re-scrolls on
  every render — `SmartDiffViewer` builds `focus={{ line: focus.line }}`
  inline. Depend on the PRIMITIVES instead (`const focused = focus != null;
  const focusLine = focus?.line ?? null;` → `[focused, focusLine]`); memoizing
  in the parent would work too but leaves the trap armed for the next caller.
  `src/components/diff-viewer/FileCard/FileCard.tsx:73-80`

## Codebase Patterns

- **2026-08-29** — A tab editor's `?tab=` whitelist is defined TWICE — once as
  the tab strip (`_components/<Editor>/constants.ts`) and once as the route's
  `VALID_TABS` — so adding a tab to the strip alone ships a tab that is
  clickable, sets `?tab=`, and is then silently rejected by the page's fallback
  to `"config"`. That is exactly how the agent editor's Context tab shipped
  dead. Derive it (`export const VALID_TABS: readonly string[] = TABS.map((t)
  => t.key)`) as `src/app/skills/constants.ts:45` does. Component-level tests
  cannot catch this — they render the editor with `tab` already set; the cheap
  guard is a page-level test that mocks `next/navigation`, `app-shell` and the
  editor itself down to `({ tab }) => <div>tab: {tab}</div>` and asserts every
  key in `TABS` round-trips. `src/app/agents/[id]/page.test.tsx`,
  `src/app/agents/[id]/_components/AgentEditor/constants.ts:19`

- **2026-08-16** — A query key can piggyback on an EXISTING invalidation call
  for free: `useSmartDiff` uses `["reviews", prId, "smart-diff"]` (not its own
  top-level key) precisely because TanStack Query's `invalidateQueries`
  defaults to prefix matching, so every already-existing
  `invalidateQueries({ queryKey: ["reviews", prId] })` call (run done,
  delete-run, delete-review, finding accept/dismiss) invalidates the smart-diff
  query too with zero new call sites. The one place that does a bare `refetch()`
  instead of `invalidateQueries` (`page.tsx`'s `onRunDone` →
  `refetchReviews()`) does NOT cascade this way — a direct refetch of one key
  is not a cache invalidation, so that call site needed one explicit
  `invalidateQueries({ queryKey: ["reviews", prId, "smart-diff"] })` alongside
  it. `client/src/lib/hooks/smart-diff.ts`,
  `client/src/app/repos/[repoId]/pulls/[number]/page.tsx` (`onRunDone`).

- **2026-08-04** — Before adding a new hook/endpoint to show "more detail on
  X" in a component, check whether the detail is already fetched elsewhere on
  the same page and can be threaded down as a prop instead. `RunHistory` only
  ever received `RunSummary[]` (denormalized `critical_count`/`warning_count`/
  `suggestion_count`, no finding detail), but `FindingsTab` — its direct
  parent — already holds the full `ReviewRecord[]` (each with a `findings:
  FindingRecord[]` and `run_id`) via `usePrReviews`. Adding a hover preview of
  a run's findings needed only `new Map(runs.map(r => [r.run_id,
  r.findings]))` in `FindingsTab` passed down as `findingsByRun`, zero new
  API/hook. `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsTab/FindingsTab.tsx:75`

## Tool & Library Notes

- **2026-08-20** — `@testing-library/user-event` is NOT a dependency of this
  package, so RTL guidance prescribing `userEvent.setup()` fails at import
  time with vite's `Failed to resolve import "@testing-library/user-event"`.
  Component tests here use `fireEvent` from `@testing-library/react` — the
  established harness — and must not add the package just for one test.
  `src/app/repos/[repoId]/pulls/[number]/_components/SmartDiffViewer/SmartDiffViewer.test.tsx`

- **2026-08-04** — This dev environment's seeded Postgres has zero
  `agent_runs` rows with `findings_count > 0` across all 3 seeded repos
  (`acme/payments-api`, `myasoid/dev-digest`, `quarkusio/quarkus`) — every
  seeded review is a clean 0-findings/100-score run. To visually verify any
  findings-related UI change, either trigger a real (costly) LLM review run,
  or temporarily `INSERT` rows into `findings` + bump the matching
  `agent_runs.critical_count`/`warning_count`/`suggestion_count`/
  `findings_count`, screenshot, then delete/revert immediately after —
  confirmed safe and fully reversible on the local dev DB
  (`postgres://devdigest:devdigest@localhost:5432/devdigest`). Separately, no
  `chromium-cli` or `agent-browser` CLI was present in this sandbox; `npx
  playwright install chromium` (no `--with-deps`, which needs sudo) downloads
  a working headless Chromium fine, so a scratch `npm install playwright` +
  a small driver script is the fallback for one-off browser verification here.
  - **2026-08-20** — No download needed when `~/.cache/ms-playwright` already
    holds a chromium from another project: a freshly installed `playwright`
    demands its own pinned revision (`Executable doesn't exist at
    …chromium_headless_shell-1234…`), but `chromium.launch({ executablePath:
    "~/.cache/ms-playwright/chromium_headless_shell-<rev>/chrome-headless-shell-linux64/chrome-headless-shell" })`
    runs fine against the older cached revision. Also: a Playwright
    `hasText: 'Blast Radius'` section locator matches the PR DESCRIPTION card
    too when the PR body mentions the feature (matching is case-insensitive
    substring) — filter on the uppercase rendered title (`'BLAST RADIUS'`)
    and take `.first()`, not `.last()`.

## Recurring Errors & Fixes

- **2026-08-29** — A client **value** import from `@devdigest/shared` (e.g. a
  zod schema for `safeParse`) breaks `next dev`/`build` with
  `Module not found: Can't resolve './contracts/findings.js'` — the vendored
  barrel uses `.js`-suffixed ESM specifiers that tsc resolves but the Next
  bundler does not (no `extensionAlias`). Every existing client import from
  shared is `import type` (erased at build), so the barrel had never been
  bundled before; typecheck AND the whole vitest suite stay green — only the
  running app fails. Keep client imports from `@devdigest/shared` type-only
  and hand-roll a narrow guard where runtime validation is needed.
  `client/src/app/agents/[id]/_components/AgentEditor/_components/EvalsTab/EvalsTab.tsx`
  (`parseExpectation`).

- **2026-08-29** — Adding a data hook to a widely-embedded leaf component
  breaks every test that renders it through a PARENT: `useCreateEvalCase()`
  inside `FindingCard` made `FindingsPanel.test.tsx` fail with `No QueryClient
  set, use QueryClientProvider to set one` (and `MISSING_MESSAGE` for the new
  namespace), because jsdom tests render without the app's providers. The
  component's own test mocking the hook module is not enough — every suite
  that renders an ancestor needs the same `vi.mock("@/lib/hooks/eval", …)` and
  the new messages namespace in its `NextIntlClientProvider`. Find them with
  `grep -rl <Component> src --include=*.test.tsx` plus the components those
  files render. `src/app/repos/[repoId]/pulls/[number]/_components/FindingsPanel/FindingsPanel.test.tsx`

- **2026-08-29** — Running `next build` in `client/` while `next dev` is
  running on :3000 replaces the dev server's `.next/` with a production build,
  and EVERY route then answers 500 (`_error.js` HTML) until dev is restarted —
  touching a source file does not recover it, because `.next/static/development/*`
  is gone. `pnpm build` is a legitimate gate (it is what catches a message
  namespace changing shape), so run it knowingly and recover with
  `rm -rf client/.next` then restart `next dev`. Symptom to recognise:
  `.next/` holding `BUILD_ID` + `prerender-manifest.json` while dev is up.

- **2026-08-04** — `fireEvent.mouseEnter` on a component whose hover-open
  logic uses `setTimeout` (e.g. an open delay to survive a mouse
  pass-through) needs `vi.useFakeTimers()` **and** the timer advance wrapped
  in `act()` from `@testing-library/react`:
  `act(() => { vi.advanceTimersByTime(150); })`. Without the `act()` wrapper,
  the state update from the timer callback doesn't flush before the
  assertion runs — `aria-expanded` stays `"false"` and the popover content is
  never found, even though the component logic is correct.
  `client/src/app/repos/[repoId]/pulls/[number]/_components/RunHistory/RunHistory.test.tsx`

- **2026-08-01** — A vitest failure whose two sides look identical —
  `expected '9 119 tok' to be '9 119 tok'` — is a look-alike Unicode space, not
  an environment difference. `formatTokenCount` had a literal THIN SPACE
  (U+2009) typed into `.replace(/,/g, " ")`, invisible in the diff and in the
  test output. Dump code points first —
  `[...s].map((c) => c.charCodeAt(0).toString(16))` — before theorising about
  ICU or jsdom locale data, which is where this was initially misdiagnosed.
  Group digits with `.replace(/\B(?=(\d{3})+(?!\d))/g, " ")` rather than
  `toLocaleString` plus a separator swap, so the separator is a plain U+0020 a
  test can type. Find strays with `rg '\x{2009}' src/`.
  `client/src/lib/format.ts:40`

## Open Questions

_None yet._
