/**
 * mcp/tools — what more than one tool needs: the handler environment, the
 * result envelope, and the two resolutions (`repo`, then `pr`) that four of the
 * five tools open with.
 *
 * Nothing here throws. Every resolution returns `{ok:false, payload}` carrying a
 * guidance object from `projections.ts`, because a miss must reach the client as
 * OUR payload naming the next call — never as an MCP error (принцип 4).
 *
 * The handlers return plain payloads; wrapping them in `content[]` happens once,
 * in `server.ts`. That keeps every tool file free of the SDK's result shape and
 * makes a handler callable from a test with three plain objects.
 */

import type { PullRow, RepoRow } from '../../../db/rows.js';
import type { PinoLike } from '../../../platform/run-logger.js';
import type { ReviewDto } from '../../reviews/types.js';
import type { Severity } from '@devdigest/shared';
import { TOOL } from '../constants.js';
import { coerceInt, coerceString, normalizeRepoRef } from '../identifiers.js';
import {
  filterBySeverity,
  guidance,
  projectFinding,
  pullNotFound,
  repoNotFound,
  severityCounts,
  sortFindings,
  truncate,
} from '../projections.js';
import type { McpDeps, McpFinding, McpGuidance, McpSeverityCounts } from '../types.js';

/**
 * Everything a handler is given besides its arguments. Built once per request in
 * `routes.ts` — `workspaceId` comes from `getContext`, so tenancy is resolved at
 * the transport edge and passed down as a value, never inferred deeper in.
 */
export interface ToolEnv {
  deps: McpDeps;
  workspaceId: string;
  logger: PinoLike;
}

/**
 * A resolution either produced a row or produced the guidance payload the tool
 * must return instead. Discriminated so a handler cannot forget the miss branch.
 */
export type Resolved<T> = { ok: true; value: T } | { ok: false; payload: McpGuidance };

const miss = (payload: McpGuidance): { ok: false; payload: McpGuidance } => ({
  ok: false,
  payload,
});

/** Imported repositories by full name — the inline list every repo miss carries. */
async function importedRepoNames(env: ToolEnv): Promise<string[]> {
  const repos = await env.deps.reposRepo.list(env.workspaceId);
  return repos.map((r) => r.fullName);
}

/**
 * `repo` → the imported repository row.
 *
 * Three distinct misses, three distinct messages: the argument is absent, the
 * string is not a repository reference, or the repository is not imported. All
 * three list the imported repositories inline so the model can retry without a
 * round-trip through `devdigest_list_agents`-style discovery.
 */
export async function resolveRepo(env: ToolEnv, input: unknown): Promise<Resolved<RepoRow>> {
  const ref = normalizeRepoRef(input);
  if ('error' in ref) {
    const names = await importedRepoNames(env);
    const inline = names.length > 0 ? names.join(', ') : '(none imported)';
    // The "нічого не required" consequence: an omitted `repo` reaches us rather
    // than being rejected by the SDK's validator, so this is the answer to it.
    const absent = coerceString(input) === undefined;
    return miss(
      guidance(
        absent ? 'repo_required' : 'repo_invalid',
        absent
          ? `Which repository? Pass repo as "owner/repo". Imported: ${inline}.`
          : `${ref.error}. Imported: ${inline}.`,
        names.length > 0
          ? `retry with repo set to one of: ${inline}`
          : 'import a repository in DevDigest (Repos → Add repository), then retry',
        { available_repos: names },
      ),
    );
  }

  const repo = await env.deps.reposRepo.findByFullName(env.workspaceId, ref.fullName);
  if (!repo) return miss(repoNotFound(await importedRepoNames(env)));
  return { ok: true, value: repo };
}

/** `pr` → the synced pull-request row of an already-resolved repository. */
export async function resolvePull(
  env: ToolEnv,
  repo: RepoRow,
  input: unknown,
): Promise<Resolved<PullRow>> {
  const number = coerceInt(input);
  if (number === undefined || number <= 0) {
    return miss(
      guidance(
        'pr_required',
        `Which pull request of ${repo.fullName}? Pass pr as the PR number (e.g. 412).`,
        `retry with repo="${repo.fullName}" and pr set to the pull request number`,
        { repo: repo.fullName },
      ),
    );
  }

  const pull = await env.deps.pullsRepo.findByRepoAndNumber(env.workspaceId, repo.id, number);
  if (!pull) return miss(pullNotFound(repo.fullName, number));
  return { ok: true, value: pull };
}

/** `min_severity` → a `Severity`, or the guidance for an unknown value. */
export function resolveMinSeverity(input: unknown): Resolved<Severity | undefined> {
  const raw = coerceString(input);
  if (raw === undefined) return { ok: true, value: undefined };
  const upper = raw.toUpperCase();
  if (upper === 'CRITICAL' || upper === 'WARNING' || upper === 'SUGGESTION') {
    return { ok: true, value: upper };
  }
  return miss(
    guidance(
      'min_severity_invalid',
      `"${raw}" is not a severity. Valid values: CRITICAL, WARNING, SUGGESTION.`,
      `retry with min_severity set to one of: CRITICAL, WARNING, SUGGESTION — or omit it for all findings`,
    ),
  );
}

/** The findings half of the run / get-findings payloads. */
export interface ShapedFindings {
  counts: McpSeverityCounts;
  findings: McpFinding[];
  /** Present only when the list was cut — `counts` already carries the tally. */
  total?: number;
  next?: string;
}

/**
 * A persisted review → the wire's findings block.
 *
 * `counts` is deliberately computed over the WHOLE review, before
 * `min_severity` narrows the list: the tally is a property of the review, and a
 * model that asked for CRITICAL only still needs to know 30 warnings exist.
 */
export function shapeFindings(
  review: ReviewDto,
  opts: { minSeverity?: Severity | undefined; limit: number },
): ShapedFindings {
  const all = review.findings.map(projectFinding);
  const counts = severityCounts(all);
  const selected = opts.minSeverity ? filterBySeverity(all, opts.minSeverity) : all;
  const { shown, total, next } = truncate(sortFindings(selected), opts.limit);

  const shaped: ShapedFindings = { counts, findings: shown };
  if (shown.length !== total) shaped.total = total;
  if (next !== undefined) shaped.next = next;
  return shaped;
}

/**
 * The review a run produced. `run_id` is the only link: `reviewsForPull` returns
 * every review of the PR, one per agent per run.
 */
export function reviewForRun(reviews: ReviewDto[], runId: string): ReviewDto | undefined {
  return reviews.find((r) => r.run_id === runId);
}

/** "No review has ever run here" — the same answer from two tools. */
export function noRunsGuidance(repo: string, pr: number): McpGuidance {
  return guidance(
    'no_runs',
    `No review has been run on ${repo}#${pr} yet.`,
    `call ${TOOL.runAgentOnPullRequest} with repo="${repo}", pr=${pr} and an agent name from ${TOOL.listAgents}`,
    { repo, pr },
  );
}
