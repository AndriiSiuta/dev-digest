/**
 * mcp — row → MCP-wire projections. Pure, and the module's SECURITY BOUNDARY.
 *
 * This file is the only field allowlist in the path: no route in this server
 * declares `schema.response` (`INSIGHTS.md:34`), so the zod serializer compiler
 * strips nothing, and the `/mcp` route hijacks the reply anyway. Whatever a
 * projection emits reaches the MCP client verbatim — `agents.system_prompt`
 * included, if it were ever let through.
 *
 * Hence the two hard rules here:
 *   1. Every object is built with EXPLICIT LITERAL KEYS. Never spread a row and
 *      delete fields — a new column then ships to clients the day it is added.
 *   2. One shape per source. No `detailed` mode, no `response_format` toggle;
 *      the escape hatch for more detail is a separate tool (see
 *      `specs/01-mcp-server.md` § Accepted limitation).
 *
 * The guidance builders live here too, so the single projections test covers
 * them — "unknown agent lists every available name inline" is an acceptance
 * criterion, not a nicety.
 */

import type { Severity } from '@devdigest/shared';
import type { AgentRow, ConventionRow } from '../../db/rows.js';
import { FINDINGS_DEFAULT_LIMIT, TOOL } from './constants.js';
import type {
  BlastResult,
  McpAgent,
  McpBlast,
  McpConvention,
  McpFinding,
  McpFindingSource,
  McpGuidance,
  McpRunResult,
  McpRunSource,
  McpSeverityCounts,
} from './types.js';

/**
 * Highest first. Declared locally rather than imported: `rollupSeverities` in
 * `modules/pulls/status.ts` is lowercase (`INSIGHTS.md:79`) and a cross-module
 * `status.ts` import is banned by `no-cross-module-internals` anyway.
 */
const SEVERITY_ORDER: readonly Severity[] = ['CRITICAL', 'WARNING', 'SUGGESTION'];

const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 3, WARNING: 2, SUGGESTION: 1 };

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * An agent, as an MCP client may see it. `system_prompt` and `output_schema`
 * are the reason this function exists — they are an agent's entire IP and are
 * never emitted.
 */
export function projectAgent(row: AgentRow): McpAgent {
  return {
    name: row.name,
    model: row.model,
    enabled: row.enabled,
  };
}

/** A finding. `rationale` / `suggestion` / `confidence` / `category` stay behind. */
export function projectFinding(f: McpFindingSource): McpFinding {
  return {
    id: f.id,
    severity: f.severity,
    file: f.file,
    line: f.start_line,
    title: f.title,
  };
}

/** A convention. `rationale` and every `evidence_*` column stay behind. */
export function projectConvention(row: ConventionRow): McpConvention {
  return {
    category: row.category,
    rule: row.rule,
    confidence: row.confidence,
  };
}

/**
 * A run. Cost and token accounting (`tokens_in/out`, `cost_usd`), `grounding`
 * and `provider` stay behind; `score` and `error` are omitted entirely when
 * null rather than emitted as `null`.
 */
export function projectRun(run: McpRunSource): McpRunResult {
  const out: McpRunResult = {
    status: run.status ?? 'unknown',
    run_id: run.run_id,
  };
  if (run.score !== null && run.score !== undefined) out.score = run.score;
  if (run.error !== null && run.error !== undefined) out.error = run.error;
  return out;
}

/**
 * A blast radius. `factsByFile` (an internal per-file read-model detail) is
 * never emitted, and `callers[]` is summarized to a count — a full caller list
 * is the single biggest payload in the surface and locates nothing an agent
 * cannot re-derive from the changed symbols.
 */
export function projectBlast(blast: BlastResult): McpBlast {
  return {
    changed_symbols: blast.changedSymbols.map((s) => ({
      file: s.file,
      name: s.name,
      kind: s.kind,
    })),
    impacted_endpoints: [...blast.impactedEndpoints],
    caller_count: blast.callers.length,
  };
}

// ---------------------------------------------------------------------------
// Finding list shaping
// ---------------------------------------------------------------------------

/** Per-severity tally. Always all three keys, so a caller never branches on absence. */
export function severityCounts(findings: readonly { severity: Severity }[]): McpSeverityCounts {
  const counts: McpSeverityCounts = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
  for (const f of findings) {
    // `Object.hasOwn`, NOT `severity in counts`: `in` walks the prototype chain,
    // so a severity of 'toString' / 'constructor' / 'valueOf' passed the guard and
    // added a FOURTH key to a payload documented as always exactly three — which
    // then shipped to the client. Reachable, not theoretical: `findingRowToDto`
    // (modules/reviews/helpers.ts) casts the free-text `findings.severity` column
    // straight to `Severity`, and Drizzle's `text(…, {enum})` emits no DB
    // constraint. Pinned by test/mcp-projections.test.ts.
    if (Object.hasOwn(counts, f.severity)) counts[f.severity] += 1;
  }
  return counts;
}

