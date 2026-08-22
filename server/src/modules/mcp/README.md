# `modules/mcp` — local MCP server

Exposes DevDigest's review engine to MCP clients (Claude Code, Cursor, …) over
Streamable HTTP at `POST /mcp`. **Local only**: loopback-enforced, no auth, no
remote hosting. Intent and acceptance criteria live in
[`server/specs/01-mcp-server.md`](../../../specs/01-mcp-server.md).

MCP is a **driving adapter** here — the same onion ring as `routes.ts`. It parses,
resolves tenancy, delegates to the service layer through the container, and maps
the result. It holds no business rules.

## Register it

The API must be running (`./scripts/dev.sh`, or `pnpm dev` with Postgres up).

```sh
claude mcp add --transport http devdigest http://127.0.0.1:3001/mcp
claude mcp list          # expect: devdigest … ✔ Connected
```

## The five tools

Arguments are **flat scalars** — `repo`, `pr`, `agent` as separate values, never a
compound `"owner/repo#412"` string. Nothing is `required` (see *Why nothing is
required* below).

| Tool | Input | Returns |
|------|-------|---------|
| `devdigest_list_agents` | `enabled_only?` | `{count, agents:[{name, model, enabled}]}` |
| `devdigest_run_agent_on_pull_request` | `repo`, `pr`, `agent` | `{status, run_id, agent, verdict, score, counts, findings[]}` — **blocks** |
| `devdigest_get_findings` | `repo`, `pr`, `run_id?`, `min_severity?`, `limit?` | same findings shape, read back; omit `run_id` for the latest run |
| `devdigest_get_conventions` | `repo`, `status?` | `{repo, count, conventions:[{category, rule, confidence}]}` |
| `devdigest_get_blast_radius` | `repo`, `files[]` | `{implemented:false, next}` — **stub** |

Findings are deliberately terse: `{id, severity, file, line, title}`. `rationale`
and `suggestion` are **not reachable through MCP** — one rationale is 400–1500
chars of markdown, so forty findings would approach the 25k-token output cap.
`file`+`line` locates the code; `id` locates the finding in the web UI. If this
ever needs to change, add a separate `explain_finding(finding_id)` tool rather
than a `detailed` mode, so lists stay lean and tokens are paid only where the
agent has already decided to act.

## The blocking contract

`devdigest_run_agent_on_pull_request` returns findings from a **single call**. It
starts the run, subscribes to `container.runBus`, relays events as MCP progress
notifications, and reads the persisted review when the bus reports done.

Safe because `runBus.complete(runId)` fires *after* `insertReview`,
`insertFindings`, `completeAgentRun` and `saveRunTrace` on every path
(`modules/reviews/run-executor.ts:97,355,379`) — "wait for done, then read" has no
read-after-write race. `RunBus.subscribe` also replays its buffer synchronously
before attaching, so a run finishing in the gap still resolves.

A duplicate call for the **same** agent **attaches** to the in-flight run
(`attached: true`) instead of paying for a second one; a **different** agent gets
`run_in_flight` guidance and starts nothing.

Bounded by `RUN_WAIT_BUDGET_MS` (10 min), or `RUN_WAIT_BUDGET_NO_TOKEN_MS` (4 min)
when the client sent no `progressToken`. On expiry the tool returns a usable
handle plus guidance rather than hanging. **That budget is the only protection**
against `executeRuns` rejecting outside its three `runBus.complete` paths, where
the row would stay `running` and the bus would never fire.

## Measured facts (2026-08-17) — don't re-derive these

| Fact | Consequence |
|------|-------------|
| SDK `@modelcontextprotocol/server@2.0.0` reports `LATEST_PROTOCOL_VERSION: 2025-11-25`; `2026-07-28` is **not** supported | `cacheHints` (`ttlMs`/`cacheScope`) and `server/discover` are unreachable. **Do not re-add them.** Deterministic `TOOL_ORDER` still helps prompt-cache hits |
| Transport flushes response headers at **+3 ms** and emits its own `: keepalive` every **15 s**, unprompted | The 60 s first-byte timer is never in play; a fully silent 90 s call survives. Our heartbeat only refreshes *displayed* progress |
| `ctx.mcpReq.signal` **never fires** under a per-request transport — a bare socket close doesn't abort, and `notifications/cancelled` on a second connection returns 202 without aborting (a shared module-scope transport aborts in ~4 ms) | The abort path in `run-waiter.ts` is correct but inert. It starts working the day the transport is hoisted out of the request |
| `reply.hijack()` is **not** load-bearing — `onResponse` fires and `app.inject()` returns fine either way, because the transport ends `reply.raw` itself | Kept anyway (free, documents intent, guards a future path that leaves `reply.raw` open). Also means `mcp.it.test.ts` is writable |
| Claude Code probes `GET /mcp`, gets a 404, and connects fine | Not required, but we answer **405** — spec-correct, and keeps the loopback guards on the probe |

