/**
 * PR Brief — DB-backed integration. What is REAL here is the route, the
 * container wiring, `BriefRepository`, `pr_brief` and its `ON DELETE CASCADE`.
 * The model, the blast panel, the Smart Diff classification and the document
 * store are injected.
 *
 * EVERY provider id is overridden, not just the one `risk_brief` resolves to:
 * a container-resolved feature call otherwise falls through to a REAL adapter
 * on any machine holding keys in `~/.devdigest/secrets.json`, and the test
 * silently burns money (`server/INSIGHTS.md`, *Recurring Errors & Fixes*,
 * 2026-08-14).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { PrBriefRecord, type BlastPanel, type SmartDiffResponse } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { DEFAULT_WORKSPACE_NAME, seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockLLMProvider, MockProjectContextDocs } from '../src/adapters/mocks.js';
import { BRIEF_SCHEMA_NAME } from '../src/modules/brief/constants.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/** Grounded against the PR's changed paths below — nothing invented. */
const DRAFT = {
  what: 'Adds an idempotency key to order creation.',
  why: 'Retries were double-charging customers.',
  risks: [
    {
      kind: 'regression',
      title: 'Retry path is not idempotent',
      explanation: 'A second attempt can create a second order.',
      file_refs: ['src/orders.ts'],
      endpoint_refs: [],
      severity: 'medium',
    },
  ],
  review_focus: [{ file: 'src/orders.ts', line: 12, reason: 'new idempotency key handling' }],
  risk_level: 'low',
};

const EMPTY_BLAST = (headSha: string): BlastPanel => ({
  blast: { changed_symbols: [], downstream: [], summary: 'No indexed symbols changed.' },
  history: { history: [] },
  degraded: false,
  head_sha: headSha,
});

const EMPTY_SMART_DIFF: SmartDiffResponse = {
  groups: [],
  split_suggestion: { too_big: false, total_lines: 0, proposed_splits: [] },
};

