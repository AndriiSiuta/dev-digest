/**
 * `devdigest_run_agent_on_pull_request` — the one tool that BLOCKS.
 *
 * It starts the review, waits for it, and returns the findings in a single call
 * (принцип 1: результат, а не операція). The waiting itself lives in
 * `run-waiter.ts`; what lives here is the ORDER, which is load-bearing:
 *
 *   coerce args → resolve repo → resolve PR → activeRuns guard → resolve agent
 *   → runReview → waitForRun → refine the outcome → project
 *
 * The guard sits BEFORE the agent lookup on purpose. In-flight runs carry the
 * agent NAME, which is all the guard compares, and a blocking tool makes the
 * guard matter far more than it did when the call returned a handle: without it
 * a duplicate call would block a second time on the same work and pay for a
 * second LLM run. Same agent → ATTACH to the run already going. Different agent
 * → guidance, because two concurrent reviews on one PR is a decision the caller
 * should make explicitly, not a side effect of a retry.
 */

import type { RunSummary } from '@devdigest/shared';
import type { ServerContext } from '@modelcontextprotocol/server';
import type { PullRow } from '../../../db/rows.js';
import {
  FINDINGS_DEFAULT_LIMIT,
  RUN_WAIT_BUDGET_MS,
  RUN_WAIT_BUDGET_NO_TOKEN_MS,
  TOOL,
} from '../constants.js';
import { coerceString, matchAgentByName } from '../identifiers.js';
import { agentNotFound, guidance, projectRun, runInFlight } from '../projections.js';
import { waitForRun, type WaitOutcome } from '../run-waiter.js';
import type { RunAgentOnPullRequestInput } from '../schemas.js';
import type { McpGuidance, McpRunResult } from '../types.js';
import {
  reviewForRun,
  resolvePull,
  resolveRepo,
  shapeFindings,
  type ShapedFindings,
  type ToolEnv,
} from './shared.js';

export interface RunAgentResult extends McpRunResult, Partial<ShapedFindings> {
  agent: string;
  verdict?: string;
  /** Present only when the call joined a run that was already going. */
  attached?: boolean;
  note?: string;
  next?: string;
}

