/**
 * mcp — the `McpServer` factory: `instructions`, the tool descriptions, and the
 * registration walk over `TOOL_ORDER`.
 *
 * BUILT PER REQUEST. `routes.ts` constructs a fresh server (and transport) for
 * every POST, so the workspace resolved by `getContext` is a closure value and
 * can never leak into another request. That also means everything here runs on
 * the hot path: it is registration only — no IO, no DB, no `await`.
 *
 * WHAT IS DELIBERATELY ABSENT, so nobody re-adds it:
 *
 *   - `cacheHints`. MEASURED (2026-08-17): `@modelcontextprotocol/server@2.0.0`
 *     reports `LATEST_PROTOCOL_VERSION: '2025-11-25'` and its
 *     `SUPPORTED_PROTOCOL_VERSIONS` does not include `2026-07-28`. The 2026
 *     machinery (`ttlMs`, `cacheScope`, `server/discover`) exists in the typings
 *     but is unreachable — `tools/list` emits no cache fields and
 *     `server/discover` answers `-32601 Method not found`. The option would be
 *     dead weight. Deterministic `TOOL_ORDER` registration is NOT dead weight
 *     and stays: a stable order is what lets a client's prompt cache hit across
 *     sessions.
 *   - `outputSchema` / `structuredContent`. It would cost bytes in every
 *     `tools/list` AND send the payload twice to structured-output clients.
 *   - `resources` / `prompts` capabilities. Nothing serves them, and declaring a
 *     capability obliges the server to answer its requests.
 *
 * The byte budget is the reason the descriptions read the way they do. The five
 * input schemas plus tool names already cost 1615 bytes of the `tools/list`
 * payload against `TOOLS_LIST_BYTE_CEILING` (5120), so the five descriptions
 * share ~3500 bytes — critical sentence first, no examples paragraph. Each is
 * separately capped at `DESCRIPTION_BYTE_CEILING` (2048) by the client's
 * truncation, and `instructions` has its own 2048-byte budget which
 * `tools/list` does not carry.
 */

import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { PinoLike } from '../../platform/run-logger.js';
import { MAX_RESULT_SIZE_CHARS, TOOL, TOOL_ORDER, type ToolName } from './constants.js';
import {
  getBlastRadiusInputSchema,
  getConventionsInputSchema,
  getFindingsInputSchema,
  listAgentsInputSchema,
  runAgentOnPullRequestInputSchema,
} from './schemas.js';
import { getBlastRadius } from './tools/blast-radius.js';
import { getConventions } from './tools/get-conventions.js';
import { getFindings } from './tools/get-findings.js';
import { listAgents } from './tools/list-agents.js';
import { runAgentOnPullRequest } from './tools/run-agent.js';
import type { ToolEnv } from './tools/shared.js';
import type { McpDeps } from './types.js';

const SERVER_NAME = 'devdigest';
const SERVER_VERSION = '1.0.0';

/**
 * Loaded at the start of every session that connects, alongside the tool names —
 * and, in a client that defers definitions, INSTEAD of them. Critical first:
 * what this is, how things are identified, that one tool blocks, what the
 * findings deliberately omit, and that a miss answers with guidance.
 */
export const INSTRUCTIONS = [
  'DevDigest is a local code-review service holding imported GitHub repositories, their pull requests, and configured reviewer agents (each an LLM prompt plus a model). These tools drive it from the editor.',
  'Identifiers are flat: a repository is "owner/repo", a pull request is its number, and a reviewer is its NAME — call devdigest_list_agents for the names. There are no ids to construct.',
  'devdigest_run_agent_on_pull_request BLOCKS: it starts the review, waits, and returns the findings in one call, typically 30 s to 3 min. Do not poll it and do not call it twice for the same reviewer and pull request — a duplicate call attaches to the run already in flight.',
  'Findings are intentionally terse: {id, severity, file, line, title}. file and line locate the code; the full rationale and the suggested fix live in the DevDigest web UI, not here.',
  'Every tool answers a miss with guidance naming the next call and listing the valid values inline — an unknown repository comes back with the imported ones, an unknown reviewer with the configured names. Read that payload and retry; it is not an error.',
].join('\n\n');

