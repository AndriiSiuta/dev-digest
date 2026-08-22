import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { BlastPanel } from '@devdigest/shared';
import type { BlastResult, RepoIntel } from '../src/modules/repo-intel/types.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/**
 * The facade is faked (deterministic, no cloned/indexed repo); what is REAL
 * here is the route, `pull_requests`/`pr_files`, and the overlap SQL.
 */
const FAKE_RESULT: BlastResult = {
  changedSymbols: [{ name: 'parse', file: 'src/parse.ts', kind: 'function' }],
  callers: [{ file: 'src/app.ts', symbol: 'boot', viaSymbol: 'parse', line: 5, rank: 1 }],
  impactedEndpoints: ['GET /parse'],
  factsByFile: { 'src/app.ts': { endpoints: ['GET /parse'], crons: [] } },
};

let repoSeq = 0;
async function makeRepo(db: PgFixture['handle']['db'], workspaceId: string) {
  const name = `blast-${repoSeq++}`;
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
    .returning();
  return repo!;
}

let prSeq = 0;
async function makePr(
  db: PgFixture['handle']['db'],
  workspaceId: string,
  repoId: string,
  over: { status?: string; updatedAt?: Date | null; paths: string[] },
) {
  const n = 500 + prSeq++;
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId,
      number: n,
      title: `PR ${n}`,
      author: 'octocat',
      branch: `feat/${n}`,
      base: 'main',
      headSha: `sha-${n}`,
      status: over.status ?? 'open',
      updatedAt: over.updatedAt ?? null,
    })
    .returning();
  if (over.paths.length > 0) {
    await db
      .insert(t.prFiles)
      .values(over.paths.map((path) => ({ prId: pr!.id, path, additions: 1, deletions: 0 })));
  }
  return pr!;
}

d('blast (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;

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
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        // Only the one facade method the blast route reads; cast because the
        // real RepoIntel interface carries the whole indexing surface too.
        repoIntel: { getBlastRadius: async () => FAKE_RESULT } as unknown as RepoIntel,
      },
    });
  }

  it('200 → BlastPanel parses, head_sha matches, nothing persisted', async () => {
    const app = await appWith();
    const repo = await makeRepo(pg.handle.db, workspaceId);
    const pr = await makePr(pg.handle.db, workspaceId, repo.id, {
      updatedAt: new Date('2026-08-15T00:00:00.000Z'),
      paths: ['src/parse.ts', 'src/app.ts'],
    });

    const prsBefore = (await pg.handle.db.select().from(t.pullRequests)).length;
    const filesBefore = (await pg.handle.db.select().from(t.prFiles)).length;
    const briefsBefore = (await pg.handle.db.select().from(t.prBrief)).length;

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/blast` });
    expect(res.statusCode).toBe(200);
    const panel = BlastPanel.parse(res.json());
    expect(panel.head_sha).toBe(pr.headSha);
    expect(panel.degraded).toBe(false);
    expect(panel.blast.downstream[0]?.symbol).toBe('parse');

    // Computed fresh — no table gained rows.
    expect((await pg.handle.db.select().from(t.pullRequests)).length).toBe(prsBefore);
    expect((await pg.handle.db.select().from(t.prFiles)).length).toBe(filesBefore);
    expect((await pg.handle.db.select().from(t.prBrief)).length).toBe(briefsBefore);
    await app.close();
  });

  it('404 on an unknown PR id via the shared error envelope', async () => {
    const app = await appWith();
    const res = await app.inject({ method: 'GET', url: `/pulls/${randomUUID()}/blast` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    await app.close();
  });

  it('overlap: same-repo sharing ≥1 path, self and other repos excluded, capped at 5, newest first with NULLs last', async () => {
    const app = await appWith();
    const db = pg.handle.db;
    const repo = await makeRepo(db, workspaceId);
    const target = await makePr(db, workspaceId, repo.id, {
      updatedAt: new Date('2026-08-15T00:00:00.000Z'),
      paths: ['src/parse.ts', 'src/app.ts'],
    });

    const at = (d: string) => new Date(d);
    // Four dated overlapping siblings (mixed status) + one with NULL updatedAt.
    const s1 = await makePr(db, workspaceId, repo.id, {
      status: 'merged',
      updatedAt: at('2026-08-14T00:00:00.000Z'),
      paths: ['src/parse.ts', 'src/unrelated.ts'],
    });
    const s2 = await makePr(db, workspaceId, repo.id, {
      status: 'open',
      updatedAt: at('2026-08-12T00:00:00.000Z'),
      paths: ['src/app.ts'],
    });
    const s3 = await makePr(db, workspaceId, repo.id, {
      status: 'closed',
      updatedAt: at('2026-08-10T00:00:00.000Z'),
      paths: ['src/parse.ts', 'src/app.ts'],
    });
    const s4 = await makePr(db, workspaceId, repo.id, {
      status: 'merged',
      updatedAt: at('2026-08-08T00:00:00.000Z'),
      paths: ['src/app.ts'],
    });
    const sNull = await makePr(db, workspaceId, repo.id, {
      status: 'open',
      updatedAt: null,
      paths: ['src/parse.ts'],
    });
    // Same repo, NO shared path — excluded.
    await makePr(db, workspaceId, repo.id, {
      updatedAt: at('2026-08-16T00:00:00.000Z'),
      paths: ['docs/README.md'],
    });
    // Different repo sharing a path — excluded.
    const otherRepo = await makeRepo(db, workspaceId);
    await makePr(db, workspaceId, otherRepo.id, {
      updatedAt: at('2026-08-16T00:00:00.000Z'),
      paths: ['src/parse.ts'],
    });

    const res1 = await app.inject({ method: 'GET', url: `/pulls/${target.id}/blast` });
    expect(res1.statusCode).toBe(200);
    const h1 = BlastPanel.parse(res1.json()).history.history;

    // Newest first by updatedAt, the NULL row last (`nulls last`, not floated to the top).
    expect(h1.map((r) => r.pr_number)).toEqual([
      s1.number,
      s2.number,
      s3.number,
      s4.number,
      sNull.number,
    ]);
    // Exactly the shared paths (array_agg distinct — order not asserted).
    expect([...h1[0]!.files_overlap].sort()).toEqual(['src/parse.ts']);
    expect([...h1[2]!.files_overlap].sort()).toEqual(['src/app.ts', 'src/parse.ts']);
    // merged_at derives from updatedAt for merged and non-merged rows alike; '' when NULL.
    expect(h1[0]!.merged_at).toBe('2026-08-14T00:00:00.000Z');
    expect(h1[1]!.merged_at).toBe('2026-08-12T00:00:00.000Z');
    expect(h1[4]!.merged_at).toBe('');

    // A sixth overlapping sibling → still 5 rows; the NULL row is what the cap drops.
    const s5 = await makePr(db, workspaceId, repo.id, {
      status: 'merged',
      updatedAt: at('2026-08-13T00:00:00.000Z'),
      paths: ['src/app.ts'],
    });
    const res2 = await app.inject({ method: 'GET', url: `/pulls/${target.id}/blast` });
    const h2 = BlastPanel.parse(res2.json()).history.history;
    expect(h2).toHaveLength(5);
    expect(h2.map((r) => r.pr_number)).toEqual([
      s1.number,
      s5.number,
      s2.number,
      s3.number,
      s4.number,
    ]);
    await app.close();
  });
});
