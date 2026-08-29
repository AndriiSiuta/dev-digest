# server — insights

Durable findings recorded by the `engineering-insights` skill: things that are
true about this code but not visible in it. Append-only — correct a stale entry
with a dated note beneath it rather than editing it away.

Sections are fixed. Add to the one that fits; never invent a new heading.

## What Works

- **2026-08-05** — Field ORDER in a `completeStructured` zod schema is generation order, and moving the classification/score fields to LAST is what makes them informative: with `category` and `confidence` declared before `rule`, a live conventions scan of `angular-osf` labelled all 12 candidates `imports` and scored every one exactly 0.90; with them after `rule` + evidence (plus an `occurrences` count the model must fill in first), the same model on the same repo returned 5 distinct categories and confidences spanning 0.50-0.95. Evidence: `src/modules/conventions/prompt.ts` (`ExtractionSchema` field order + the note on it).

## What Doesn't Work

- **2026-08-17** — `severityCounts` in `src/modules/mcp/projections.ts:125`
  guards with `if (f.severity in counts)`, and `in` walks the PROTOTYPE chain,
  so a finding whose severity is `'toString'` / `'constructor'` / `'valueOf'`
  passes the guard and adds a FOURTH key to a payload documented as "always all
  three keys": `counts['toString'] += 1` yields
  `{"CRITICAL":0,"WARNING":0,"SUGGESTION":0,"toString":"function toString() {
  [native code] }1"}`. Not hypothetical — `findings.severity` is free text with
  no CHECK (`text(…,{enum})` narrows TS only) and `findingRowToDto`
  (`src/modules/reviews/helpers.ts:45`) casts it straight to the `Severity`
  union, so the value is whatever a model once wrote. The fix is
  `Object.hasOwn(counts, f.severity)` or an explicit `SEVERITY_ORDER.includes`.
  Same class of hazard anywhere a DB string indexes a literal accumulator.
  **Fixed 2026-08-17 in `src/modules/mcp/projections.ts`** (`Object.hasOwn`), so
  the warning is historical for that call site — the generalisation in the last
  sentence is what still applies. Found by `test/mcp-projections.test.ts` asserting
  key-set *equality* rather than `toMatchObject`; a containment assertion would
  have passed against the bug.

- **2026-08-17** — `ctx.mcpReq.signal` never aborts when the MCP transport is
  built per-request (`new NodeStreamableHTTPServerTransport({sessionIdGenerator:
  undefined})` inside the route handler), so any code hanging cancellation off
  it is dead. Measured twice: killing the client socket mid-flight leaves the
  handler running to completion (`aborted=false` after 90 s, only `reply.raw
  close` fires), and an explicit `notifications/cancelled` POSTed on a second
  connection is answered `202 Accepted` but lands on a FRESH `McpServer`, so it
  can never reach the in-flight request. Positive control: hoist the transport
  and `McpServer` to module scope and the same cancel aborts the signal in
  ~4 ms with `reason=user` — the SDK is fine, the per-request wiring is what
  makes it unreachable. Trading up to a shared transport means owning session
  state, so the honest v1 answer is to treat the signal as inert and rely on a
  wait budget instead. Evidence: measured against a throwaway Fastify app on
  `@modelcontextprotocol/{server,node}@2.0.0` + Fastify 5.8.5.

- **2026-08-14** — The intent classifier's one structured log line was dead on
  the review path, and the reason is invisible from the line itself: it is
  `logger?.info(...)`, and `IntentService.getOrClassify` — the only entry point
  the review path uses — called `this.classify(workspaceId, pull.id)` with no
  logger, so a classification triggered by a review logged NOTHING while one
  triggered by `POST /pulls/:id/intent` (which passes `req.log`) logged fully.
  An optional `logger?` that some callers omit is a silent observability hole,
  not a degraded mode. **Fixed 2026-08-14**: `getOrClassify` now takes
  `(workspaceId, pull, correlationId?, logger?)` and `run-executor` threads its
  pino logger + the first queued `runId` through `resolveIntentBlock`. Evidence:
  `src/modules/intent/service.ts` (`getOrClassify`),
  `src/modules/reviews/run-executor.ts` (`resolveIntentBlock`).

- **2026-08-28** — A "the feature is inert, pin the baseline" test passes
  VACUOUSLY when the new facade is not on the fake container: `runOneAgent`
  wraps every prompt-enrichment call in a best-effort `try/catch`, so
  `this.container.projectContext.resolveForRun(...)` on an undefined facade
  throws `Cannot read properties of undefined`, gets swallowed, and the prompt
  is byte-identical for the wrong reason — proving nothing about the wiring the
  test exists to guard. The fix is to wire the facade in the harness and have it
  RESOLVE TO EMPTY (`{specs: [], specsRead: [], tokens: 0}`), so the empty case
  runs the real code path. Same trap applies to `intent`, `repoIntel` and any
  future best-effort slot. Evidence: `server/test/helpers/run-executor.ts`
  (`projectContext` default), `src/modules/reviews/run-executor.ts`
  (`buildProjectContext`).

- **2026-07-29** — A green `pnpm test` does not mean the integration tests ran: `*.it.test.ts` files self-skip when no Docker daemon is reachable, so a machine without Docker reports success having exercised none of the DB paths. Evidence: `server/test/helpers/pg.ts:10`.

