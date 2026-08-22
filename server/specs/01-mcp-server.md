# Local MCP server

**Status:** in progress

Creates a new module: `src/modules/mcp/`.

## Problem

The review engine is reachable only through the DevDigest web UI. A coding agent
working in an editor cannot see which reviewers exist, cannot run one on a pull
request, and cannot read back what it found — the human has to leave the editor,
drive the UI, and paste the result.

This exposes that engine over the Model Context Protocol, **locally only**:
loopback-bound, no OAuth, no remote hosting, no multi-tenancy.

Two constraints shape the whole design.

**Token cost at session start.** An MCP server that loads five verbose tool
schemas into every new chat taxes every conversation, whether or not the tools
are used. Claude Code defers tool *definitions* by default and loads only tool
names plus the server `instructions` string — but that fallback is off behind a
non-first-party `ANTHROPIC_BASE_URL`, on Azure-hosted Foundry, on pre-4.5 GCP
models, and with `ENABLE_TOOL_SEARCH=false`; Cursor and Windsurf have no
equivalent at all. The server is therefore lean by construction, not by relying
on the client.

**Four tool-design principles**, which drive the shape of every tool:

| Principle | What it means here |
|-----------|--------------------|
| Result, not operation | `devdigest_run_agent_on_pull_request` creates the run, waits for it, and returns findings — **one** call, no polling |
| Flat arguments | `repo`, `pr`, `agent` as separate scalars; no compound `"owner/repo#412"` string, no nested objects |
| Terse structured response | One lean projection per tool; **no `response_format` parameter anywhere** |
| Errors lead onward | Every miss returns guidance naming the next call, with the valid values listed inline — never a bare error |

## Routes

`POST /mcp` — Streamable HTTP, stateless (`sessionIdGenerator: undefined`), per
protocol revision 2026-07-28.

**No `@devdigest/shared` schema, and that is deliberate.** The request body is a
JSON-RPC envelope owned by the MCP SDK, and the responses are module-local
projections in `src/modules/mcp/projections.ts` — an MCP wire format, not an API
contract. Putting them in `@devdigest/shared` would make them the client's
business and force a hand-sync of `client/src/vendor/shared/` for a consumer that
does not exist.

The route declares **no `schema.response`**: the handler calls `reply.hijack()`
and writes to `reply.raw`, bypassing the zod serializer compiler.

### Tools

| Tool | Input (all scalars) | Returns |
|------|---------------------|---------|
| `devdigest_list_agents` | `enabled_only?` | `{ count, agents: [{name, model, enabled}] }` |
| `devdigest_run_agent_on_pull_request` | `repo`, `pr`, `agent` | `{ status, run_id, agent, verdict, score, counts, findings[] }` |
| `devdigest_get_findings` | `repo`, `pr`, `run_id?`, `min_severity?`, `limit?` | same findings shape, read back |
| `devdigest_get_conventions` | `repo`, `status?` | `[{category, rule, confidence}]` |
| `devdigest_get_blast_radius` | `repo`, `files[]` | `{ changed_symbols, impacted_endpoints, caller_count }` |

`files` is the only array in the surface. `agent` is never `required` in the JSON
Schema, so an unknown agent produces our guidance payload rather than a protocol
error.

### The blocking contract

`devdigest_run_agent_on_pull_request` blocks. `ReviewService.runReview` is
fire-and-forget, so the tool subscribes to `container.runBus` for that `run_id`,
relays events as MCP progress notifications, and reads the persisted review once
the bus reports done.

This is safe because `runBus.complete(runId)` is called *after* `insertReview`,
`insertFindings`, `completeAgentRun` and `saveRunTrace` on every path
(`modules/reviews/run-executor.ts:97,355,379`) — "wait for done, then read" has no
read-after-write race. `RunBus.subscribe` also replays its buffer synchronously
before attaching, so a run that finishes between `runReview` returning and the
subscribe still resolves.

Timeouts are not a hazard at the HTTP layer: Fastify sets `requestTimeout: 0` and
connection `timeout: 0`, disabling Node's 300 s request timer. The MCP-layer
timers are what the design feeds — a 60 s first-byte timer and a 5 min idle
timer, both satisfied by progress notifications plus a 30 s heartbeat. Claude
Code auto-backgrounds any call past two minutes, so the agent is never stalled.

Bounded by a wait budget, after which the tool returns a usable handle plus
guidance rather than hanging. That budget is the **only** protection against
`executeRuns` rejecting outside its three `runBus.complete` paths, where the row
would stay `running` and the bus would never fire.

A duplicate call for the same agent and PR **attaches** to the in-flight run
rather than starting a second one. Cancellation goes through
`ReviewService.cancelRun`, never raw `runBus.cancel` — the latter leaves the
`agent_runs` row `running` and never completes the bus.

## Schema changes

**None.** No migration. `findByRepoAndNumber` rides the existing
`pr_repo_number_uq` unique index on `(repo_id, number)`
(`src/db/schema/pulls.ts:31`).

