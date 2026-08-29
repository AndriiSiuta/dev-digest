/**
 * Eval pipeline — DB-backed integration. What is REAL here is the routes, the
 * container wiring, `EvalRepository`, the two new `eval_runs` columns, the
 * indexes and the `ON DELETE CASCADE` from `eval_cases` (AC-09, AC-14,
 * AC-NF-01). The model is injected.
 *
 * EVERY provider id is overridden, not just the agent's: a container-resolved
 * call otherwise falls through to a REAL adapter on any machine holding keys
 * in `~/.devdigest/secrets.json` (`server/INSIGHTS.md`, 2026-08-14).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { EvalBatchDetail, EvalCase } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { DEFAULT_WORKSPACE_NAME, seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockAuthProvider, MockLLMProvider } from '../src/adapters/mocks.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const FIXTURE_PATCH =
  '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_it",\n   redisUrl: x,';

/** Cites new-side line 11 of the fixture patch — survives grounding. */
const REVIEW_FIXTURE = {
  verdict: 'request_changes',
  summary: 'One blocker.',
  score: 60,
  findings: [
    {
      id: 'f1',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded key',
      file: 'src/config.ts',
      start_line: 11,
      end_line: 11,
      rationale: 'Line 11 contains a literal key.',
      suggestion: null,
      confidence: 0.9,
    },
  ],
};