- **2026-07-29** — `TESTING.md:43` promises a Windows `typecheck` job as the `@ast-grep/napi` prebuilt gate; the gate no longer exists, so a missing win32 prebuilt now reaches users uncaught. Evidence: commit `b7838c8` *"ci(server): drop the Windows typecheck matrix"*.

- **2026-07-29** — `TESTING.md:83` explains the test-lane invocation by claiming `server/package.json` is `skip-worktree`; it is not, in a fresh clone, so anyone reasoning from that premise is reasoning from a local artifact. Evidence: `git ls-files -v | grep -v '^H'` returns nothing. The consequence it describes still holds — CI calls `pnpm exec vitest run …` because no `test:unit` / `test:integration` scripts are committed.

- **2026-08-05** — Not one route declares `schema.response`, so the zod serializer compiler wired at `app.ts:65` has nothing to compile: the response allowlist that would stop a handler leaking extra fields is inactive, and the `isResponseSerializationError` branch at `app.ts:130-134` is unreachable. Evidence: `grep -rn "response:" src/modules/` returns nothing across 37 routes in 8 modules.

- **2026-08-05** — Nothing in the server runs inside a DB transaction, so multi-write sequences are non-atomic by construction — a crash mid-`insertReview`→`insertFindings`→`markReviewed` leaves a findings-less review on a PR already marked reviewed, and the `delete`+`insert` of `pr_files`/`pr_commits` inside the PR-detail GET can destroy the persisted diff the offline path falls back to. Evidence: `grep -rn "\.transaction(" src/` returns nothing; `src/modules/reviews/run-executor.ts:218-234`, `src/modules/pulls/routes.ts:240-263,279`.

- **2026-08-05** — `src/db/schema/reviews.ts` and `src/db/schema/runs.ts` declare zero indexes, so the queries the PR list and the 4s active-runs poll actually run (`inArray(findings.reviewId, …)`, `reviews` by `pr_id`, `agent_runs` by `pr_id`+`ran_at`) have no index behind them — Postgres does not index foreign keys automatically. Evidence: `src/modules/pulls/routes.ts:131-133,158,176-180`.
  - **2026-08-05** — Resolved: the three indexes exist, but note the trap that nearly shipped them dead — adding `index()` to a Drizzle schema changes NOTHING until `pnpm db:generate` writes a migration, and this repo does not apply migrations on boot, so the TypeScript and the database disagreed silently. Evidence: `src/db/migrations/0012_silky_diamondback.sql` (was `0011_…` before the journal repair renumbered 0011–0015 to 0012–0016).
    - **2026-08-05** — The second half of that trap bites even after the migration file exists: generating it does not apply it, and `pnpm typecheck` / `pnpm test` all pass because the integration lane runs migrations on a fresh testcontainer. The developer's own DB only fails at request time, as a raw Postgres `column <table>.<col> does not exist`. A schema change is three steps — edit, `pnpm db:generate`, `pnpm db:migrate` — and the third is the one nothing reminds you about. Evidence: adding `agent_skills.enabled` (migration `0014_old_rawhide_kid.sql`, was `0013_…`).

- **2026-08-05** — An agent's `agent_versions` snapshot is not reproducible with respect to its skills: `snapshotVersion` reads the current links into `config_json.skills`, but `setSkills` / `linkSkill` / `unlinkSkill` never snapshot and `isConfigChange` has no skill field, so relinking skills changes what version N's prompt would assemble to while version N stays version N. Evidence: `src/modules/agents/repository.ts:148-166` vs `:208-235`; `src/modules/agents/helpers.ts:61-85`.

- **2026-08-05** — `pnpm db:generate` run on a machine whose migration journal diverged from upstream main silently REWRITES committed `_journal.json` history instead of appending: commit `641b637` replaced entry 10's tag with `0010_polite_sasquatch` (a file that exists on no branch) and dropped `0011_nasty_pretty_boy`, so every fresh-DB lane crashed with `No file …0010_polite_sasquatch.sql found` while every already-migrated DB kept passing, and the regenerated snapshots lost the `critical_count`/`warning_count`/`suggestion_count` columns that `src/db/schema/runs.ts:39` still declares. Evidence: `git diff ae55e4b 641b637 -- server/src/db/migrations/meta/_journal.json`.
  - The repair, for next time: restore upstream's journal entries and `meta/0011_snapshot.json`, renumber the branch's migrations/snapshots after them (here 0011–0015 → 0012–0016), re-add the lost columns to the renumbered snapshots, relink the first renumbered snapshot's `prevId`, and hand-apply the lost columns to any DB that migrated from the broken journal — drizzle's migrator compares only `when` timestamps, so a restored older entry never auto-applies to an existing DB.

- **2026-08-05** — An import of a package absent from both `package.json` and `pnpm-lock.yaml` passes typecheck, unit, and integration lanes locally because a stray copy sits in `server/node_modules` (`fflate`, imported at `src/modules/skills/service.ts:1`), and only a fresh `pnpm install --frozen-lockfile` exposes it as TS2307 — verify a new import against a clean worktree install, not the dev tree. Evidence: `grep fflate package.json pnpm-lock.yaml` returned nothing while `pnpm typecheck` was green.

