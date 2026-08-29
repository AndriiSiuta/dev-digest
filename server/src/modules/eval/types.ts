import { z } from 'zod';
import { Finding } from '@devdigest/shared';
import type {
  EvalBatchDetail,
  EvalBatchSummary,
  EvalCase,
  EvalDashboardView,
} from '@devdigest/shared';
import type { PinoLike } from '../../platform/run-logger.js';

/**
 * eval — the module's published surface.
 *
 * `EvalFacade` is the port callers outside the module reach through
 * `container.eval`; tests inject a double through `ContainerOverrides.eval`.
 * The two zod schemas below are MODULE-INTERNAL row payloads, not wire
 * contracts: on the wire `actual_output` / `input_meta` stay `z.unknown()`
 * inside the shared contracts, and the repository parses them at its boundary
 * so garbage in a row fails loudly rather than as a malformed response.
 */

export interface EvalFacade {
  /** One-click case from a decided finding (AC-01..08). */
  createCaseFromFinding(workspaceId: string, findingId: string): Promise<EvalCase>;
  listCases(workspaceId: string, agentId: string): Promise<EvalCase[]>;
  deleteCase(workspaceId: string, caseId: string): Promise<void>;
  /**
   * Run the agent's whole case set synchronously — one model call per case,
   * zero LLM calls for scoring.
   *
   * `logger` is REQUIRED, not optional: AC-NF-07 is a SHALL ("emit one
   * structured line per batch"), and an optional logger some caller omits is
   * the silent observability hole that bit the intent classifier
   * (`server/INSIGHTS.md`, 2026-08-14). The route has `req.log` in hand and no
   * other caller exists.
   */
  runBatch(
    workspaceId: string,
    agentId: string,
    opts: { logger: PinoLike; correlationId?: string },
  ): Promise<EvalBatchDetail>;
  listBatches(workspaceId: string, agentId: string): Promise<EvalBatchSummary[]>;
  getBatch(workspaceId: string, agentId: string, batchId: string): Promise<EvalBatchDetail>;
  dashboard(workspaceId: string): Promise<EvalDashboardView>;
}

/**
 * The payload written into `eval_runs.actual_output` — the per-row facts the
 * batch aggregates are derived from (there is no batch table). `error` is null
 * when the case executed and the failure message when it errored; an errored
 * outcome is excluded from every metric denominator (AC-27).
 */
export const EvalCaseOutcome = z.object({
  model: z.string(),
  expectation_kind: z.enum(['must_find', 'must_not_flag']),
  /** Findings the model proposed (surviving + grounding-dropped). */
  proposed: z.number().int(),
  /** Findings that survived the grounding gate. */
  surviving: z.number().int(),
  /** Surviving findings matching a must_not_flag case's own expectation. */
  noise: z.number().int(),
  /** Whether any surviving finding matched the case's expectation region. */
  matched: z.boolean(),
  error: z.string().nullable(),
  findings: z.array(Finding),
});
export type EvalCaseOutcome = z.infer<typeof EvalCaseOutcome>;

/** The payload written into `eval_cases.input_meta` at case creation (AC-03). */
export const EvalCaseMeta = z.object({
  pr_title: z.string(),
  pr_body: z.string().nullable(),
  repo: z.string(),
  pr_number: z.number().int(),
  source_finding_id: z.string(),
});
export type EvalCaseMeta = z.infer<typeof EvalCaseMeta>;