d('eval (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let llm: MockLLMProvider;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db
      .select()
      .from(t.workspaces)
      .where(eq(t.workspaces.name, DEFAULT_WORKSPACE_NAME));
    workspaceId = ws!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function appWith(workspace: { id: string; name: string }) {
    llm = new MockLLMProvider('openai', { structuredBySchema: { Review: REVIEW_FIXTURE } });
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        auth: new MockAuthProvider({ id: 'u1', email: 'you@local', name: 'You' }, workspace),
        // All three ids point at the same mock — the single ledger of every
        // paid call this feature could have made.
        llm: { openai: llm, anthropic: llm, openrouter: llm },
      },
    });
  }

  let seq = 0;
  /** A dedicated agent + PR + accepted finding per test, fully isolated. */
  async function makeFixture(over: { workspaceId?: string } = {}) {
    const db = pg.handle.db;
    const ws = over.workspaceId ?? workspaceId;
    const n = 800 + seq++;
    const [agent] = await db
      .insert(t.agents)
      .values({
        workspaceId: ws,
        name: `Eval Fixture Agent ${n}`,
        description: '',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash',
        systemPrompt: 'You are a careful reviewer.',
        enabled: true,
        version: 4,
      })
      .returning();
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId: ws, owner: 'acme', name: `eval-${n}`, fullName: `acme/eval-${n}` })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId: ws,
        repoId: repo!.id,
        number: n,
        title: 'Add config',
        author: 'octocat',
        branch: `feat/${n}`,
        base: 'main',
        headSha: 'sha-head',
        status: 'open',
        body: 'Adds a config value.',
      })
      .returning();
    await db
      .insert(t.prFiles)
      .values([{ prId: pr!.id, path: 'src/config.ts', additions: 1, deletions: 0, patch: FIXTURE_PATCH }]);
    const [review] = await db
      .insert(t.reviews)
      .values({
        workspaceId: ws,
        prId: pr!.id,
        agentId: agent!.id,
        kind: 'review',
        verdict: 'request_changes',
        summary: 's',
        score: 60,
        model: 'seed',
      })
      .returning();
    const [finding] = await db
      .insert(t.findings)
      .values({
        reviewId: review!.id,
        file: 'src/config.ts',
        startLine: 11,
        endLine: 11,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded key',
        rationale: 'because',
        suggestion: null,
        confidence: 0.9,
        acceptedAt: new Date(),
      })
      .returning();
    return { agent: agent!, pr: pr!, finding: finding! };
  }

  it('POST /findings/:id/eval-case persists one row with the verbatim patch (AC-03)', async () => {
    const app = await appWith({ id: workspaceId, name: 'default' });
    const { finding, agent } = await makeFixture();

    const res = await app.inject({ method: 'POST', url: `/findings/${finding.id}/eval-case` });
    expect(res.statusCode).toBe(201);
    const created = EvalCase.parse(res.json());
    expect(created.owner_id).toBe(agent.id);

    const rows = await pg.handle.db
      .select()
      .from(t.evalCases)
      .where(eq(t.evalCases.id, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputDiff).toBe(FIXTURE_PATCH);
    await app.close();
  });

  it('DELETE /eval-cases/:id cascades the case\'s eval_runs rows away (AC-09)', async () => {
    const app = await appWith({ id: workspaceId, name: 'default' });
    const { finding, agent } = await makeFixture();

    const created = await app.inject({ method: 'POST', url: `/findings/${finding.id}/eval-case` });
    const caseId = created.json().id as string;

    const run = await app.inject({ method: 'POST', url: `/agents/${agent.id}/eval-runs` });
    expect(run.statusCode).toBe(200);
    const before = await pg.handle.db
      .select()
      .from(t.evalRuns)
      .where(eq(t.evalRuns.caseId, caseId));
    expect(before.length).toBeGreaterThan(0);

    const del = await app.inject({ method: 'DELETE', url: `/eval-cases/${caseId}` });
    expect(del.statusCode).toBe(200);
    const after = await pg.handle.db
      .select()
      .from(t.evalRuns)
      .where(eq(t.evalRuns.caseId, caseId));
    expect(after).toHaveLength(0);
    await app.close();
  });

  it('batch rows round-trip with batch_id and agent_version set (AC-14)', async () => {
    const app = await appWith({ id: workspaceId, name: 'default' });
    const { finding, agent } = await makeFixture();
    await app.inject({ method: 'POST', url: `/findings/${finding.id}/eval-case` });

    const res = await app.inject({ method: 'POST', url: `/agents/${agent.id}/eval-runs` });
    expect(res.statusCode).toBe(200);
    const detail = EvalBatchDetail.parse(res.json());
    expect(detail.cases_total).toBe(1);
    expect(detail.agent_version).toBe(4);

    const rows = await pg.handle.db
      .select()
      .from(t.evalRuns)
      .where(eq(t.evalRuns.batchId, detail.batch_id));
    expect(rows).toHaveLength(detail.cases_total);
    expect(rows.every((r) => r.agentVersion === 4)).toBe(true);

    // ... and the read routes serve it back.
    const history = await app.inject({ method: 'GET', url: `/agents/${agent.id}/eval-runs` });
    expect(history.json().some((b: { batch_id: string }) => b.batch_id === detail.batch_id)).toBe(
      true,
    );
    const one = await app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/eval-runs/${detail.batch_id}`,
    });
    expect(one.statusCode).toBe(200);
    expect(EvalBatchDetail.parse(one.json()).results).toHaveLength(1);
    await app.close();
  });

  it('a second workspace sees nothing of the first (AC-NF-01)', async () => {
    const app = await appWith({ id: workspaceId, name: 'default' });
    const { finding, agent } = await makeFixture();
    const created = await app.inject({ method: 'POST', url: `/findings/${finding.id}/eval-case` });
    const caseId = created.json().id as string;
    const batch = await app.inject({ method: 'POST', url: `/agents/${agent.id}/eval-runs` });
    const batchId = batch.json().batch_id as string;
    await app.close();

    const [other] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: `other-${seq}` })
      .returning();
    const foreign = await appWith({ id: other!.id, name: other!.name });
    const llmCallsBefore = llm.calls.length;

    // The case, the history, the batch detail and creation all 404.
    const del = await foreign.inject({ method: 'DELETE', url: `/eval-cases/${caseId}` });
    expect(del.statusCode).toBe(404);
    const history = await foreign.inject({ method: 'GET', url: `/agents/${agent.id}/eval-runs` });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual([]);
    const detail = await foreign.inject({
      method: 'GET',
      url: `/agents/${agent.id}/eval-runs/${batchId}`,
    });
    expect(detail.statusCode).toBe(404);
    const create = await foreign.inject({
      method: 'POST',
      url: `/findings/${finding.id}/eval-case`,
    });
    expect(create.statusCode).toBe(404);

    // Its dashboard is empty, and nothing above reached a model.
    const dash = await foreign.inject({ method: 'GET', url: '/eval/dashboard' });
    expect(dash.statusCode).toBe(200);
    expect(dash.json()).toEqual({ cases_total: 0, recent: [] });
    expect(llm.calls.length).toBe(llmCallsBefore);
    await foreign.close();
  });
});