## Codebase Patterns

- **2026-08-29** — A module whose `routes.ts` constructs its own service has
  **no test seam at all**: `blast` and `smart-diff` both did
  `new BlastService(app.container.pullsRepo, app.container.repoIntel)` inside
  the plugin, so no `ContainerOverrides` entry could reach either and any
  cross-module reader would have had to import the banned `service.ts`.
  Promoting one is mechanical and costs no test change — declare
  `XFacade { get(workspaceId, prId): Promise<…> }` in the module's own
  `types.ts`, add `implements XFacade` to the service (the signature already
  matched), add the `ContainerOverrides` slot plus a lazy getter that does the
  exact wiring the route did, and the route becomes
  `const service = app.container.blast;`. Routes reaching the container is legal
  at the delivery ring. Evidence: `src/platform/container.ts` (`get blast()` /
  `get smartDiff()`), `src/modules/blast/types.ts` (`BlastFacade`).

- **2026-08-29** — The PR Brief's grounding gate treats an invented FILE
  reference and an invented ENDPOINT reference differently, and the asymmetry is
  deliberate rather than an oversight: a `file_ref` not among the PR's changed
  files is REMOVED from the risk (AC-06 asks for exactly that), while a risk
  citing an `endpoint_ref` absent from the blast summary is DROPPED WHOLE even
  when all its `file_refs` are real — AC-08's stated outcome is that an invented
  endpoint can neither survive into the stored brief nor keep a risk alive. Both
  drops are recorded as `{target, ref, reason}`, and a dropped risk is
  identified by its ORDINAL (`risk#0`), never its title, because those records
  are logged and model prose must not be (AC-NF-02). Second non-obvious pairing
  in the same module: the grounding universe is
  `pullsRepo.getFiles(prId).map(f => f.path)`, NOT the Smart Diff path set —
  Smart Diff legitimately omits binary/oversized/unparseable files, so
  grounding against it would silently drop a risk citing a real changed file.
  Evidence: `src/modules/brief/grounding.ts`, `src/modules/brief/service.ts`
  (`generate`, step "gate first, level second"), `test/brief-grounding.test.ts`.

- **2026-08-14** — `PromptAssembly` has NO diff field: `assemblePrompt` embeds
  the diff inside `user` as `## Diff to review` + `wrapUntrusted('diff', …)`, so
  every other section (`intent`/`skills`/`specs`/`callers`/`repo_map`/
  `pr_description`) is a SLICE of `user` too. Any per-slot size or token
  attribution built from the assembly therefore double-counts unless it treats
  `system` + `user` as the only top-level rows and takes the diff length from the
  caller — `platform/prompt-log.ts` marks the inner rows `nested` for exactly
  that reason. The trace contract's "enables per-slot token attribution" comment
  reads as if the slots were disjoint; they are not. Evidence:
  `reviewer-core/src/prompt.ts:143,152-162`,
  `src/vendor/shared/contracts/trace.ts:48-49`.

- **2026-07-29** — Twelve tables in `src/db/schema/` have zero references outside their own schema file and are meant to stay empty until a course lesson fills them, so an unused table is not dead code. Evidence: `server/README.md:9-14`.

  `ci_installations` · `ci_runs` · `code_chunks` · `composed_reviews` ·
  `conformance_checks` · `digests` · `eval_cases` · `eval_runs` ·
  `installed_plugins` · `multi_agent_runs` · `pr_brief` · `skill_versions`

- **2026-07-29** — `modules/reviews/repository.ts` and `modules/reviews/repository/` are one design, not a duplicate: the file is the facade (the only DB layer for the review domain), the directory holds query implementations split by aggregate. Evidence: `src/modules/reviews/repository.ts:11`. Add queries in the directory; keep the facade as the entry point.

- **2026-07-29** — `platform/prompt.ts` and `platform/prompts.ts` differ by one character and do unrelated jobs: the first is a re-export shim over `reviewer-core` for per-request data, the second a template loader for `src/prompts/*.md` with `{{var}}` interpolation. Evidence: `src/platform/prompts.ts:1-12`.

- **2026-07-29** — Three files in `src/platform/` are pure re-exports of `@devdigest/reviewer-core` and must not be edited to change behaviour: `prompt.ts`, `grounding.ts`, `structured.ts`. Evidence: `src/platform/grounding.ts:1-6`.

- **2026-08-05** — `modules/pulls/` is the only module that never grew past routes-only, so its 382-line `routes.ts` holds 18 direct `container.db` calls, the GitHub sync, and DTO mapping inline while `agents` / `repos` / `reviews` / `repo-intel` all have `service.ts` + `repository.ts` — treat it as the outlier to fix, not as a second sanctioned shape. Evidence: `src/modules/pulls/routes.ts` (only sibling is `status.ts`).
  - **2026-08-05** — Sharpening: `pulls` is the largest case but not the only one — four of the eight modules query the DB straight from the transport layer. Evidence: `grep -rln "db/schema" src/modules/*/routes.ts` → `polling`, `pulls`, `settings`, `workspace` (each also imports `drizzle-orm` in `routes.ts`).
    - **2026-08-05** — Resolved: all four are clean and both greps now return nothing; `pulls` went to `repository`+`helpers`+`service` (routes.ts 382→52 lines), `settings` to `repository`+`service`, while `polling`/`workspace` stayed routes-only and reach shared tables through the new `container.reposRepo` / `container.pullsRepo`. Evidence: `src/platform/container.ts` (`reposRepo`, `pullsRepo` getters); the rule that keeps it that way is `transport-never-queries` in `.dependency-cruiser.cjs`.