export async function runAgentOnPullRequest(
  env: ToolEnv,
  args: RunAgentOnPullRequestInput,
  mcp: ServerContext,
): Promise<RunAgentResult | McpGuidance> {
  const repo = await resolveRepo(env, args.repo);
  if (!repo.ok) return repo.payload;

  const pull = await resolvePull(env, repo.value, args.pr);
  if (!pull.ok) return pull.payload;

  // --- the guard ----------------------------------------------------------
  const wanted = coerceString(args.agent);
  const active = await env.deps.reviewRunner.activeRuns(env.workspaceId, pull.value.id);
  const sameAgent = active.find(
    (r) => wanted !== undefined && sameName(r.agent_name, wanted),
  );

  let runId: string;
  let agentName: string;
  let attached = false;

  if (sameAgent) {
    // ATTACH: no second run, no second bill. The wait below is identical — the
    // bus replays this run's buffered events synchronously on subscribe.
    runId = sameAgent.run_id;
    agentName = sameAgent.agent_name ?? wanted!;
    attached = true;
  } else if (active.length > 0) {
    const other = active[0]?.agent_name ?? 'another reviewer';
    return guidance(
      'run_in_flight',
      `A review by "${other}" is already running on ${repo.value.fullName}#${pull.value.number}. Only one review at a time is started from here.`,
      `wait for it and read the result with ${TOOL.getFindings} (repo="${repo.value.fullName}", pr=${pull.value.number}), or retry this call with agent="${other}" to attach to it`,
      { agent: other, repo: repo.value.fullName, pr: pull.value.number },
    );
  } else {
    const agents = await env.deps.agentsRepo.list(env.workspaceId);
    const agent = matchAgentByName(args.agent, agents);
    if (!agent) return agentNotFound(agents.map((a) => a.name));

    const started = await env.deps.reviewRunner.runReview(
      env.workspaceId,
      pull.value.id,
      [agent],
      env.logger,
    );
    const first = started.runs[0];
    if (!first) {
      // Not reachable through the port's contract, but a silent `undefined`
      // here would surface as a crash instead of a payload.
      return guidance(
        'run_not_started',
        `DevDigest did not start a run for "${agent.name}" on ${repo.value.fullName}#${pull.value.number}.`,
        `retry, or run the review from the DevDigest web UI to see why it was refused`,
      );
    }
    runId = first.run_id;
    agentName = first.agent_name;
  }

  // --- the wait -----------------------------------------------------------
  // No `progressToken` means no notifications may be sent at all, so the budget
  // shortens: the caller is waiting blind and a shorter handle-back is kinder
  // than a longer silence.
  const budgetMs =
    mcp.mcpReq._meta?.progressToken !== undefined
      ? RUN_WAIT_BUDGET_MS
      : RUN_WAIT_BUDGET_NO_TOKEN_MS;
  const waited = await waitForRun(runId, env.deps, mcp, budgetMs);

  // --- refine + project ---------------------------------------------------
  // `waitForRun` reports a BUS-level outcome: `'done'` means the bus completed,
  // not that the review succeeded. The status lives on the `agent_runs` row, and
  // this handler has to read `listRuns` anyway to build `{score, error}` — which
  // is exactly why the refinement is here and not in the waiter.
  const runs = await env.deps.reviewRunner.listRuns(env.workspaceId, pull.value.id);
  const run = runs.find((r) => r.run_id === runId);
  const outcome = refineOutcome(waited, run);

  const base: RunAgentResult = {
    ...projectRun({
      run_id: runId,
      status: outcome === 'aborted' ? 'running' : outcome,
      score: run?.score ?? null,
      error: run?.error ?? null,
    }),
    agent: agentName,
  };
  if (attached) {
    base.attached = true;
    base.note = runInFlight(agentName).message;
  }

  if (outcome === 'timeout' || outcome === 'aborted') {
    // A usable handle, never an error — this is the ONLY protection against
    // `runBus.complete` never firing (see `run-waiter.ts`'s header).
    return {
      ...base,
      status: 'running',
      next: `the review is still running — read it later with ${TOOL.getFindings} (repo="${repo.value.fullName}", pr=${pull.value.number}, run_id="${runId}")`,
    };
  }

  if (outcome === 'failed' || outcome === 'cancelled') {
    return {
      ...base,
      next:
        outcome === 'failed'
          ? `check the reviewer's provider key and model in the DevDigest web UI, then retry ${TOOL.runAgentOnPullRequest}`
          : `the run was cancelled — retry ${TOOL.runAgentOnPullRequest} when ready`,
    };
  }

  const reviews = await env.deps.reviewRunner.reviewsForPull(env.workspaceId, pull.value.id);
  const review = reviewForRun(reviews, runId);
  if (!review) {
    return {
      ...base,
      next: `the run finished but persisted no review — read the run in the DevDigest web UI, or retry ${TOOL.runAgentOnPullRequest}`,
    };
  }

  return {
    ...base,
    score: review.score ?? base.score,
    ...(review.verdict !== null ? { verdict: review.verdict } : {}),
    ...shapeFindings(review, { limit: FINDINGS_DEFAULT_LIMIT }),
  };
}

/** Same three passes as `matchAgentByName`, against an in-flight run's name. */
function sameName(actual: string | null, wanted: string): boolean {
  if (actual === null) return false;
  return actual === wanted || actual.trim().toLowerCase() === wanted.toLowerCase();
}

/**
 * `'done'` from the bus → what the run actually did.
 *
 * The bus carries no status, so `failed` / `cancelled` can only come from the
 * persisted row. A row that is missing or still `running` after the bus reported
 * done is treated as `done` — the review read that follows is what decides, and
 * it degrades to a `next` rather than a lie.
 */
function refineOutcome(waited: WaitOutcome, run: RunSummary | undefined): WaitOutcome {
  if (waited !== 'done') return waited;
  if (run?.status === 'failed') return 'failed';
  if (run?.status === 'cancelled') return 'cancelled';
  return 'done';
}
