import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';

/**
 * No-DB route smoke tests via app.inject(). `/health` and the validation/error
 * envelope don't touch the database (postgres-js connects lazily), so these run
 * without Docker. DB-backed routes are covered in integration.test.ts.
 */
const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

describe('routes (no DB)', () => {
  it('GET /health → ok', async () => {
    const app = await buildApp({ config });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('POST /settings/test-connection (github) returns structured ConnTestResult', async () => {
    const app = await buildApp({
      config,
      overrides: { github: new MockGitHubClient({ login: 'octocat' }) },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/settings/test-connection',
      payload: { provider: 'github' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('github');
    expect(body.ok).toBe(true);
    expect(body.message).toContain('octocat');
    await app.close();
  });

  it('POST /settings/test-connection (openai) uses injected LLM listModels', async () => {
    const app = await buildApp({
      config,
      overrides: {
        llm: { openai: new MockLLMProvider('openai', { models: [{ id: 'gpt-4.1', provider: 'openai' }] }) },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/settings/test-connection',
      payload: { provider: 'openai' },
    });
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it('returns 422 structured error on invalid body', async () => {
    const app = await buildApp({ config });
    const res = await app.inject({
      method: 'POST',
      url: '/settings/test-connection',
      payload: { provider: 'not-a-provider' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });
});

/**
 * project-context routes are ROUTABLE on a built app (AC-01). Registration is
 * the step the whole feature hangs on — without the entry in
 * `src/modules/index.ts` these paths exist in a file and answer nothing, which
 * is the exact failure mode on record for the skills pipeline (root
 * `INSIGHTS.md`, 2026-08-05). A 404 from the ROUTER and a 404 from a handler
 * are told apart by the error envelope: an unrouted path has no `error.code`.
 */
describe('project-context routes are registered', () => {
  const uuid = '00000000-0000-4000-8000-000000000001';

  it.each([
    ['GET', `/repos/${uuid}/context/documents`],
    ['GET', `/repos/${uuid}/context/documents/content?path=specs/api.md`],
    ['GET', `/repos/${uuid}/context/search-roots`],
    ['GET', `/agents/${uuid}/context-docs`],
  ])('%s %s is routed', async (method, url) => {
    const app = await buildApp({ config });
    const res = await app.inject({ method: method as 'GET', url });
    // Fastify's unrouted 404 body is `{message: "Route GET:… not found", …}`
    // with no `error.code`; a handler's NotFoundError goes through the app's
    // error handler and carries `error.code === 'not_found'`. Only the first
    // shape proves the module was never registered.
    expect(res.body).not.toContain(`Route ${method}:`);
    await app.close();
  });

  it('rejects a non-uuid repo id at the edge with a structured 422', async () => {
    const app = await buildApp({ config });
    const res = await app.inject({ method: 'GET', url: '/repos/not-a-uuid/context/documents' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('rejects a preview with no ?path at the edge', async () => {
    const app = await buildApp({ config });
    const res = await app.inject({
      method: 'GET',
      url: `/repos/${uuid}/context/documents/content`,
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