- **2026-08-05** — `rollupSeverities` in `src/modules/pulls/status.ts:23` is dead in production and only its test keeps it alive: it returns lowercase `{critical, warning, suggestion}` while the wire contract's `findings_counts` is uppercase `{CRITICAL, WARNING, SUGGESTION}`, so the PR-list rollup could never use it and counts them separately. Evidence: `grep -rn rollupSeverities src/ test/` → one definition, one test import; `src/vendor/shared/contracts/platform.ts:178-183`.

- **2026-08-05** — `no-cross-module-internals` bans importing another module's `helpers.ts`, and the container only shares *repositories*, so a pure row→DTO mapper that two modules both need has no shared home: it is duplicated on purpose. The agents module maps a skill row itself (`toAgentSkillDetail`) rather than importing the skills module's `toSkillDto`. Only `constants.ts` / `types.ts` are importable across modules. Evidence: `.dependency-cruiser.cjs:29-40`, `src/modules/agents/helpers.ts` (`toAgentSkillDetail`).
  - **2026-08-17** — The mapper FUNCTION must be duplicated, but its DTO *type*
    need not be: the owning module re-exports the type through its own
    `types.ts` (`export type { ReviewDto }` in `src/modules/reviews/types.ts`,
    sourced from the banned `./helpers.js` inside the module), so a consumer of
    the module's port names the shape without ever importing `helpers.ts`. That
    is the sanctioned way to publish a return type from a facade interface —
    duplicating the type declaration would let the two drift silently.

