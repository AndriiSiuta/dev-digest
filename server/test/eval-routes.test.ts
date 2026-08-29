/**
 * eval routes — the transport ring only, hermetic. The facade is a fake, so
 * what is under test here is registration, validation, the response allowlist
 * (AC-NF-03), the error envelope (AC-13's outcome signals) and the per-route
 * rate limit (AC-NF-02).
 *
 * `MockAuthProvider` is required: `LocalNoAuthProvider` resolves the workspace
 * out of the database, which these tests do not have.
 */
import { describe, it, expect } from 'vitest';
import { EvalBatchDetail, EvalCase, EvalDashboardView, type EvalRunRecord } from '@devdigest/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { MockAuthProvider } from '../src/adapters/mocks.js';
import { AppError, NotFoundError } from '../src/platform/errors.js';
import type { EvalFacade } from '../src/modules/eval/types.js';

const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const AGENT_ID = '00000000-0000-4000-8000-000000000004';
const FINDING_ID = '00000000-0000-4000-8000-000000000006';
const CASE_ID = '00000000-0000-4000-8000-00000000c001';
const BATCH_ID = '00000000-0000-4000-8000-00000000b001';

const CASE: EvalCase = {
  id: CASE_ID,
  owner_kind: 'agent',
  owner_id: AGENT_ID,
  name: 'Hardcoded key',
  input_diff: '@@ -10,3 +10,4 @@\n+  key',
  input_files: ['src/config.ts'],
  input_meta: { pr_title: 't', pr_body: null, repo: 'a/b', pr_number: 1, source_finding_id: FINDING_ID },
  expected_output: { kind: 'must_find', file: 'src/config.ts', start_line: 11, end_line: 11 },
  notes: null,
};

const RUN: EvalRunRecord = {
  id: 'r1',
  case_id: CASE_ID,
  case_name: 'Hardcoded key',
  batch_id: BATCH_ID,
  agent_version: 3,
  ran_at: '2026-08-29T00:00:00.000Z',
  actual_output: { model: 'gpt-4.1' },
  pass: true,
  recall: null,
  precision: null,
  citation_accuracy: 1,
  duration_ms: 100,
  cost_usd: 0.001,
  error: null,
};

const DETAIL: EvalBatchDetail = {
  batch_id: BATCH_ID,
  agent_id: AGENT_ID,
  agent_version: 3,
  model: 'gpt-4.1',
  ran_at: '2026-08-29T00:00:00.000Z',
  cases_total: 1,
  cases_errored: 0,
  cases_passed: 1,
  recall: 1,
  precision: 1,
  citation_accuracy: 1,
  duration_ms: 100,
  cost_usd: 0.001,
  results: [RUN],
};

/** A facade whose every read leaks an extra field — the allowlist probe. */
function fakeFacade(overrides: Partial<EvalFacade> = {}): EvalFacade {
  return {
    createCaseFromFinding: async () => CASE,
    listCases: async () => [{ ...CASE, leaked_secret: 'sk_live_xxx' } as EvalCase],
    deleteCase: async () => undefined,
    runBatch: async () => DETAIL,
    listBatches: async () => [DETAIL],
    getBatch: async () => DETAIL,
    dashboard: async () => ({
      cases_total: 1,
      recent: [
        { ...DETAIL, agent_name: 'Security Reviewer', leaked_secret: 'sk_live_xxx' } as never,
      ],
    }),
    ...overrides,
  };
}

function appWith(facade: EvalFacade) {
  return buildApp({ config, overrides: { auth: new MockAuthProvider(), eval: facade } });
}

