/**
 * `devdigest_list_agents` — the discovery tool. Every other tool identifies a
 * reviewer by NAME, and this is the only place those names come from.
 *
 * The security-relevant one: `projectAgent` emits `{name, model, enabled}` and
 * nothing else, so `system_prompt` (an agent's entire IP) and `output_schema`
 * never reach a client. Asserted on `Object.keys()` in
 * `test/mcp-projections.test.ts`.
 */

import { TOOL } from '../constants.js';
import { guidance, projectAgent } from '../projections.js';
import type { ListAgentsInput } from '../schemas.js';
import type { McpAgent, McpGuidance } from '../types.js';
import type { ToolEnv } from './shared.js';

export interface ListAgentsResult {
  count: number;
  agents: McpAgent[];
}

/**
 * `enabled_only` is the one boolean in the surface. The JSON Schema types it,
 * but nothing validates at call time, so `"true"` is a legitimate arrival —
 * anything else is read as false rather than answered with guidance, which would
 * be noise for an argument whose miss costs nothing.
 */
function wantsEnabledOnly(v: unknown): boolean {
  return v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

export async function listAgents(
  env: ToolEnv,
  args: ListAgentsInput,
): Promise<ListAgentsResult | McpGuidance> {
  const enabledOnly = wantsEnabledOnly(args.enabled_only);
  const rows = enabledOnly
    ? await env.deps.agentsRepo.listEnabled(env.workspaceId)
    : await env.deps.agentsRepo.list(env.workspaceId);

  if (rows.length === 0) {
    // An empty list is a dead end for every other tool, so it answers with the
    // way out rather than `{count: 0}`.
    const all = enabledOnly ? await env.deps.agentsRepo.list(env.workspaceId) : rows;
    return guidance(
      'no_agents',
      enabledOnly && all.length > 0
        ? `No ENABLED reviewers in this workspace (${all.length} disabled).`
        : 'No reviewers are configured in this workspace.',
      enabledOnly && all.length > 0
        ? `call ${TOOL.listAgents} without enabled_only to see the disabled ones, or enable one in the DevDigest web UI`
        : 'create a reviewer in the DevDigest web UI (Agents → New agent), then retry',
    );
  }

  return { count: rows.length, agents: rows.map(projectAgent) };
}