- **2026-08-05** — `src/db/rows.ts` is the sanctioned home for a row type two modules both need, and it is load-bearing rather than stylistic: `dependency-cruiser` runs with `tsPreCompilationDeps: false`, so a cross-module `import type { X } from '../other/repository.js'` is erased before the graph is built and the `no-cross-module-internals` rule cannot see it — the convention is the only thing catching that reach. Evidence: `src/db/rows.ts:3-11`.
  - **2026-08-16** — Same loophole, different shape: a NEW service that only
    needs a *capability* of another module's repository (not a shared row
    type) doesn't need `db/rows.ts` either — declare a narrow structural
    interface in the new module's own `types.ts` (e.g. `{ getPull(...):
    Promise<unknown | undefined> }`) instead of `import type { PullsRepository
    } from '../pulls/repository.js'`. `PullsRepository`/`ReviewRepository`
    satisfy it structurally with no import, so `pnpm arch` sees a clean graph
    for the right reason (no cross-module type reach exists at all) rather
    than an invisible one. Evidence: `src/modules/smart-diff/types.ts`
    (`SmartDiffPullsRepo`, `SmartDiffReviewRepo`), `src/modules/smart-diff/service.ts`.
    - **2026-08-17** — The same narrow-port move is FORCED, not optional, for
      `container.runBus`: `RunBus` is a class with five `private` fields
      (`emitters`/`buffers`/`seq`/`completed`/`cancelled`), and TypeScript
      compares private members nominally, so no object literal can ever satisfy
      `RunBus` — `import type { RunBus }` makes a fake bus impossible in a test
      even though the consumer only calls four public methods. Declare the port
      (`subscribe`/`onDone`/`buffer`/`isComplete`) in the consuming module's
      `types.ts`; the singleton still passes straight through. Evidence:
      `src/platform/sse.ts:19-24`, `src/modules/mcp/types.ts` (`McpRunBus`).

- **2026-08-05** — `modules/settings/feature-models.ts` is the one cross-module import the arch rules allow into another module's folder — `no-cross-module-internals` bans only `service|repository|routes|helpers|run-executor|diff-loader|findings|status`, so a system LLM feature resolves its model with a direct `import { resolveFeatureModel } from '../settings/feature-models.js'` rather than through the container. Evidence: `.dependency-cruiser.cjs:29-40`, `src/modules/conventions/service.ts:11` (`pnpm arch` clean).

- **2026-08-29** — A `MockProjectContextDocs` fixture gets its `type` from the
  ROOT it was found under (`docTypeForRoot`), not from its own path or content,
  so a document written as `{'foo/a.md': '…'}` is invisible to `list()` (no
  configured root matches) and one under `docs/` is typed `doc`. Anything
  filtering on `type === 'spec'` — the PR Brief's `selectSpecDocs` — therefore
  needs its fixtures under `specs/`, and a mis-rooted fixture makes the test
  pass with zero documents instead of failing. Evidence:
  `src/adapters/mocks.ts` (`MockProjectContextDocs.list`),
  `src/adapters/projectcontext/paths.ts`, `test/brief-service.test.ts`
  ("document selection").

- **2026-08-05** — `src/adapters/mocks.ts` doubles as a spec for unbuilt features: `MockLLMOptions.structuredBySchema` names the schemas of a conventions flow that did not exist (`'ConventionFileSelection'` then `'ConventionExtraction'`), so the intended two-step design — model RANKS a code-built candidate file list, then extracts — is discoverable there before any module is written. Evidence: `src/adapters/mocks.ts:46-52`.

- **2026-08-05** — `src/adapters/` is not a pure IO ring: it also holds pure functions that services legitimately import, so an import-path rule of the form "services must not import `adapters/*`" would flag correct code — classify by whether the code leaves the process, not by folder. Evidence: `src/adapters/git/diff-parser.ts:14` (`parseUnifiedDiff`, imported by `src/modules/reviews/diff-loader.ts:3`), `src/adapters/codeindex/extract.ts:182` (`extractEndpoints`, imported by `src/modules/repo-intel/service.ts:22`).
  - **2026-08-28** — The corollary that bites when you write the adapter: an
    adapter may NOT import its own module's `helpers.ts`. The
    `adapters-stay-outermost` rule is `^src/adapters/` → `^src/modules/(?!.*(constants|types)\.ts$)`,
    so only a module's `constants.ts` / `types.ts` are reachable from
    `adapters/`. A pure path helper that both the adapter and the module need
    therefore lives UNDER `adapters/` and is re-exported by the module's
    `helpers.ts`, not the other way round — `src/adapters/projectcontext/paths.ts`
    (`resolveWithinRoots`, `docTypeForRoot`) re-exported from
    `src/modules/project-context/helpers.ts`. The failure is silent until you
    run it: `pnpm typecheck` is green and three violations only appear under
    `./node_modules/.bin/depcruise --config .dependency-cruiser.cjs src`
    (`fs.ts`, `mocks.ts` and `git/simple-git.ts` all reached the same helper).

## Tool & Library Notes

- **2026-08-29** — Every `server/` script has a local-binary equivalent, which
  is the way out when `pnpm` is not on the shell's PATH (agent shells here) and
  corepack wants to purge `node_modules` before it will run: `pnpm typecheck` →
  `./node_modules/.bin/tsc --noEmit -p tsconfig.json`, `pnpm test` →
  `./node_modules/.bin/vitest run`, `pnpm db:generate` →
  `./node_modules/.bin/drizzle-kit generate`, `pnpm db:migrate` →
  `./node_modules/.bin/tsx src/db/migrate.ts`. The migration pair matters most:
  `db:migrate` is a plain `tsx` entrypoint that reads `DATABASE_URL` through
  `dotenv/config`, so `server/.env` is picked up either way. Evidence:
  `server/package.json` `scripts`.

- **2026-08-17** — `app.inject()` does NOT hang on the MCP route's hijacked
  reply, which settles the question that was blocking `test/mcp.it.test.ts`:
  `app.inject({url:'/mcp', method:'POST', payload:{jsonrpc:'2.0',id:1,
  method:'tools/list'}, headers:{accept:'application/json, text/event-stream'}})`
  returns `200` carrying the complete SSE body (`event: message` +
  `data: {"result":{"tools":[…`). `NodeStreamableHTTPServerTransport` ends
  `reply.raw` itself and Fastify 5 derives `sent` from that, so `reply.hijack()`
  changes nothing either way — measured with it and without. The whole HTTP path
  (the three loopback guards, both 405s, a real `tools/list`) is therefore
  drivable from `inject`; no `listen({port:0})` harness is needed. Evidence:
  `src/modules/mcp/routes.ts`, probed against `buildApp({ config })`.

- **2026-08-17** — A `Host` allowlist for the MCP endpoint must compare the
  HOSTNAME, never `new URL(container.config.webOrigin).host`: `webOrigin` is
  `http://localhost:3000` (the WEB port) while the API answers on `:3001`, so a
  host-with-port allowlist rejects every legitimate `Host: 127.0.0.1:3001`. What
  works is `new URL('http://' + host).hostname` matched against `{localhost,
  127.0.0.1, ::1, [::1]}` plus the web origin's hostname; the same parse serves
  `Origin`, which must be allowed when ABSENT because Claude Code and every other
  CLI client send none. The peer check needs the IPv4-mapped form too — Node
  reports `::ffff:127.0.0.1` on a dual-stack socket. Verified via `app.inject`:
  foreign `Host` → 403, foreign `Origin` → 403, no `Origin` → 200, peer
  `::ffff:127.0.0.1` → 200, peer `203.0.113.5` → 403. Evidence:
  `src/modules/mcp/routes.ts` (`hostnameOf`, `isLoopbackAddress`).

- **2026-08-17** — The `@modelcontextprotocol/node` transport feeds the client's
  timers by itself, so a blocking tool needs NO heartbeat to survive: measured on
  a 90 s silent call, response headers flush at **+3 ms** and a `: keepalive` SSE
  comment goes out every 15 s (+15/+30/+45/+60/+75 s), unprompted and independent
  of the handler. That kills the 60 s first-byte hazard the whole blocking design
  was shaped around and feeds the 5 min idle timer too — which is why
  `RUN_WAIT_BUDGET_NO_TOKEN_MS` could go to `240_000` instead of the conservative
  `50_000`. A `notifications/progress` heartbeat is still worth keeping, but for
  ONE reason only: without it the client keeps displaying a progress line from
  minutes ago and a quiet run reads as stalled. Do not describe it as a
  keep-alive. Evidence: `src/modules/mcp/run-waiter.ts` (`heartbeat`),
  `src/modules/mcp/constants.ts:95`.

- **2026-08-17** — `RunEvent.seq` is the obvious `progress` value for an MCP
  `notifications/progress`, but it cannot be the ONLY source: the protocol
  requires progress to strictly increase, and the 30 s progress-refresh
  heartbeat has no seq of its own, so re-sending the last message with the last
  seq is a violation, not a no-op. Carry a separate counter advanced as
  `lastProgress = Math.max(seq ?? 0, lastProgress + 1)` — it tracks the bus seq
  while a run is chatty and drifts one ahead per heartbeat while it is quiet.
  The same counter forces a second rule: an event that bypasses the coalescing
  throttle (`result`/`error`) must DROP any pending older event rather than let
  it flush afterwards, or a lower seq lands after a higher one. Measured with a
  fake bus: 30 events replayed synchronously by `RunBus.subscribe` collapse to
  exactly 2 notifications (seq 1 on the leading edge, seq 30 at the 2 s tick).
  Evidence: `src/modules/mcp/run-waiter.ts` (`send`, `onEvent`),
  `src/platform/sse.ts:54-56,63-68`.

- **2026-08-17** — An MCP `inputSchema` cannot be a zod schema in this repo, and
  the near-miss is the expensive part: `StandardSchemaWithJSON` requires a
  `jsonSchema` key on `~standard`, and both our pinned `zod@3.25.76` and the
  `zod/v4` bundled inside it expose only `{validate, vendor, version}` — the
  working `z.toJSONSchema()` is a top-level helper, not that property, so the
  failure surfaces at `pnpm typecheck` after every tool is written. Use
  `fromJsonSchema<T>(literal)` from `@modelcontextprotocol/server` (its
  `validator` arg is optional — no AJV, no new dep) and hand-author the literal:
  it round-trips VERBATIM, nothing injected, which is what makes byte budgets on
  `tools/list` assertable. Two shapes to know: `~standard.jsonSchema` is a
  converter OBJECT (`.input(opts)` / `.output(opts)`), not a function, and
  `JsonSchemaType` accepts readonly arrays (`MaybeReadonlyArray`), so
  `as const satisfies JsonSchemaType` compiles. Evidence:
  `src/modules/mcp/schemas.ts`; the five literals serialize to 1340 bytes
  (1615 as a full `tools/list` envelope with names, no descriptions) against
  `TOOLS_LIST_BYTE_CEILING = 5120`.
  - **2026-08-17** — The half that decides the tool signatures: `fromJsonSchema`
    DOES validate at `tools/call` time even with the `validator` arg omitted —
    the SDK ships a default AJV-style validator, and a miss NEVER reaches the
    handler. It returns a *successful* JSON-RPC result carrying
    `{isError: true, content:[{text:"Input validation error: Invalid arguments
    for tool <name>: data/pr must be integer"}]}`. Measured for all three miss
    shapes: wrong type (`pr:"412"`), missing `required` key, and an extra key
    under `additionalProperties:false`. So a tool that must answer a miss with
    its OWN guidance has to declare every field optional and untyped (`pr: {}`)
    — one `required` entry or one `type` keyword hands the reply to the SDK
    instead. With a loose literal the raw value arrives verbatim (`pr` stays
    the string `"412"`, hence the `coerceInt` need) and a call with no
    `arguments` key at all yields `{}`.
  - **2026-08-17** — The shipped split, measured end to end over
    `InMemoryTransport`: with `required: []` but `type` keywords kept, a call with
    NO `arguments` key reaches the handler and comes back as our own
    `{"error":"repo_required",…,"available_repos":["acme/api"]}`, while
    `pr: "412"` is still answered by the SDK with `Input validation error: …
    data/pr must be integer` — so `coerceInt` is defensive-only for `pr` and
    load-bearing only for `limit`. Final byte figures with descriptions in: the
    whole `tools/list` result is **4185 B** of the 5120 ceiling (1448 B schemas,
    2419 B for five descriptions — 291/772/494/455/407 — rest envelope), and
    `instructions` is 1103 B of its separate 2048 B budget. ~900 B of headroom, so
    a sixth tool fits once. Evidence: `src/modules/mcp/server.ts`
    (`TOOL_DESCRIPTIONS`, `INSTRUCTIONS`).
    - **2026-08-17** — That 4185 B is 96 B more than any test can see, and the
      gap is structural: `test/mcp-budget.test.ts` reconstructs `tools/list` from
      the three exported sources (`TOOL_ORDER` × `TOOL_DESCRIPTIONS` ×
      `TOOL_INPUT_JSON_SCHEMAS`) and measures **4089 B** (464/1147/937/765/760
      per tool), because `_meta: {"anthropic/maxResultSizeChars":200000}` is
      attached inside the non-exported `REGISTRARS` map and rides only the two
      findings-returning tools (~48 B each). So the byte ceiling is asserted
      against a reconstruction that runs optimistic, and an `outputSchema` or
      `_meta` added straight to a `server.registerTool` call is invisible to it —
      only a real `tools/list` round-trip would catch that. Do not "fix" it by
      exporting `REGISTRARS`; the honest closer is the HTTP-path test, which
      `app.inject()` is already known to support (see the entry above).

- **2026-08-17** — `@modelcontextprotocol/server@2.0.0` does NOT speak protocol
  `2026-07-28`: `LATEST_PROTOCOL_VERSION` is `2025-11-25` and
  `SUPPORTED_PROTOCOL_VERSIONS` is `["2025-11-25","2025-06-18","2025-03-26",
  "2024-11-05","2024-10-07"]`. The 2026-07-28 machinery is in the typings
  (`ProtocolEra`, `CacheHint`, `CACHEABLE_RESULT_METHODS`) but unreachable, so
  `ttlMs`/`cacheScope` are never emitted on `tools/list` and `server/discover`
  answers `-32601 Method not found` — a `cacheHints` option is dead weight
  today. The "stateless means no `initialize`" reading is wrong too: Claude
  Code 2.1.2 POSTs `initialize` (`protocolVersion: 2025-11-25`) →
  `notifications/initialized` → `GET /mcp` → `tools/list`, four requests, each
  landing on its own transport instance under `sessionIdGenerator: undefined`,
  and that works. The `GET /mcp` probe is optional — it got Fastify's bare 404
  and the client still reported `✔ Connected`; 405 is merely the spec-correct
  answer. Evidence: measured against a throwaway Fastify app with a request
  logger, `claude mcp add --transport http`.

- **2026-08-20** — `cruise()`'s cruise-options `tsConfig: {fileName}` is NOT
  enough to resolve tsconfig path aliases, and the failure is silent
  (`couldNotResolve: true`, no error): dependency-cruiser hands
  `TsconfigPathsPlugin` a hardcoded `baseUrl: "./"` — relative to the server's
  CWD — unless the PARSED tsconfig also arrives as the 4th argument
  (`transpileOptions.tsConfig`, via
  `dependency-cruiser/config-utl/extract-ts-config`); only then does
  `pTSConfig?.options?.baseUrl` exist and the plugin read the real baseUrl
  (`node_modules/dependency-cruiser/src/main/resolve-options/normalize.mjs:111`).
  Two more traps in the same adapter: the tsconfig was only ever looked for at
  the REPO root, so a project nested one level down (weather-app's
  `weather-app/tsconfig.json`) got no alias resolution at all — group files by
  nearest tsconfig and cruise per group; and per-group cruising is only safe
  because `extract/index.mjs` calls `clearCaches()` per cruise — `resolve.mjs`
  memoizes its enhanced-resolve resolver in module scope under one key.
  Downstream stakes: no aliased edges → no `references.decl_file` → blast
  radius reports 0 callers. Evidence: `src/adapters/depgraph/index.ts`,
  `test/depgraph.test.ts`.

- **2026-08-05** — Drizzle's `text('col', { enum: [...] })` narrows the TypeScript type only and emits no DB constraint, so `reviews.kind` and every status column are unconstrained free text in Postgres — the boot-time run reaper matching `status='running'` is protected by nothing but convention. Evidence: `src/db/schema/reviews.ts:19`, `src/db/schema/runs.ts:27`, `src/app.ts:81`; the repo has zero `check(` declarations.
  - **2026-08-05** — Partly resolved: `check()` (exported from `drizzle-orm/pg-core` since well before the pinned 0.38.4) now guards the seven live review-pipeline columns. Evidence: `src/db/migrations/0013_condemned_stranger.sql` (was `0012_…` before the journal repair renumbered it). Two caveats — `ADD CONSTRAINT … CHECK` VALIDATES existing rows, so the migration fails outright on a DB holding a legacy value, and a CHECK is satisfied when its expression is NULL, so nullable columns need no explicit `OR IS NULL`.

- **2026-08-05** — `pull_requests.status` is the one status column that cannot take a CHECK like the others: the column is documented as GitHub's merge state (open/merged/closed) but its DEFAULT is `'needs_review'`, a review status, so both vocabularies are legitimately present in the same column. Evidence: `src/db/schema/pulls.ts:25` vs `src/modules/pulls/status.ts:41-42`.

- **2026-08-05** — `dependency-cruiser` runs on the RUNTIME graph here (`tsPreCompilationDeps: false`), so an UNUSED import is erased by TypeScript and never reaches the graph — testing a new arch rule by adding an unused `import { eq } from 'drizzle-orm'` reports "no dependency violations" and reads as a working rule that is in fact never exercised. Verify with an import the file actually uses. Evidence: `.dependency-cruiser.cjs:82`.

- **2026-08-05** — `dependency-cruiser` cannot enforce any ban on an npm PACKAGE in this repo because `options.exclude` drops `node_modules` from the graph entirely, so package-level import rules (e.g. "routes must not import `drizzle-orm`") have to live in `eslint.config.mjs` as `no-restricted-imports` — the graph tool covers only local paths like `^src/db/schema`. Evidence: `.dependency-cruiser.cjs:95-97`.

- **2026-08-05** — `@fastify/autoload` is a declared dependency that no source file imports, so the dependency list implies a filesystem-autoloaded route tree that does not exist — registration is static in `src/modules/index.ts` on purpose. Evidence: `grep -rn "autoload" src/` returns only the comment at `src/modules/index.ts:17`.

- **2026-08-05** — `dependency-cruiser` sits in `dependencies`, not `devDependencies`, because it runs **in-process at runtime** as the repo-intel depgraph adapter (`cruise()` builds the file-level import graph) — moving it to devDependencies would break indexing in a production install. Evidence: `package.json:25`, `src/adapters/depgraph/index.ts:17`.

- **2026-08-05** — A schema edit that DROPS one column while ADDING others makes `pnpm db:generate` block on an interactive rename prompt ("Is `category` column in `conventions` created or renamed from another column?"), and that prompt reads the tty directly — `yes '' | pnpm db:generate` and `printf '\r' | script -qec …` both hang until killed. What works is a pty plus a delay before each keystroke: `(for i in 1 2 3 4 5 6 7 8; do sleep 2; printf '\r'; done) | script -qec "pnpm db:generate" /dev/null` (default answer = create column). Evidence: `src/db/migrations/0016_same_gargoyle.sql` (was `0015_…` before the journal repair renumbered it).

- **2026-07-29** — `pnpm db:migrate` dumps raw Postgres NOTICE objects (`'extension "vector" already exists, skipping'`, code 42710) that read like errors but are idempotent skips — the run is fine iff it ends with `✓ migrations applied`. Evidence: `src/db/migrate.ts` sets no `onnotice` handler, so the `postgres` client logs every notice to stderr.

## Recurring Errors & Fixes

- **2026-08-20** — A Blast Radius panel showing "No changed symbols" on a fully
  indexed repo meant the INDEX was wrong, not the panel: tree-sitter puts a
  `decorator` node FIRST among `export_statement` children
  (`@Injectable()\nexport class X {}` → `decorator`, `export`,
  `class_declaration`), and `unwrapExport` returned the first non-keyword child
  — the decorator — so every decorator-prefixed exported class produced zero
  symbols. On an Angular repo that is every service and component; weather-app
  indexed 23 symbols, all interfaces from the one decorator-free `model.ts`.
  Bare decorated classes (no `export`) were fine — there the decorator nests
  INSIDE `class_declaration`. **Fixed 2026-08-20** by adding `decorator` to the
  skip list (`src/adapters/astgrep/index.ts`, `unwrapExport`) and bumping
  `INDEXER_VERSION` — the designed invalidation lever; without the bump,
  already-indexed repos never re-parse. `test/astgrep.test.ts` ("decorator-
  prefixed exported classes").

- **2026-08-17** — NOTHING type-checks `server/test/**`: `tsconfig.json` has
  `"include": ["src/**/*.ts"]`, so `pnpm typecheck` skips the whole folder, and
  vitest 2.1.9 transpiles with esbuild, which strips types without checking
  them — a test can pass green while its fixtures are structurally wrong (a
  missing `AgentRow` column, a stale `Pick<>`). To actually check one, write a
  throwaway config and delete it:
  `printf '{"extends":"./tsconfig.json","compilerOptions":{"noEmit":true},"include":["test/<file>.test.ts","src/**/*.ts"]}' > .tsc-testcheck.json && ./node_modules/.bin/tsc --noEmit -p .tsc-testcheck.json; rm .tsc-testcheck.json`
  (`src/**` must stay in `include` or the path aliases resolve against nothing).

