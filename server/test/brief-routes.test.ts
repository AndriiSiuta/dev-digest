/**
 * brief routes — the transport ring only, hermetic. The facade is a fake, so
 * what is under test here is registration, validation, the `force` querystring,
 * the 404 mapping and the response allowlist — never the service.
 *
 * `MockAuthProvider` is required: `LocalNoAuthProvider` resolves the workspace
 * out of the database, which these tests do not have.
 */
import { describe, it, expect } from 'vitest';
import { PrBriefRecord, type Brief } from '@devdigest/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { MockAuthProvider } from '../src/adapters/mocks.js';
import { NotFoundError } from '../src/platform/errors.js';
import type { BriefFacade } from '../src/modules/brief/types.js';
import type { PinoLike } from '../src/platform/run-logger.js';

const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const PR_ID = '00000000-0000-4000-8000-000000000003';

const BRIEF: Brief = {
  what: 'Adds an idempotency key to order creation.',
  why: 'Retries were double-charging customers.',
  risk_level: 'low',
  risks: [],
  review_focus: [{ file: 'src/orders.ts', line: 12, reason: 'new key handling' }],
  degraded: false,
  missing_inputs: [],
};

const RECORD = {
  pr_id: PR_ID,
  brief: BRIEF,
  head_sha: 'a1b2c3d4',
  pr_head_sha: 'e5f6a7b8',
  model: 'gpt-4.1',
  generated_at: '2026-08-29T00:00:00.000Z',
};

interface FakeFacadeOptions {
  /** What `get` resolves to; `undefined` is "no stored brief". */
  get?: unknown;
  /** Make `get` throw instead (the unknown-PR case). */
  getThrows?: Error;
  /** What `generate` resolves to. */
  generate?: unknown;
}

function fakeFacade(opts: FakeFacadeOptions = {}) {
  const generateCalls: { workspaceId: string; prId: string; force: boolean; hasLogger: boolean }[] =
    [];
  const facade = {
    async get(_workspaceId: string, _prId: string) {
      if (opts.getThrows) throw opts.getThrows;
      return opts.get as never;
    },
    async generate(
      workspaceId: string,
      prId: string,
      o: { force: boolean; logger: PinoLike; correlationId?: string },
    ) {
      generateCalls.push({
        workspaceId,
        prId,
        force: o.force,
        hasLogger: typeof o.logger?.info === 'function',
      });
      return (opts.generate ?? RECORD) as never;
    },
  } as unknown as BriefFacade;
  return { facade, generateCalls };
}

function appWith(facade: BriefFacade) {
  return buildApp({
    config,
    overrides: { auth: new MockAuthProvider(), brief: facade },
  });
}

describe('GET /pulls/:id/brief', () => {
  it('404s through the shared error envelope when no brief is stored (AC-39)', async () => {
    const { facade } = fakeFacade({ get: undefined });
    const app = await appWith(facade);
    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/brief` });
    expect(res.statusCode).toBe(404);
    // A handler's NotFoundError carries `error.code`; the router's own 404 does
    // not — only the first shape proves the module is registered at all.
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(res.body).not.toContain('Route GET:');
    await app.close();
  });

  it('404s when the PR does not exist in the workspace (AC-13)', async () => {
    const { facade } = fakeFacade({ getThrows: new NotFoundError('Pull request not found') });
    const app = await appWith(facade);
    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/brief` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    await app.close();
  });

  it('returns a PrBriefRecord carrying both head SHAs, with no regeneration (AC-01, AC-40)', async () => {
    const { facade, generateCalls } = fakeFacade({ get: RECORD });
    const app = await appWith(facade);
    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/brief` });
    expect(res.statusCode).toBe(200);
    const parsed = PrBriefRecord.parse(res.json());
    expect(parsed.head_sha).toBe('a1b2c3d4');
    expect(parsed.pr_head_sha).toBe('e5f6a7b8');
    expect(parsed.brief.what).toBe(BRIEF.what);
    // A stale stored brief is served as it stands — `generate` is not reached.
    expect(generateCalls).toHaveLength(0);
    await app.close();
  });

  it('strips a field the schema does not promise (AC-NF-07)', async () => {
    const { facade } = fakeFacade({ get: { ...RECORD, leaked_secret: 'sk_live_xxx' } });
    const app = await appWith(facade);
    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/brief` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('leaked_secret');
    expect(res.body).not.toContain('sk_live_xxx');
    await app.close();
  });

  it('rejects a non-uuid :id at the edge with a structured 422', async () => {
    const { facade } = fakeFacade({ get: RECORD });
    const app = await appWith(facade);
    const res = await app.inject({ method: 'GET', url: '/pulls/not-a-uuid/brief' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });
});

describe('POST /pulls/:id/brief', () => {
  it('defaults to force=false and passes a logger through (AC-12)', async () => {
    const { facade, generateCalls } = fakeFacade();
    const app = await appWith(facade);
    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/brief` });
    expect(res.statusCode).toBe(200);
    PrBriefRecord.parse(res.json());
    expect(generateCalls).toEqual([
      { workspaceId: 'w1', prId: PR_ID, force: false, hasLogger: true },
    ]);
    await app.close();
  });

  it('reaches the facade with force=true on ?force=true (AC-12)', async () => {
    const { facade, generateCalls } = fakeFacade();
    const app = await appWith(facade);
    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/brief?force=true` });
    expect(res.statusCode).toBe(200);
    expect(generateCalls[0]?.force).toBe(true);
    await app.close();
  });

  it('rejects a force value outside the enum at the edge', async () => {
    const { facade, generateCalls } = fakeFacade();
    const app = await appWith(facade);
    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/brief?force=yes` });
    expect(res.statusCode).toBe(422);
    expect(generateCalls).toHaveLength(0);
    await app.close();
  });

  it('404s when the PR does not exist in the workspace (AC-13)', async () => {
    const { facade } = fakeFacade();
    const throwing = {
      ...facade,
      generate: async () => {
        throw new NotFoundError('Pull request not found');
      },
    } as unknown as BriefFacade;
    const app = await appWith(throwing);
    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/brief` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    await app.close();
  });
});

/**
 * AC-NF-06 needs its own app, and this is the trap: `app.ts` registers
 * `@fastify/rate-limit` only when `config.nodeEnv !== 'test'`, so a route's
 * `config.rateLimit` is INERT under the config every other test here uses.
 * `LOG_LEVEL: 'silent'` keeps `logger: false`, so no pino-pretty transport
 * spins up for the development build.
 */
describe('POST /pulls/:id/brief rate limit (AC-NF-06)', () => {
  it('429s the 11th generation within the window', async () => {
    const devConfig = loadConfig({
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    const { facade } = fakeFacade();
    const app = await buildApp({
      config: devConfig,
      overrides: { auth: new MockAuthProvider(), brief: facade },
    });

    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/brief` });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10)).toEqual(new Array(10).fill(200));
    expect(codes[10]).toBe(429);
    await app.close();
  });
});
