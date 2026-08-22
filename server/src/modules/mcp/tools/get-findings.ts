/**
 * `devdigest_get_findings` — read back a review that already ran.
 *
 * Two things about the surface are decided here rather than in the schema:
 *
 *   - `run_id` carries NO per-property description (bytes), so the tool
 *     description in `server.ts` is what tells the model that omitting it reads
 *     the latest run. Without that sentence the argument looks mandatory.
 *   - A run still in flight is not an error and not an empty list: it comes back
 *     as `{status:'running', run_id, next}`, the same handle the run tool
 *     returns when its wait budget expires.
 */

import { FINDINGS_DEFAULT_LIMIT, TOOL } from '../constants.js';
import { coerceInt, coerceString } from '../identifiers.js';
import { guidance, projectRun } from '../projections.js';
import type { GetFindingsInput } from '../schemas.js';
import type { McpGuidance, McpRunResult } from '../types.js';
import {
  noRunsGuidance,
  resolveMinSeverity,
  resolvePull,
  resolveRepo,
  reviewForRun,
  shapeFindings,
  type ShapedFindings,
  type ToolEnv,
} from './shared.js';

export interface GetFindingsResult extends McpRunResult, Partial<ShapedFindings> {
  agent?: string;
  verdict?: string;
  next?: string;
}

/** `limit` is clamped rather than refused — an out-of-range number is not a miss. */
const MAX_LIMIT = 100;

export async function getFindings(
  env: ToolEnv,
  args: GetFindingsInput,
): Promise<GetFindingsResult | McpGuidance> {
  const repo = await resolveRepo(env, args.repo);
  if (!repo.ok) return repo.payload;

  const pull = await resolvePull(env, repo.value, args.pr);
  if (!pull.ok) return pull.payload;

  const minSeverity = resolveMinSeverity(args.min_severity);
  if (!minSeverity.ok) return minSeverity.payload;

  const requestedRunId = coerceString(args.run_id);
  const runs = await env.deps.reviewRunner.listRuns(env.workspaceId, pull.value.id);
  if (runs.length === 0) return noRunsGuidance(repo.value.fullName, pull.value.number);

  // `listRuns` is newest first, so "no run_id" means "the latest run".
  const run = requestedRunId ? runs.find((r) => r.run_id === requestedRunId) : runs[0];
  if (!run) {
    return guidance(
      'run_not_found',
      `No run "${requestedRunId}" on ${repo.value.fullName}#${pull.value.number}. That pull request has ${runs.length} run(s).`,
      `call ${TOOL.getFindings} again without run_id to read the latest run`,
      { repo: repo.value.fullName, pr: pull.value.number },
    );
  }

  const base: GetFindingsResult = {
    ...projectRun(run),
    ...(run.agent_name !== null ? { agent: run.agent_name } : {}),
  };

  if (run.status === 'running') {
    return {
      ...base,
      status: 'running',
      next: `the review is still going — call ${TOOL.getFindings} again in a minute, or start it with ${TOOL.runAgentOnPullRequest} to wait for it in one call`,
    };
  }

  const reviews = await env.deps.reviewRunner.reviewsForPull(env.workspaceId, pull.value.id);
  const review = reviewForRun(reviews, run.run_id);
  if (!review) {
    // A failed or cancelled run persists no review; so does a run from before
    // reviews were linked by run_id. Both get the run's own error, not silence.
    return {
      ...base,
      next: `that run produced no findings (status ${base.status}) — run ${TOOL.runAgentOnPullRequest} again, or inspect it in the DevDigest web UI`,
    };
  }

  const limit = Math.min(coerceInt(args.limit) ?? FINDINGS_DEFAULT_LIMIT, MAX_LIMIT);
  return {
    ...base,
    score: review.score ?? base.score,
    ...(review.verdict !== null ? { verdict: review.verdict } : {}),
    ...shapeFindings(review, {
      minSeverity: minSeverity.value,
      limit: limit > 0 ? limit : FINDINGS_DEFAULT_LIMIT,
    }),
  };
}