d('brief (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let llm: MockLLMProvider;
  let contextDocs: MockProjectContextDocs;

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

  /**
   * One app per test. The document store is created HERE and handed to the
   * container, so the test owns the instance it later mutates: the container
   * getter memoizes the override for the app's lifetime, so re-instantiating
   * the mock would change nothing (AC-41).
   */
  function appWith(headSha = 'sha-head') {
    llm = new MockLLMProvider('openai', { structuredBySchema: { [BRIEF_SCHEMA_NAME]: DRAFT } });
    contextDocs = new MockProjectContextDocs({ 'specs/orders.md': 'Orders are idempotent.' });
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        // All three ids point at the same mock, so `llm.calls` is the single
        // ledger of every paid call this feature could have made.
        llm: { openai: llm, anthropic: llm, openrouter: llm },
        blast: { get: async () => EMPTY_BLAST(headSha) },
        smartDiff: { get: async () => EMPTY_SMART_DIFF },
        projectContextDocs: contextDocs,
      },
    });
  }

  const structuredCalls = () =>
    llm.calls.filter(
      (c) =>
        c.method === 'completeStructured' &&
        (c.req as { schemaName: string }).schemaName === BRIEF_SCHEMA_NAME,
    ).length;

  let seq = 0;
  async function makePr(over: { workspaceId?: string; headSha?: string; paths?: string[] } = {}) {
    const db = pg.handle.db;
    const ws = over.workspaceId ?? workspaceId;
    const n = 700 + seq++;
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId: ws, owner: 'acme', name: `brief-${n}`, fullName: `acme/brief-${n}` })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId: ws,
        repoId: repo!.id,
        number: n,
        title: 'Make order creation idempotent',
        author: 'octocat',
        branch: `feat/${n}`,
        base: 'main',
        headSha: over.headSha ?? 'sha-head',
        status: 'open',
        body: 'Adds an idempotency key to the retry path.',
      })
      .returning();
    const paths = over.paths ?? ['src/orders.ts', 'src/retry.ts'];
    await db
      .insert(t.prFiles)
      .values(paths.map((path) => ({ prId: pr!.id, path, additions: 3, deletions: 1 })));
    return pr!;
  }

  const rowsFor = (prId: string) =>
    pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));

  it('POST persists exactly one pr_brief row for the PR (AC-10)', async () => {
    const app = await appWith();
    const pr = await makePr();

    const res = await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    expect(res.statusCode).toBe(200);
    const record = PrBriefRecord.parse(res.json());
    expect(record.brief.what).toBe(DRAFT.what);
    expect(record.brief.risks).toHaveLength(1);

    const rows = await rowsFor(pr.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('gpt-4.1');
    await app.close();
  });

  it('stores head_sha as a queryable column, not a jsonb path (AC-43)', async () => {
    const app = await appWith();
    const pr = await makePr();
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });

    // The whole point of the column: a WHERE on head_sha, not a jsonb lookup.
    const hit = await pg.handle.db
      .select()
      .from(t.prBrief)
      .where(and(eq(t.prBrief.prId, pr.id), eq(t.prBrief.headSha, pr.headSha)));
    expect(hit).toHaveLength(1);
    expect(hit[0]!.generatedAt).toBeInstanceOf(Date);
    // The payload does NOT carry the provenance the columns hold.
    expect(Object.keys(hit[0]!.json as object)).not.toContain('head_sha');
    await app.close();
  });

  it('three regenerations across two head SHAs leave one row (AC-42)', async () => {
    const app = await appWith();
    const pr = await makePr();

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief?force=true` });
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief?force=true` });
    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'sha-head-2' })
      .where(eq(t.pullRequests.id, pr.id));
    const last = await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief?force=true` });
    expect(last.statusCode).toBe(200);

    const rows = await rowsFor(pr.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.headSha).toBe('sha-head-2');
    await app.close();
  });

  it('two concurrent forced regenerations: one row, exactly two model calls, both fresh (AC-25)', async () => {
    const app = await appWith();
    const pr = await makePr();

    // Seed the row, then age it, so "not served from cache" is checkable
    // rather than vacuous.
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const aged = new Date('2020-01-01T00:00:00.000Z');
    await pg.handle.db
      .update(t.prBrief)
      .set({ generatedAt: aged })
      .where(eq(t.prBrief.prId, pr.id));
    const callsBefore = structuredCalls();

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief?force=true` }),
      app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief?force=true` }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    // EXACTLY two, not "at most two": "at most" also passes at 0 or 1 and would
    // silently accept a deadlock or a swallowed request. AC-25's "no more than
    // the model calls those requests were each charged for" is an upper bound
    // on a number that has to be pinned from below first.
    expect(structuredCalls() - callsBefore).toBe(2);

    const recA = PrBriefRecord.parse(a.json());
    const recB = PrBriefRecord.parse(b.json());
    expect(Date.parse(recA.generated_at)).toBeGreaterThan(aged.getTime());
    expect(Date.parse(recB.generated_at)).toBeGreaterThan(aged.getTime());
    // Neither payload is a mix of the two writes.
    expect(recA.brief).toEqual(recB.brief);
    expect(recA.brief.what).toBe(DRAFT.what);

    expect(await rowsFor(pr.id)).toHaveLength(1);
    await app.close();
  });

  it('deleting the pull request removes its brief (AC-27)', async () => {
    const app = await appWith();
    const pr = await makePr();
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    expect(await rowsFor(pr.id)).toHaveLength(1);

    await pg.handle.db.delete(t.pullRequests).where(eq(t.pullRequests.id, pr.id));
    expect(await rowsFor(pr.id)).toHaveLength(0);
    await app.close();
  });

  it('stays current at an unchanged head SHA across a new intent, changed documents and a new review (AC-41)', async () => {
    const app = await appWith();
    const pr = await makePr();

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const first = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/brief` });
    expect(first.statusCode).toBe(200);
    const callsAfterGenerate = structuredCalls();

    // 1. Re-classify the intent.
    await pg.handle.db.insert(t.prIntent).values({
      prId: pr.id,
      intent: 'Reclassified after the brief was generated.',
      inScope: ['src/orders.ts'],
      outOfScope: [],
      riskAreas: ['payments'],
      confidence: 0.9,
      sources: [],
      model: 'gpt-4.1',
      headSha: pr.headSha,
    });

    // 2. Change the project-context documents. The mock instance is the one the
    //    container already memoized, so mutating IT is what the container sees.
    contextDocs.set('specs/orders.md', 'Rewritten after the brief was generated.');
    contextDocs.set('specs/extra.md', 'A document that did not exist before.');

    // 3. Add a review + a finding.
    const [review] = await pg.handle.db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId: pr.id,
        agentId: null,
        runId: null,
        kind: 'review',
        verdict: 'comment',
        summary: 'A review that must not invalidate the brief.',
        score: 80,
        model: 'gpt-4.1',
      })
      .returning();
    await pg.handle.db.insert(t.findings).values({
      reviewId: review!.id,
      file: 'src/orders.ts',
      startLine: 12,
      endLine: 12,
      severity: 'WARNING',
      category: 'bug',
      title: 'Something',
      rationale: 'Because.',
      suggestion: null,
      confidence: 0.8,
    });

    const second = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/brief` });
    expect(second.statusCode).toBe(200);
    const record = PrBriefRecord.parse(second.json());
    expect(record.head_sha).toBe(record.pr_head_sha);
    // Byte-identical: nothing above is an invalidator, and a GET never
    // regenerates.
    expect(second.body).toBe(first.body);
    expect(structuredCalls()).toBe(callsAfterGenerate);
    await app.close();
  });

  it('404s a GET and a POST for a PR in another workspace (AC-NF-01)', async () => {
    const app = await appWith();
    const [other] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: `other-${seq}` })
      .returning();
    const pr = await makePr({ workspaceId: other!.id });

    const get = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/brief` });
    expect(get.statusCode).toBe(404);
    expect(get.json()).toMatchObject({ error: { code: 'not_found' } });

    const post = await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toMatchObject({ error: { code: 'not_found' } });
    // A cross-workspace request never reaches the model, and writes nothing.
    expect(structuredCalls()).toBe(0);
    expect(await rowsFor(pr.id)).toHaveLength(0);
    await app.close();
  });
});