/**
 * CRITICAL → WARNING → SUGGESTION, then file, then line. Fully deterministic
 * (no ties left to input order) and non-mutating — the caller's array is a
 * projection of persisted rows that other code may still be reading.
 */
export function sortFindings(findings: readonly McpFinding[]): McpFinding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (bySeverity !== 0) return bySeverity;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Keep findings at or above `min` (CRITICAL is the highest bar). */
export function filterBySeverity(
  findings: readonly McpFinding[],
  min: Severity,
): McpFinding[] {
  const floor = SEVERITY_RANK[min] ?? 0;
  return findings.filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= floor);
}

/**
 * Cap a findings list. `next` names a NARROWER call rather than a page: there
 * is no offset argument in the surface, so the honest way forward is a higher
 * severity floor — unless everything shown is already CRITICAL, in which case
 * only a bigger `limit` helps.
 */
export function truncate(
  findings: readonly McpFinding[],
  limit: number,
): { shown: McpFinding[]; total: number; next?: string } {
  const total = findings.length;
  if (total <= limit) return { shown: [...findings], total };

  const shown = findings.slice(0, limit);
  const allCritical = shown.every((f) => f.severity === 'CRITICAL');
  const next = allCritical
    ? `showing ${limit} of ${total} findings — call ${TOOL.getFindings} again with a higher limit (default ${FINDINGS_DEFAULT_LIMIT})`
    : `showing ${limit} of ${total} findings — call ${TOOL.getFindings} with min_severity="CRITICAL" to narrow`;
  return { shown, total, next };
}

// ---------------------------------------------------------------------------
// Guidance — принцип 4, "помилка веде далі". None of these throws.
// ---------------------------------------------------------------------------

/**
 * The one guidance shape. `code` is stable and machine-readable, `message`
 * states the miss with the valid values listed INLINE (a model should not need
 * a second round-trip to recover), `next` names the exact call to make.
 *
 * `extra` is literal-built by the caller — never a database row, or this file
 * stops being an allowlist.
 */
export function guidance(
  code: string,
  message: string,
  next: string,
  extra?: Record<string, unknown>,
): McpGuidance {
  return { error: code, message, next, ...(extra ?? {}) };
}

/** Unknown agent. Lists every available name inline — an acceptance criterion. */
export function agentNotFound(available: string[]): McpGuidance {
  const names = available.length > 0 ? available.join(', ') : '(none configured)';
  return guidance(
    'agent_not_found',
    `No reviewer by that name. Available agents: ${names}.`,
    available.length > 0
      ? `retry with agent set to one of: ${names}`
      : `create a reviewer in DevDigest first, then call ${TOOL.listAgents}`,
    { available_agents: available },
  );
}

/** Unknown repo. Lists the imported repos inline, same contract as above. */
export function repoNotFound(available: string[]): McpGuidance {
  const names = available.length > 0 ? available.join(', ') : '(none imported)';
  return guidance(
    'repo_not_found',
    `That repository is not imported into DevDigest. Imported repos: ${names}.`,
    available.length > 0
      ? `retry with repo set to one of: ${names}`
      : 'import the repository in DevDigest (Repos → Add repository), then retry',
    { available_repos: available },
  );
}

/** Known repo, unknown PR — the PR exists on GitHub but was never synced here. */
export function pullNotFound(repo: string, pr: number): McpGuidance {
  return guidance(
    'pull_not_found',
    `Pull request #${pr} of ${repo} is not in DevDigest.`,
    `open ${repo} in DevDigest to sync its pull requests, then retry with repo="${repo}" and pr=${pr}`,
    { repo, pr },
  );
}

/**
 * A run by this agent is already in flight for this pull request. Not a
 * failure: the run tool attaches to it rather than starting (and paying for) a
 * second one — this payload is for the callers that only need to know why.
 */
export function runInFlight(agentName: string): McpGuidance {
  return guidance(
    'run_in_flight',
    `A review by "${agentName}" is already running on this pull request; attached to it instead of starting a second run.`,
    `wait for this call to return, or read the result later with ${TOOL.getFindings}`,
    { agent: agentName },
  );
}