## Adapters needed

**No new port and no new adapter.** The MCP SDK is a *driving* adapter — the same
onion ring as `routes.ts` — so it needs no entry in
`vendor/shared/adapters.ts` and none in `src/adapters/`.

Three npm dependencies: `@modelcontextprotocol/server`, `.../node`,
`.../fastify`. `hono` arrives transitively via `@hono/node-server` and is
deliberately not declared.

Two additions to the DI container, the third instance of the existing
`repoIntel` / `intent` facade pattern:

- `container.reviewRunner: ReviewRunner` — new port in `modules/reviews/types.ts`,
  backed by `ReviewService`. Overridable via `ContainerOverrides`.
- `container.conventionsRepo: ConventionsRepository` — a shared repository getter,
  no override slot, matching the existing `agentsRepo` / `pullsRepo` split.

`resolveTargets` is deliberately **not** on the port: it throws `NotFoundError`,
and the MCP module must never throw.

Tool input schemas are hand-authored JSON Schema literals wrapped with
`fromJsonSchema<T>()` from `@modelcontextprotocol/server`. **Zod is not used
here**: zod 3.25.76's bundled `zod/v4` subpath does not satisfy
`StandardSchemaWithJSON` — its `~standard` carries no `jsonSchema` converter — and
introducing a second zod major is a hazard `src/app.ts:136-138` already
documents. Hand-authoring also gives byte-exact control over `tools/list`, which
ships the schema verbatim and is the startup cost.

## Accepted limitation

Finding `rationale` and `suggestion` are **not reachable through MCP** in v1. The
finding shape is `{id, severity, file, line, title}` plus a per-severity `counts`
rollup.

One rationale is 400–1500 characters of markdown, so forty findings would
approach the 25k-token MCP output cap and blow past the 10k warning. `file` plus
`line` is enough for an agent to open the right code; `id` locates the finding in
the web UI.

If this bites, the intended escape hatch is a separate
`explain_finding(finding_id)` tool — **not** a `detailed` mode — because that
keeps every list lean and pays the tokens only where the agent has already
decided to act.

## Acceptance criteria

**Blocking contract**

- One call returns `{verdict, score, counts, findings[]}` — no second call, no
  polling.
- Progress notifications arrive while the run is in flight when the client
  supplied a `progressToken`; nothing protocol-invalid is sent when it did not.
- Exceeding the wait budget returns `{status:'running', run_id, next}` — a usable
  handle, never a hang and never an error.
- `failed` and `cancelled` return payloads carrying `error` and a `next`.
- A duplicate call for the same agent and PR attaches to the in-flight run and
  starts no second run.

**Errors lead onward**

- No tool throws, and none returns a bare MCP error for an ordinary miss.
- Unknown agent → guidance naming `devdigest_list_agents` **and listing every
  available name inline**. Unknown repo → the imported repo list. Unknown PR →
  how to import it.

**Token cost**

- `instructions` and each of the five tool descriptions are under 2048 **bytes**
  (Claude Code truncates both at 2 KB).
- The full serialized `tools/list` payload is under 5 KB, asserted against a
  named constant so it cannot drift silently.
- No `$schema`, no root `title`, no root `description` in any input schema; no
  `outputSchema` on any tool; no `resources` or `prompts` capability.
- No `response_format` parameter exists anywhere in the surface.

**Security**

- `devdigest_list_agents` never emits `system_prompt` or `output_schema`,
  asserted on `Object.keys()`. This matters because no route in this server
  declares `schema.response`, so `projections.ts` is the only field allowlist in
  the path.
- `devdigest_get_blast_radius` never emits `factsByFile`.
- A non-loopback peer address, or a foreign `Host` header, gets `403`.

**Hygiene**

- `pnpm typecheck` and `pnpm exec depcruise --config .dependency-cruiser.cjs src`
  are clean; the hermetic vitest lane passes.
- Exactly three new dependencies; `hono` absent from `package.json`.
- `rm -rf node_modules && pnpm install && pnpm typecheck` is green.
- `src/modules/index.ts` remains a pure `Record<string, FastifyPluginAsync>`.

## Testing

Two hermetic files only, by decision: `test/mcp-projections.test.ts` (the
`system_prompt` leak guard and the projection key-sets) and
`test/mcp-budget.test.ts` (the byte ceilings and the `tools/list` size).

`identifiers.ts`, the run-waiter bridge, the tool handlers' branch logic, and the
entire HTTP path — `reply.hijack()`, the loopback guards, the transport
round-trip — have **no automated coverage** in v1. A required manual smoke test
in `src/modules/mcp/README.md` is the only evidence they work. The single test
that would close the gap is a DB-backed `test/mcp.it.test.ts`, which cannot be
written until it is settled whether `app.inject()` can observe a hijacked reply —
that answer changes the shape of every test in the file.