### Why nothing is `required`

`fromJsonSchema` installs a default validator **even when the `validator` argument
is omitted**. A `required` miss is rejected by the SDK with a terse
`Input validation error: … data must have required property 'repo'` and **the
handler never runs** — so our guidance builder cannot fire. Keeping every field
optional is what makes "помилка веде далі" reachable: a missing `repo` comes back
as *"Which repository? Pass repo as owner/repo. Imported: …"*.

`type` keywords **are** kept: they tell the model what to send, and a type
mismatch is the rarer slip that still falls to the SDK's self-correcting message.
Handlers coerce defensively anyway — the tool input types are `unknown` on
purpose, which makes the `coerceInt`/`coerceString` pass unskippable.

## Token budget

The whole point of the design. Measured, and asserted by
`test/mcp-budget.test.ts` against the constants in `constants.ts`:

```
 4089 B   tools/list (names + descriptions + schemas)   ceiling 5120
 1103 B   instructions                                  ceiling 2048
≈1400 tokens total startup cost with tool search OFF; ≈350 with it ON
```

With tool search on (Claude Code's default) only tool **names** and
`instructions` load at session start. It is off behind a non-first-party
`ANTHROPIC_BASE_URL`, on Azure-hosted Foundry, on pre-4.5 GCP models, and in
Cursor/Windsurf — which is why the surface is lean by construction rather than by
relying on the client.

If a description must grow, cut another one. Raising `TOOLS_LIST_BYTE_CEILING`
should be a deliberate, reviewed act, which is why the test asserts against the
constant and not a literal.

## Smoke test (required — this is the only coverage the HTTP path has)

`test/mcp-projections.test.ts` and `test/mcp-budget.test.ts` cover the projections
and the byte ceilings. **`identifiers.ts`, `run-waiter.ts`, the tool handlers and
the entire HTTP path have no automated coverage.** Run this after any change to
`routes.ts`, `server.ts`, `run-waiter.ts` or the tools.

```sh
./scripts/dev.sh          # Postgres + API :3001

# 1. tools/list — proves the route, the transport and TOOL_ORDER
curl -sS -X POST http://127.0.0.1:3001/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# EXPECT: 5 tools, in TOOL_ORDER, none carrying outputSchema

# 2. Loopback enforcement — MUST be 403, not a tool list
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3001/mcp \
  -H 'content-type: application/json' -H 'host: evil.example.com' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 3. The GET probe answers 405, not the app's generic 404
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/mcp

# 4. Register
claude mcp add --transport http devdigest http://127.0.0.1:3001/mcp
claude mcp list                                    # ✔ Connected
```

**5. The load-bearing check** — in a live Claude Code session against a seeded PR,
ask it to run a review. This is the *only* proof that the runBus↔progress bridge
and the blocking path work end to end. Confirm all four:

- progress notifications arrive while the run is in flight;
- findings come back from that **single** call;
- a call outliving 2 minutes is auto-backgrounded by the client and still returns;
- a second identical call **attaches** — the web UI shows one run, not two.

**6. Failure path** — run against an agent whose provider key is missing. Expect
`{status:'failed', …, next}` as a normal result, never a red MCP error.

**7. Startup cost** — `/context` in a fresh session, then again under
`ENABLE_TOOL_SEARCH=false claude`. The second number is what Cursor/Windsurf users
actually pay and is the one the design is accountable for.

## Enabling blast radius

One line, in `tools/blast-radius.ts`. `container.repoIntel.getBlastRadius` already
exists and works, `deps.repoIntel` is already wired, and `projectBlast` is already
written against the real `BlastResult` — so the swap needs no import change. The
method self-degrades to `{degraded:true, reason:'no_data'}` until the repo index is
built, which is honest behaviour rather than a lie.

## Files

| File | Role |
|------|------|
| `routes.ts` | Fastify plugin: 3 loopback guards, `POST /mcp`, 405 on `GET`/`DELETE` |
| `server.ts` | `buildMcpServer` — `INSTRUCTIONS`, `TOOL_DESCRIPTIONS`, registration in `TOOL_ORDER` |
| `run-waiter.ts` | The runBus↔progress bridge. Fastify- and DB-free so it can be driven with a fake bus |
| `tools/shared.ts` | `resolveRepo` / `resolvePull` / `shapeFindings` — the spine four tools share |
| `tools/*.ts` | One handler per tool. Returns a plain payload; `server.ts` applies the `content[]` envelope |
| `projections.ts` | **The only field allowlist in the path.** No route in this server declares `schema.response` |
| `schemas.ts` | The JSON Schema literals. What you read is what ships in `tools/list` |
| `identifiers.ts` | `normalizeRepoRef`, `matchAgentByName`, `coerceInt`/`coerceString`. Never throws |
| `types.ts` | `McpDeps` — narrow **structural** ports, so no type-only cross-module reach |
| `constants.ts` | Tool names, `TOOL_ORDER`, budgets, byte ceilings |
