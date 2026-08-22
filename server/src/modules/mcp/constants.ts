/**
 * MCP module constants — every tunable in one place, nothing inline in
 * `server.ts`, the tools or `run-waiter.ts`.
 *
 * Two groups matter for different reasons: the BYTE CEILINGS exist because
 * Claude Code truncates a tool description and the server `instructions` at
 * 2 KB and because `tools/list` is paid for at the start of every session; the
 * TIMING budgets exist because the MCP client has a 60 s first-byte timer and a
 * 5 min idle timer that a blocking tool call must keep fed.
 */

/** The single MCP endpoint. Streamable HTTP, stateless, loopback-only. */
export const MCP_ROUTE = '/mcp';

/**
 * Tool names. `devdigest_` prefixed so they never collide with another server's
 * tools in a client that flattens the namespace.
 */
export const TOOL = {
  listAgents: 'devdigest_list_agents',
  runAgentOnPullRequest: 'devdigest_run_agent_on_pull_request',
  getFindings: 'devdigest_get_findings',
  getConventions: 'devdigest_get_conventions',
  getBlastRadius: 'devdigest_get_blast_radius',
} as const;

export type ToolName = (typeof TOOL)[keyof typeof TOOL];

/**
 * `tools/list` SHOULD be deterministically ordered (protocol revision
 * 2026-07-28) — a stable order is what lets a client's prompt cache hit across
 * sessions. Registration order must match this exactly; the budget test asserts
 * the parity.
 */
export const TOOL_ORDER: readonly ToolName[] = [
  TOOL.listAgents,
  TOOL.runAgentOnPullRequest,
  TOOL.getFindings,
  TOOL.getConventions,
  TOOL.getBlastRadius,
] as const;

// --- Startup-cost ceilings (asserted in test/mcp-budget.test.ts) ------------

/** Claude Code truncates a tool `description` at 2 KB. Bytes, not characters. */
export const DESCRIPTION_BYTE_CEILING = 2048;

/** Same 2 KB truncation applies to the server `instructions` string. */
export const INSTRUCTIONS_BYTE_CEILING = 2048;

/**
 * The whole serialized `tools/list` payload. Named so the assertion cannot
 * drift silently — every byte here is paid at the start of every session that
 * loads definitions upfront (`ENABLE_TOOL_SEARCH=false`, Cursor, Windsurf).
 */
export const TOOLS_LIST_BYTE_CEILING = 5120;

// --- Result-size limits -----------------------------------------------------

/** Findings returned per call unless the caller passes `limit`. */
export const FINDINGS_DEFAULT_LIMIT = 20;

/** Conventions returned per call; the surface has no `limit` argument. */
export const CONVENTIONS_LIMIT = 50;

/**
 * `_meta["anthropic/maxResultSizeChars"]` per tool. The client warns at ~10k
 * tokens and hard-caps at ~25k; the SDK ceiling for this override is 500,000.
 */
export const MAX_RESULT_SIZE_CHARS = 200_000;

// --- Blocking-run timing ----------------------------------------------------

/**
 * How long `run_agent_on_pull_request` waits before returning a usable handle
 * instead of the findings. This is the SOLE protection against a hang:
 * `runBus.complete` is guaranteed only on the three paths in
 * `reviews/run-executor.ts`, so a rejection outside them never fires `onDone`.
 */
export const RUN_WAIT_BUDGET_MS = 600_000;

/**
 * The same budget when the client sent no `progressToken`. With no token we may
 * send no `notifications/progress` (that would be protocol-invalid), so the only
 * thing keeping the 60 s first-byte timer alive is whatever the transport
 * flushed on its own.
 *
 * MEASURED (2026-08-17, plan step 1.4): the transport flushes response headers at
 * +3 ms regardless of whether the handler sends anything, and emits its own SSE
 * `: keepalive` comment every 15 s unprompted. A 90 s completely silent call was
 * observed surviving with headers at +3 ms and keepalives at +15/30/45/60/75 s.
 * So the 60 s first-byte timer is never in play and the binding constraint is the
 * 5 min idle timer — which the built-in keepalive also feeds.
 */
export const RUN_WAIT_BUDGET_NO_TOKEN_MS = 240_000;

/**
 * Coalescing window for the run-event → progress-notification pump. `RunBus.
 * subscribe` replays its whole buffer synchronously, which would otherwise fire
 * dozens of notifications at once; only the newest pending event is emitted per
 * window. `result` / `error` events bypass the throttle.
 */
export const PROGRESS_THROTTLE_MS = 2_000;

/**
 * Re-send the last progress message on this interval when the run is quiet, so
 * the client's 5 min idle timer stays an order of magnitude away and the first
 * byte lands well inside 60 s.
 */
export const PROGRESS_HEARTBEAT_MS = 30_000;

/**
 * Whether a request abort (`ctx.mcpReq.signal`) cancels the underlying review
 * through `reviewRunner.cancelRun`.
 *
 * MEASURED (2026-08-17, plan step 1.5): a bare socket close does NOT abort the
 * signal — `signal.aborted` stayed `false` and the handler ran its full 90 s, with
 * only `reply.raw`'s `close` firing. So honouring an abort cannot destroy a
 * paid-for review on a transient disconnect, and `true` is safe.
 *
 * CAVEAT, also measured: under the per-request transport this module uses, the
 * signal never fires AT ALL. An explicit `notifications/cancelled` POSTed on a
 * second connection returns 202 and does not abort, because each POST builds a
 * fresh `McpServer` and the cancel reaches an instance that never saw the
 * request; the same cancel against a shared module-scope transport aborts in
 * ~4 ms. So this flag is correct but currently has no occasion to fire. It starts
 * paying the day the transport is hoisted out of the request. See the abort path
 * in `run-waiter.ts`.
 */
export const CANCEL_ON_ABORT = true;