describe('eval routes', () => {
  it('POST /findings/:id/eval-case answers 201 with a parseable EvalCase', async () => {
    const app = await appWith(fakeFacade());
    const res = await app.inject({ method: 'POST', url: `/findings/${FINDING_ID}/eval-case` });
    expect(res.statusCode).toBe(201);
    expect(() => EvalCase.parse(res.json())).not.toThrow();
    await app.close();
  });

  it('surfaces eval_case_exists as a 409 envelope naming the existing case (AC-13)', async () => {
    const app = await appWith(
      fakeFacade({
        createCaseFromFinding: async () => {
          throw new AppError('eval_case_exists', 'An eval case already exists', 409, {
            existing_case_id: CASE_ID,
          });
        },
      }),
    );
    const res = await app.inject({ method: 'POST', url: `/findings/${FINDING_ID}/eval-case` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'eval_case_exists', details: { existing_case_id: CASE_ID } },
    });
    await app.close();
  });

  it('strips a facade-leaked field from the case list and the dashboard (AC-NF-03)', async () => {
    const app = await appWith(fakeFacade());

    const cases = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/eval-cases` });
    expect(cases.statusCode).toBe(200);
    expect(cases.body).not.toContain('leaked_secret');
    expect(cases.body).not.toContain('sk_live_xxx');
    expect(cases.json()[0]).toMatchObject({ id: CASE_ID });

    const dash = await app.inject({ method: 'GET', url: '/eval/dashboard' });
    expect(dash.statusCode).toBe(200);
    expect(dash.body).not.toContain('leaked_secret');
    expect(dash.body).not.toContain('sk_live_xxx');
    expect(() => EvalDashboardView.parse(dash.json())).not.toThrow();
    expect(dash.json().recent[0].agent_name).toBe('Security Reviewer');
    await app.close();
  });

  it('rejects an invalid uuid :id at the edge with a structured 422', async () => {
    const app = await appWith(fakeFacade());
    for (const [method, url] of [
      ['POST', '/findings/not-a-uuid/eval-case'],
      ['GET', '/agents/not-a-uuid/eval-cases'],
      ['DELETE', '/eval-cases/not-a-uuid'],
      ['POST', '/agents/not-a-uuid/eval-runs'],
      ['GET', `/agents/${AGENT_ID}/eval-runs/not-a-uuid`],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('validation_error');
    }
    await app.close();
  });

  it('maps a facade NotFoundError to a 404 envelope', async () => {
    const app = await appWith(
      fakeFacade({
        getBatch: async () => {
          throw new NotFoundError('Eval batch not found');
        },
        deleteCase: async () => {
          throw new NotFoundError('Eval case not found');
        },
      }),
    );
    const batch = await app.inject({
      method: 'GET',
      url: `/agents/${AGENT_ID}/eval-runs/${BATCH_ID}`,
    });
    expect(batch.statusCode).toBe(404);
    expect(batch.json()).toMatchObject({ error: { code: 'not_found' } });
    // The module is registered at all — not the router's own 404 shape.
    expect(batch.body).not.toContain('Route GET:');

    const del = await app.inject({ method: 'DELETE', url: `/eval-cases/${CASE_ID}` });
    expect(del.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE and the batch reads answer their promised shapes', async () => {
    const app = await appWith(fakeFacade());
    const del = await app.inject({ method: 'DELETE', url: `/eval-cases/${CASE_ID}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const run = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/eval-runs` });
    expect(run.statusCode).toBe(200);
    expect(() => EvalBatchDetail.parse(run.json())).not.toThrow();

    const history = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/eval-runs` });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toHaveLength(1);
    await app.close();
  });
});

/**
 * AC-NF-02 needs its own app: `app.ts` registers `@fastify/rate-limit` only
 * when `config.nodeEnv !== 'test'`, so the route's `config.rateLimit` is INERT
 * under the config every other test here uses. `LOG_LEVEL: 'silent'` keeps
 * `logger: false`, so no pino-pretty transport spins up for the development
 * build (`server/INSIGHTS.md`, 2026-08-29).
 */
describe('POST /agents/:id/eval-runs rate limit (AC-NF-02)', () => {
  it('429s the 4th trigger within the window', async () => {
    const devConfig = loadConfig({
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    const app = await buildApp({
      config: devConfig,
      overrides: { auth: new MockAuthProvider(), eval: fakeFacade() },
    });

    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/eval-runs` });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes[3]).toBe(429);
    await app.close();
  });
});