- **2026-08-14** — An it-test that triggers a review can silently reach a REAL
  LLM provider and burn money on any machine whose `~/.devdigest/secrets.json`
  holds keys: tests build config from `{ ...process.env }` with no `secrets`
  override, and `ContainerOverrides.llm` stubs only the provider under test, so
  a container-resolved feature call on the run path (e.g. the intent
  classifier's `resolveFeatureModel` → `openrouter`) falls through to a real
  adapter. Symptom: `Cannot read properties of undefined (reading 'findings')`
  after ~10s (the run outlives the poll window). Fix: every review-triggering
  it-test overrides the feature's facade (`intent: { getOrClassify: async () =>
  undefined }`) or stubs every provider id. `test/reviews.it.test.ts:117`.

## Session Notes

- **2026-07-29** — Entries above were split out of the root `INSIGHTS.md` when per-module files were introduced; they came from a repo-wide sweep done while writing the `CLAUDE.md` files.

## Open Questions

- **2026-08-17** — `Tool & Library Notes` is now at 14 entries and `What Doesn't
  Work` / `Codebase Patterns` at 12 each, against the ~5 the
  `engineering-insights` skill sets as the point where signal drops. Six of the
  MCP entries are also now duplicated as reference material in
  `src/modules/mcp/README.md` (the "Measured facts" table and "Why nothing is
  required"). The skill's prescribed remedy is to promote stable reference
  material into module docs and delete it here — that promotion is done, the
  deletion is not. Next session in this module should prune the duplicated MCP
  entries rather than append more. Deliberately not done at the end of the
  session that wrote them, to avoid unilaterally deleting findings whose nuance
  had not yet been re-read.