/**
 * One description per tool, ordered as `TOOL_ORDER`. Kept here rather than in
 * each tool file so the whole startup cost is visible — and assertable — in one
 * place.
 */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  [TOOL.listAgents]:
    'List the DevDigest reviewers configured for this workspace and the model each uses. ' +
    'Call this before devdigest_run_agent_on_pull_request: it identifies a reviewer by NAME, and these are the only valid names. ' +
    'Set enabled_only to hide disabled reviewers. A reviewer\'s prompt is never returned.',

  [TOOL.runAgentOnPullRequest]:
    'Run one DevDigest reviewer over a pull request and return what it found. ' +
    'BLOCKS until the review finishes — typically 30 s to 3 min — so there is nothing to poll: one call yields {status, run_id, agent, verdict, score, counts, findings[]}. ' +
    'Identify the pull request by repo ("owner/repo") and pr (its number), the reviewer by agent NAME (devdigest_list_agents). The pull request must already be imported into DevDigest. ' +
    'If that reviewer is already running on that pull request the call attaches to the run in flight instead of starting a second one. ' +
    'Findings carry {id, severity, file, line, title} only — the rationale and the fix are in the DevDigest web UI. ' +
    'If the wait budget expires you get {status:"running", run_id}; read it later with devdigest_get_findings.',

  [TOOL.getFindings]:
    'Read back the findings of a review that already ran, without starting or paying for a new one. ' +
    'OMIT run_id to read the latest run of that pull request; pass it to read a specific one. ' +
    'Identify the pull request by repo ("owner/repo") and pr (its number). min_severity keeps CRITICAL / WARNING / SUGGESTION and above; limit caps the list (default 20). ' +
    'Returns {status, run_id, agent, verdict, score, counts, findings[]}. A run still in flight returns {status:"running"} rather than an empty list.',

  [TOOL.getConventions]:
    'List the coding conventions DevDigest extracted from a repository — the house rules its reviewers apply. Useful before writing code in an unfamiliar repo. ' +
    'Identify the repository as "owner/repo". Returns {repo, count, conventions:[{category, rule, confidence}]}, accepted rules only unless status is set to pending, rejected or all. ' +
    'Conventions are extracted on demand in the DevDigest web UI, so a repository nobody scanned answers with how to scan it.',

  [TOOL.getBlastRadius]:
    'Reports which symbols, callers and HTTP endpoints a set of changed files reaches inside an indexed repository — ' +
    'returns { changed_symbols, impacted_endpoints, caller_count }. ' +
    'Arguments: repo as "owner/repo", files as repository-relative paths (1-50).',
};

/**
 * Every tool result is one text block holding compact JSON. No
 * `structuredContent`: a structured-output client would then receive the whole
 * payload twice.
 */
function toolResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * `_meta["anthropic/maxResultSizeChars"]` on the two tools that can return a
 * long findings list. The client warns around 10k tokens and hard-caps at 25k;
 * the other three tools are bounded by construction and pay no bytes for it.
 */
const LARGE_RESULT_META = { 'anthropic/maxResultSizeChars': MAX_RESULT_SIZE_CHARS };

/**
 * Registration, keyed by tool name. `buildMcpServer` walks `TOOL_ORDER` over
 * this map — never `Object.keys`/`Object.values`, so the wire order is stated in
 * `constants.ts` and cannot drift with an edit to this object's key order.
 */
const REGISTRARS: Record<ToolName, (server: McpServer, env: ToolEnv) => void> = {
  [TOOL.listAgents]: (server, env) =>
    server.registerTool(
      TOOL.listAgents,
      {
        description: TOOL_DESCRIPTIONS[TOOL.listAgents],
        inputSchema: listAgentsInputSchema,
      },
      async (args) => toolResult(await listAgents(env, args)),
    ),

  [TOOL.runAgentOnPullRequest]: (server, env) =>
    server.registerTool(
      TOOL.runAgentOnPullRequest,
      {
        description: TOOL_DESCRIPTIONS[TOOL.runAgentOnPullRequest],
        inputSchema: runAgentOnPullRequestInputSchema,
        _meta: LARGE_RESULT_META,
      },
      async (args, ctx) => toolResult(await runAgentOnPullRequest(env, args, ctx)),
    ),

  [TOOL.getFindings]: (server, env) =>
    server.registerTool(
      TOOL.getFindings,
      {
        description: TOOL_DESCRIPTIONS[TOOL.getFindings],
        inputSchema: getFindingsInputSchema,
        _meta: LARGE_RESULT_META,
      },
      async (args) => toolResult(await getFindings(env, args)),
    ),

  [TOOL.getConventions]: (server, env) =>
    server.registerTool(
      TOOL.getConventions,
      {
        description: TOOL_DESCRIPTIONS[TOOL.getConventions],
        inputSchema: getConventionsInputSchema,
      },
      async (args) => toolResult(await getConventions(env, args)),
    ),

  [TOOL.getBlastRadius]: (server, env) =>
    server.registerTool(
      TOOL.getBlastRadius,
      {
        description: TOOL_DESCRIPTIONS[TOOL.getBlastRadius],
        inputSchema: getBlastRadiusInputSchema,
      },
      async (args) => toolResult(await getBlastRadius(env, args)),
    ),
};

/**
 * Build the MCP server for one request.
 *
 * `deps` is the module's whole reach into the app (`types.ts`); `ctx` carries
 * the tenancy resolved at the HTTP edge plus the request logger, so nothing
 * below this line touches Fastify or the container.
 */
export function buildMcpServer(
  deps: McpDeps,
  ctx: { workspaceId: string; logger: PinoLike },
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  const env: ToolEnv = { deps, workspaceId: ctx.workspaceId, logger: ctx.logger };
  for (const name of TOOL_ORDER) REGISTRARS[name](server, env);

  return server;
}
