# Blast Radius panel (L04)

**Status:** agreed
**Packages touched:** server, client

## Problem

`repo-intel` already computes blast radius — `repoIntel.getBlastRadius(repoId,
files)` returns changed symbols, resolved callers with lines, and per-file
endpoint/cron facts — but nothing user-facing consumes it. A reviewer looking at
a PR cannot see which symbols the diff touches, who calls them, or which HTTP
endpoints and cron jobs sit downstream. The MCP tool
`devdigest_get_blast_radius` is a deliberate stub for the same reason.

This lesson builds the Blast Radius panel on the PR page: a per-symbol tree
(symbol → callers → endpoint/cron badges), header counts, and a collapsed
"Prior PRs touching these files" row.

## Scope — in / out

**In**

- New `server/src/modules/blast/` module: `GET /pulls/:id/blast`, computed
  fresh on every request (smart-diff pattern). No POST, no persistence, no LLM.
- Mapping `BlastResult` (repo-intel shape) → the shared `BlastRadius` contract.
- Prior-PR overlap query: other PRs in the repo sharing ≥ 1 changed path.
- The one-line MCP stub swap in `mcp/tools/blast-radius.ts`, now that a lesson
  consumes the facade.
- Client: `OverviewTab` becomes the PR Brief surface — `IntentCard` moves there
  from `FindingsTab`, side by side with the new `BlastCard`, above the PR body.

**Out**

- Graph view (the Tree/Graph toggle is not rendered; tree only).
- The verdict banner ("Request changes / PR score") from the mockup — a later
  brief lesson.
- `pr_brief` persistence and the composed `PrBrief` route — the table stays
  empty by design.
- A real `merged_at` column (see Schema changes).
- Feeding blast facts into the review prompt (run-executor already handles
  that separately).

## Contract changes

`@devdigest/shared` `contracts/brief.ts` already defines the building blocks
(`BlastRadius`, `DownstreamImpact`, `BlastCaller`, `PrHistory`) — they are
unchanged. Add one route-level composition:

```ts
export const BlastPanel = z.object({
  blast: BlastRadius,
  history: PrHistory,
  /** true on the ripgrep fallback — no crons, no caller ranks. */
  degraded: z.boolean(),
  head_sha: z.string(),
});
```

Lands in `server/src/vendor/shared/` first, then hand-sync
`client/src/vendor/shared/`.

## Routes

`GET /pulls/:id/blast` — params `IdParams`, response `{ 200: BlastPanel }`,
workspace-scoped via `getContext`, declared `schema.response` (serializer as
output allowlist). Registered as one plugin in `modules/index.ts`.

Service flow:

1. Changed paths from `pr_files` via `container.pullsRepo`.
2. `repoIntel.getBlastRadius(repoId, paths)`.
3. Map `BlastResult` → `BlastRadius`:
   - `changedSymbols` → `changed_symbols` verbatim (`name`, `file`, `kind`).
   - Group `callers[]` by `viaSymbol` into `downstream[]`; each caller row
     becomes `{ name: <caller symbol>, file, line }`.
   - `endpoints_affected` / `crons_affected` per symbol from `factsByFile`
     keyed by caller file. Degraded path (`factsByFile` absent): the flat
     `impactedEndpoints` union attaches to the first downstream entry,
     `crons_affected` stays empty, `degraded: true`.
   - `summary` is deterministic, e.g. `"2 symbols · 14 callers · 3 endpoints ·
     1 cron"` — no model call.
4. `history`: overlap query (below), capped at 5, newest first.

## Schema changes

**None. No migration.** Prior-PR overlap is a `pr_files` self-join by `path`
scoped to the repo, added as a read method on `pulls/repository.ts`.
`PrHistoryItem.merged_at` is **derived**: `updatedAt` when
`status === 'merged'`; open/closed PRs are still listed and carry the same
derived timestamp semantics (documented approximation — a real `merged_at`
column is deliberately out of scope).

## Adapters needed

**None.** No new port, no new dependency. The blast service reads two existing
container members: `pullsRepo` and the `repoIntel` facade (third consumer of
the existing facade pattern).

## MCP

`mcp/tools/blast-radius.ts` executes its marked one-line swap:
`return projectBlast(await env.deps.repoIntel.getBlastRadius(...))`.
`projectBlast` already strips `factsByFile` and the full caller list, so the
`01-mcp-server.md` security assertion ("never emits `factsByFile`") holds
unchanged. Update that spec's tool table row from stub to live.

## Client

- `OverviewTab` renders a PR Brief section: `IntentCard` (moved from
  `FindingsTab:87`) beside the new `BlastCard`, PR body below.
- `BlastCard` (`_components/BlastCard/`): header count chips (symbols /
  callers / endpoints / crons), collapsible per-symbol tree following the
  `SmartDiffViewer` collapsible-group pattern, endpoint/cron `Badge`s under
  each symbol's callers, and a collapsible "Prior PRs touching these files"
  footer with count. Built from existing `vendor/ui` primitives (`Card`,
  `Badge`, `Chip`, `EmptyState`, `Skeleton`) — no new dependencies, no generic
  tree primitive.
- One data hook `useBlastPanel` in `client/src/lib/hooks/blast.ts`, copying
  the smart-diff hook's GET pattern. States: loading skeleton, empty (no
  changed symbols), degraded note ("partial index — endpoints/crons
  incomplete"), populated.

## Acceptance criteria

- `GET /pulls/:id/blast` returns a `BlastPanel` that parses against the shared
  schema; unknown PR → 404 via the shared error handler; nothing is persisted.
- Grouping is correct: every `callers[]` row lands under exactly one
  `downstream[]` entry keyed by its `viaSymbol`; endpoint/cron attribution
  follows `factsByFile`; degraded input yields `degraded: true` and empty
  `crons_affected`.
- Overlap query returns only PRs from the same repo sharing ≥ 1 path,
  excludes the PR itself, is capped and ordered newest first.
- MCP `devdigest_get_blast_radius` returns real data; the projection still
  never emits `factsByFile`; `test/mcp-budget.test.ts` and
  `test/mcp-projections.test.ts` stay green.
- Client: Overview tab shows Intent + Blast side by side; `IntentCard` no
  longer renders in `FindingsTab`; all four `BlastCard` states render; no
  Graph toggle exists in the DOM.
- `pnpm typecheck` clean in `server/` and `client/`; hermetic vitest lanes
  pass in both.

## Testing

- Server hermetic: mapper unit tests (grouping, facts attribution, degraded
  shape, summary string); route test with a mocked `repoIntel` facade.
- Server DB-backed (`*.it.test.ts`): the `pr_files` overlap query.
- Client RTL: `BlastCard` four states; `OverviewTab` shows both cards;
  `FindingsTab` no longer mounts `IntentCard`.
- e2e: none in v1.

## Open questions

None — placement, persistence, prior-PR derivation, and tree-only scope were
decided 2026-08-20 (restructure Overview; fresh GET; derived `merged_at`;
graph deferred).
