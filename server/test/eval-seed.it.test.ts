/**
 * Seed path for the eval pipeline (AC-39) — DB-backed. Runs `seed()` TWICE on
 * a fresh testcontainer: the Security Reviewer must own ≥ 8 cases, both
 * expectation kinds must be present, every frozen fragment must parse into a
 * groundable diff, and the second run must insert nothing (idempotent).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { EvalExpectation } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { DEFAULT_WORKSPACE_NAME, seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { caseDiff } from '../src/modules/eval/helpers.js';
import { EvalCaseMeta } from '../src/modules/eval/types.js';
import { EVAL_SEED_CASE_COUNT } from '../src/modules/eval/constants.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

d('eval seed (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let firstRunCount: number;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db
      .select()
      .from(t.workspaces)
      .where(eq(t.workspaces.name, DEFAULT_WORKSPACE_NAME));
    workspaceId = ws!.id;
    firstRunCount = (await allCases()).length;
    await seed(pg.handle.db); // the idempotency probe
  });
  afterAll(async () => {
    await pg?.stop();
  });

  const allCases = () =>
    pg.handle.db.select().from(t.evalCases).where(eq(t.evalCases.workspaceId, workspaceId));

  it('seeds ≥ 8 cases owned by the Security Reviewer, both kinds present', async () => {
    const [agent] = await pg.handle.db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, 'Security Reviewer')));
    expect(agent).toBeDefined();

    const cases = await allCases();
    expect(cases.length).toBeGreaterThanOrEqual(EVAL_SEED_CASE_COUNT);
    expect(cases.every((c) => c.ownerKind === 'agent' && c.ownerId === agent!.id)).toBe(true);

    const kinds = new Set(
      cases.map((c) => EvalExpectation.parse(c.expectedOutput).kind),
    );
    expect(kinds).toEqual(new Set(['must_find', 'must_not_flag']));
  });

  it('every expectation parses and points inside its parseable fragment', async () => {
    for (const c of await allCases()) {
      const exp = EvalExpectation.parse(c.expectedOutput);
      EvalCaseMeta.parse(c.inputMeta);

      const diff = caseDiff(exp.file, c.inputDiff ?? '');
      expect(diff.files, c.name).toHaveLength(1);
      expect(diff.files[0]!.hunks.length, c.name).toBeGreaterThanOrEqual(1);

      // The expectation range cites real new-side lines of the fragment — the
      // groundability constraint the whole scoring rests on.
      const covered = new Set(diff.files[0]!.hunks.flatMap((h) => h.newLineNumbers));
      let overlaps = false;
      for (let n = exp.start_line; n <= exp.end_line; n += 1) {
        if (covered.has(n)) overlaps = true;
      }
      expect(overlaps, `${c.name}: ${exp.start_line}-${exp.end_line}`).toBe(true);
    }
  });

  it('a second seed run inserts nothing (idempotent)', async () => {
    const cases = await allCases();
    expect(cases.length).toBe(firstRunCount);
    // The markers are what idempotency keys on — all distinct.
    const markers = cases.map(
      (c) => (c.inputMeta as { source_finding_id: string }).source_finding_id,
    );
    expect(new Set(markers).size).toBe(markers.length);
  });
});
