import { and, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import { EvalCaseOutcome } from './types.js';
import type { EvalCaseMeta } from './types.js';
import type { EvalExpectation, EvalOwnerKind } from '@devdigest/shared';

/**
 * eval data-access — the ONLY layer touching `eval_cases` / `eval_runs`.
 *
 * Workspace scoping always rides the `eval_cases.workspace_id` join
 * (`eval_runs` carries no workspace column of its own — AC-NF-01), and the
 * jsonb payloads are parsed HERE so a corrupt row fails loudly as a parse
 * error rather than surfacing as a malformed response. Drizzle row types stop
 * at this boundary.
 */

export type EvalCaseRow = typeof t.evalCases.$inferSelect;

export interface InsertEvalCase {
  workspaceId: string;
  ownerKind: EvalOwnerKind;
  ownerId: string;
  name: string;
  /** The verbatim `pr_files.patch` fragment (AC-03). */
  inputDiff: string;
  inputFiles: unknown;
  inputMeta: EvalCaseMeta;
  expectedOutput: EvalExpectation;
}

export interface InsertEvalRun {
  caseId: string;
  batchId: string;
  agentVersion: number | null;
  pass: boolean | null;
  citationAccuracy: number | null;
  durationMs: number | null;
  costUsd: number | null;
  actualOutput: EvalCaseOutcome;
}

/** One result row, joined with its case, `actual_output` already parsed. */
export interface EvalRunRow {
  id: string;
  caseId: string;
  caseName: string;
  /** The case's owner (the agent) — lets the service enforce agent scoping. */
  ownerId: string;
  batchId: string;
  agentVersion: number | null;
  ranAt: Date;
  pass: boolean | null;
  citationAccuracy: number | null;
  durationMs: number | null;
  costUsd: number | null;
  outcome: EvalCaseOutcome;
}

/** A dashboard row — joined onward to `agents` for the display name. */
export interface EvalRecentRunRow extends EvalRunRow {
  agentName: string;
}

export class EvalRepository {
  constructor(private db: Db) {}

  // ---- cases ---------------------------------------------------------------

  async insertCase(values: InsertEvalCase): Promise<EvalCaseRow> {
    const [row] = await this.db
      .insert(t.evalCases)
      .values({
        workspaceId: values.workspaceId,
        ownerKind: values.ownerKind,
        ownerId: values.ownerId,
        name: values.name,
        inputDiff: values.inputDiff,
        inputFiles: values.inputFiles as object,
        inputMeta: values.inputMeta,
        expectedOutput: values.expectedOutput,
      })
      .returning();
    return row!;
  }

  async listCases(
    workspaceId: string,
    ownerKind: EvalOwnerKind,
    ownerId: string,
  ): Promise<EvalCaseRow[]> {
    return this.db
      .select()
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, ownerKind),
          eq(t.evalCases.ownerId, ownerId),
        ),
      )
      .orderBy(t.evalCases.name);
  }

  async getCase(workspaceId: string, caseId: string): Promise<EvalCaseRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, caseId)));
    return row;
  }

  /** The duplicate check (AC-06): one case per source finding per workspace. */
  async findCaseBySourceFinding(
    workspaceId: string,
    findingId: string,
  ): Promise<EvalCaseRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          sql`${t.evalCases.inputMeta}->>'source_finding_id' = ${findingId}`,
        ),
      );
    return row;
  }

  /** Plain delete — `eval_runs.case_id ON DELETE CASCADE` removes results (AC-09). */
  async deleteCase(caseId: string): Promise<void> {
    await this.db.delete(t.evalCases).where(eq(t.evalCases.id, caseId));
  }

  async countCases(workspaceId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(t.evalCases)
      .where(eq(t.evalCases.workspaceId, workspaceId));
    return row?.n ?? 0;
  }

  // ---- runs ----------------------------------------------------------------

  /**
   * One row per completed/errored case, written AS EACH CASE FINISHES — never
   * batched at the end. The write-as-you-go design is what AC-NF-11 rests on:
   * a crash mid-batch leaves the completed rows in place, no reaper needed.
   */
  async insertRun(values: InsertEvalRun): Promise<void> {
    await this.db.insert(t.evalRuns).values({
      caseId: values.caseId,
      batchId: values.batchId,
      agentVersion: values.agentVersion,
      pass: values.pass,
      citationAccuracy: values.citationAccuracy,
      durationMs: values.durationMs,
      costUsd: values.costUsd,
      actualOutput: values.actualOutput,
    });
  }

  async runsForBatch(workspaceId: string, batchId: string): Promise<EvalRunRow[]> {
    const rows = await this.db
      .select({ run: t.evalRuns, kase: t.evalCases })
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalRuns.caseId, t.evalCases.id))
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalRuns.batchId, batchId)))
      .orderBy(t.evalRuns.ranAt);
    return rows.map((r) => toRunRow(r.run, r.kase));
  }

  async runsForAgent(workspaceId: string, agentId: string): Promise<EvalRunRow[]> {
    const rows = await this.db
      .select({ run: t.evalRuns, kase: t.evalCases })
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalRuns.caseId, t.evalCases.id))
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, 'agent'),
          eq(t.evalCases.ownerId, agentId),
        ),
      )
      .orderBy(desc(t.evalRuns.ranAt));
    return rows.map((r) => toRunRow(r.run, r.kase));
  }

  /** Rows of the `cap` most recent batches across all agents, newest first. */
  async recentRuns(workspaceId: string, cap: number): Promise<EvalRecentRunRow[]> {
    const recentBatches = await this.db
      .select({ batchId: t.evalRuns.batchId, latest: max(t.evalRuns.ranAt) })
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalRuns.caseId, t.evalCases.id))
      .where(eq(t.evalCases.workspaceId, workspaceId))
      .groupBy(t.evalRuns.batchId)
      .orderBy(desc(max(t.evalRuns.ranAt)))
      .limit(cap);
    if (recentBatches.length === 0) return [];

    const rows = await this.db
      .select({ run: t.evalRuns, kase: t.evalCases, agentName: t.agents.name })
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalRuns.caseId, t.evalCases.id))
      .innerJoin(t.agents, eq(t.evalCases.ownerId, t.agents.id))
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, 'agent'),
          inArray(
            t.evalRuns.batchId,
            recentBatches.map((b) => b.batchId),
          ),
        ),
      )
      .orderBy(desc(t.evalRuns.ranAt));
    return rows.map((r) => ({ ...toRunRow(r.run, r.kase), agentName: r.agentName }));
  }
}

function toRunRow(run: typeof t.evalRuns.$inferSelect, kase: EvalCaseRow): EvalRunRow {
  return {
    id: run.id,
    caseId: run.caseId,
    caseName: kase.name,
    ownerId: kase.ownerId,
    batchId: run.batchId,
    agentVersion: run.agentVersion,
    ranAt: run.ranAt,
    pass: run.pass,
    citationAccuracy: run.citationAccuracy,
    durationMs: run.durationMs,
    costUsd: run.costUsd,
    outcome: EvalCaseOutcome.parse(run.actualOutput),
  };
}
