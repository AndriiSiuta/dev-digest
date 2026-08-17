import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

let repoSeq = 0;
async function setupRepoAndPr(db: PgFixture['handle']['db'], workspaceId: string) {
  const name = `smart-diff-${repoSeq++}`;
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
    .returning();
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId: repo!.id,
      number: 900 + repoSeq,
      title: 'Add rate limiting',
      author: 'marisa.koch',
      branch: 'feat/rl',
      base: 'main',
      headSha: 'a1b2c3d4',
      additions: 3,
      deletions: 0,
      filesCount: 3,
      status: 'needs_review',
    })
    .returning();
  await db.insert(t.prFiles).values([
    { prId: pr!.id, path: 'src/core.ts', additions: 5, deletions: 1, patch: null },
    { prId: pr!.id, path: 'src/core.config.ts', additions: 2, deletions: 0, patch: null },
    { prId: pr!.id, path: 'pnpm-lock.yaml', additions: 400, deletions: 0, patch: null },
  ]);
  return { repo: repo!, pr: pr! };
}

d('smart-diff (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let mockLlm: MockLLMProvider;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function appWith() {
    mockLlm = new MockLLMProvider('openai', {});
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: { llm: { openai: mockLlm } },
    });
  }

  it('before any review: three groups always present, lock-file in boilerplate, all finding_lines empty', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/smart-diff` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.groups.map((g: { role: string }) => g.role)).toEqual([
      'core',
      'wiring',
      'boilerplate',
    ]);
    const core = body.groups.find((g: { role: string }) => g.role === 'core');
    const wiring = body.groups.find((g: { role: string }) => g.role === 'wiring');
    const boilerplate = body.groups.find((g: { role: string }) => g.role === 'boilerplate');
    expect(core.files.map((f: { path: string }) => f.path)).toEqual(['src/core.ts']);
    expect(wiring.files.map((f: { path: string }) => f.path)).toEqual(['src/core.config.ts']);
    expect(boilerplate.files.map((f: { path: string }) => f.path)).toEqual(['pnpm-lock.yaml']);
    for (const g of body.groups) {
      for (const f of g.files) {
        expect(f.finding_lines).toEqual([]);
        expect(f.findings).toEqual([]);
      }
    }

    expect(mockLlm.calls).toEqual([]);
    await app.close();
  });

  it('overlays only the latest review per agent, with correct severity and finding_lines', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    // agentA: two reviews (only the newer one — score 2 findings — should surface).
    const [agentAOld] = await pg.handle.db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId: pr.id,
        agentId: null, // stand-in "agent" bucket #1 (agentId nullable in this schema)
        runId: null,
        kind: 'review',
        verdict: 'comment',
        summary: 'old',
        score: 90,
        model: 'gpt-4.1',
      })
      .returning();
    await pg.handle.db.insert(t.findings).values({
      reviewId: agentAOld!.id,
      file: 'src/core.ts',
      startLine: 1,
      endLine: 1,
      severity: 'CRITICAL',
      category: 'bug',
      title: 'Superseded finding — must not appear',
      rationale: 'r',
      confidence: 0.9,
    });

    // Small delay so createdAt orders deterministically newest-first.
    await new Promise((r) => setTimeout(r, 10));

    const [agentANew] = await pg.handle.db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId: pr.id,
        agentId: null,
        runId: null,
        kind: 'review',
        verdict: 'request_changes',
        summary: 'new',
        score: 60,
        model: 'gpt-4.1',
      })
      .returning();
    await pg.handle.db.insert(t.findings).values([
      {
        reviewId: agentANew!.id,
        file: 'src/core.ts',
        startLine: 4,
        endLine: 4,
        severity: 'WARNING',
        category: 'bug',
        title: 'Latest warning',
        rationale: 'r',
        confidence: 0.8,
      },
      {
        reviewId: agentANew!.id,
        file: 'src/core.ts',
        startLine: 9,
        endLine: 9,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Latest critical',
        rationale: 'r',
        confidence: 0.95,
      },
    ]);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/smart-diff` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const core = body.groups.find((g: { role: string }) => g.role === 'core');
    const file = core.files.find((f: { path: string }) => f.path === 'src/core.ts');

    expect(file.finding_lines).toEqual([4, 9]);
    expect(file.findings).toHaveLength(2);
    const titles = file.findings.map((f: { title: string }) => f.title);
    expect(titles).not.toContain('Superseded finding — must not appear');
    expect(titles.sort()).toEqual(['Latest critical', 'Latest warning']);

    expect(mockLlm.calls).toEqual([]);
    await app.close();
  });

  it('404 on an unknown (but valid) PR id, 422 on a malformed id', async () => {
    const app = await appWith();

    const missing = await app.inject({ method: 'GET', url: `/pulls/${randomUUID()}/smart-diff` });
    expect(missing.statusCode).toBe(404);

    const malformed = await app.inject({ method: 'GET', url: '/pulls/not-a-uuid/smart-diff' });
    expect(malformed.statusCode).toBe(422);

    expect(mockLlm.calls).toEqual([]);
    await app.close();
  });
});
