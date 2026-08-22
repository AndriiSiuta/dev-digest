/**
 * `devdigest_get_conventions` — a repository's extracted house rules.
 *
 * The status filter lives HERE, not in `projections.ts`: `projectConvention`
 * drops `status` (it is a workflow field, not something a reviewing agent acts
 * on), so filtering after projection would be filtering on a field that no
 * longer exists. Rows are selected first, projected second.
 *
 * `accepted` is the default because a `pending` row is a model's PROPOSAL that
 * nobody has verified — handing those to an agent as house rules would launder
 * a guess into a rule.
 */

import type { ConventionRow } from '../../../db/rows.js';
import { CONVENTIONS_LIMIT, TOOL } from '../constants.js';
import { coerceString } from '../identifiers.js';
import { guidance, projectConvention } from '../projections.js';
import type { GetConventionsInput } from '../schemas.js';
import type { McpConvention, McpGuidance } from '../types.js';
import { resolveRepo, type ToolEnv } from './shared.js';

/** Mirrors the `conventions.status` CHECK constraint, plus our `all` escape. */
const STATUSES = ['accepted', 'pending', 'rejected'] as const;
type ConventionStatus = (typeof STATUSES)[number];

export interface GetConventionsResult {
  repo: string;
  count: number;
  conventions: McpConvention[];
  next?: string;
}

export async function getConventions(
  env: ToolEnv,
  args: GetConventionsInput,
): Promise<GetConventionsResult | McpGuidance> {
  const repo = await resolveRepo(env, args.repo);
  if (!repo.ok) return repo.payload;

  const requested = (coerceString(args.status) ?? 'accepted').toLowerCase();
  if (requested !== 'all' && !isStatus(requested)) {
    return guidance(
      'status_invalid',
      `"${requested}" is not a convention status. Valid values: accepted, pending, rejected, all.`,
      'retry with status omitted (accepted rules only) or set to one of: accepted, pending, rejected, all',
    );
  }

  const rows = await env.deps.conventionsRepo.listForRepo(env.workspaceId, repo.value.id);
  const selected = requested === 'all' ? rows : rows.filter((r) => r.status === requested);

  if (selected.length === 0) {
    return emptyGuidance(repo.value.fullName, requested, rows);
  }

  const shown = selected.slice(0, CONVENTIONS_LIMIT);
  const result: GetConventionsResult = {
    repo: repo.value.fullName,
    count: selected.length,
    conventions: shown.map(projectConvention),
  };
  if (shown.length < selected.length) {
    result.next = `showing ${shown.length} of ${selected.length} — the rest are visible in the DevDigest web UI (Conventions)`;
  }
  return result;
}

function isStatus(v: string): v is ConventionStatus {
  return (STATUSES as readonly string[]).includes(v);
}

/**
 * An empty result is a dead end, so it answers with the way out rather than
 * `[]`. Two different dead ends: nothing was ever extracted, or rules exist but
 * not in the requested state — and the second one names the states that do have
 * rows, so the retry is one call away.
 */
function emptyGuidance(
  fullName: string,
  requested: string,
  rows: ConventionRow[],
): McpGuidance {
  if (rows.length === 0) {
    return guidance(
      'no_conventions',
      `No conventions have been extracted for ${fullName}.`,
      'run the conventions extractor for this repository in the DevDigest web UI (Conventions → Extract), then retry',
      { repo: fullName },
    );
  }

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const inline = [...byStatus].map(([s, n]) => `${n} ${s}`).join(', ');
  return guidance(
    'no_conventions',
    `No ${requested} conventions for ${fullName} — it has ${inline}.`,
    `review and accept them in the DevDigest web UI, or call ${TOOL.getConventions} with status="all" to see every candidate`,
    { repo: fullName },
  );
}
