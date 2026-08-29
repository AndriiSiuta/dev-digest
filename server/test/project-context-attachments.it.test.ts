import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockProjectContextDocs } from '../src/adapters/mocks.js';
import { toAgentVersionDto } from '../src/modules/agents/helpers.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[project-context-attachments] Docker not available — skipping integration tests.');
}

/**
 * Attachment persistence, version snapshots and workspace scoping — the
 * DB-backed half of the feature (AC-07, AC-24, AC-26, AC-27, AC-30, AC-31,
 * AC-NF-03).
 *
 * Nothing here triggers a review run, so no provider can be reached; the LLM
 * overrides are deliberately absent rather than stubbed, and `intent` is never
 * consulted (`server/INSIGHTS.md`, 2026-08-14).
 */
d('project-context attachments', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoA: string;
  let repoB: string;
  let seq = 0;

  const DOCS = {
    'specs/api.md': 'The api/ module never imports db/ directly.',
    'docs/db.md': 'Migrations are never edited in place.',
    'insights/notes.md': 'Recorded findings.',
  };

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db
      .select()
      .from(t.workspaces)
      .where(eq(t.workspaces.name, 'default'));
    workspaceId = ws!.id;
    repoA = await makeRepo('ctx-repo-a');
    repoB = await makeRepo('ctx-repo-b');
  });
  afterAll(async () => {
    await pg?.stop();
  });

  async function makeRepo(name: string, wsId = workspaceId): Promise<string> {
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId: wsId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    return repo!.id;
  }

  function makeApp() {
    return buildApp({
      config: loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv),
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        projectContextDocs: new MockProjectContextDocs({ ...DOCS }),
      },
    });
  }

  type App = Awaited<ReturnType<typeof makeApp>>;

  async function makeAgent(app: App): Promise<{ id: string; version: number }> {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: `Context Agent ${seq++}`,
        provider: 'openai',
        model: 'gpt-4.1',
        system_prompt: 'Review the diff.',
      },
    });
    return res.json();
  }

  async function makeSkill(app: App): Promise<{ id: string; version: number }> {
    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: {
        name: `Context Skill ${seq++}`,
        description: 'When X, do Y.',
        type: 'rubric',
        body: 'Prefer named exports.',
      },
    });
    return res.json();
  }

  // ---- AC-07: the path is persisted, the text is not ----------------------

  it('persists the document PATH and no body column exists on the table (AC-07)', async () => {
    const app = await makeApp();
    const agent = await makeAgent(app);

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context-docs`,
      payload: { repo_id: repoA, docs: [{ path: 'specs/api.md' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { agent_id: agent.id, repo_id: repoA, path: 'specs/api.md', order: 0, enabled: true },
    ]);

    const rows = await pg.handle.db
      .select()
      .from(t.agentContextDocs)
      .where(eq(t.agentContextDocs.agentId, agent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('specs/api.md');
    // The whole point of storing paths: nothing on this row can hold the
    // document's text, so it cannot go stale against the file.
    const columns = Object.keys(rows[0]!);
    expect(columns.sort()).toEqual(['agentId', 'enabled', 'order', 'path', 'repoId']);
    for (const column of columns) {
      expect(String(rows[0]![column as keyof typeof rows[0]])).not.toContain(DOCS['specs/api.md']);
    }
    await app.close();
  });

  it('the storage-layer path CHECK refuses a traversal path (defence in depth)', async () => {
    const app = await makeApp();
    const agent = await makeAgent(app);
    await expect(
      pg.handle.db
        .insert(t.agentContextDocs)
        .values({ agentId: agent.id, repoId: repoA, path: '../../etc/passwd' }),
    ).rejects.toThrow();
    await expect(
      pg.handle.db
        .insert(t.agentContextDocs)
        .values({ agentId: agent.id, repoId: repoA, path: '/etc/passwd' }),
    ).rejects.toThrow();
    await app.close();
  });

  // ---- AC-24: unticking removes the attachment ---------------------------

  it('unticking a document removes the row (AC-24)', async () => {
    const app = await makeApp();
    const agent = await makeAgent(app);
    await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context-docs`,
      payload: { repo_id: repoA, docs: [{ path: 'specs/api.md' }, { path: 'docs/db.md' }] },
    });
    const after = await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context-docs`,
      payload: { repo_id: repoA, docs: [{ path: 'specs/api.md' }] },
    });
    expect(after.json().map((d: { path: string }) => d.path)).toEqual(['specs/api.md']);

    // And the run path stops seeing it: this is the query the resolver uses.
    const forPrompt = await app.container.agentsRepo.enabledContextDocsForPrompt(agent.id, repoA);
    expect(forPrompt.map((d) => d.path)).toEqual(['specs/api.md']);
    await app.close();
  });

  // ---- AC-26 / AC-27: the set is replaced per repository, never across ----

  it('attaching in repo A leaves repo B-s attachments untouched (AC-26, AC-27)', async () => {
    const app = await makeApp();
    const agent = await makeAgent(app);

    await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context-docs`,
      payload: { repo_id: repoB, docs: [{ path: 'docs/db.md' }] },
    });
    // Now move the picker to repo A and attach something else entirely.
    await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context-docs`,
      payload: { repo_id: repoA, docs: [{ path: 'specs/api.md' }] },
    });

    const all = (
      await app.inject({ method: 'GET', url: `/agents/${agent.id}/context-docs` })
    ).json();
    expect(all).toHaveLength(2);
    expect(all.map((d: { repo_id: string; path: string }) => `${d.repo_id}:${d.path}`).sort()).toEqual(
      [`${repoA}:specs/api.md`, `${repoB}:docs/db.md`].sort(),
    );

    // Even clearing repo A's set entirely leaves repo B alone.
    await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context-docs`,
      payload: { repo_id: repoA, docs: [] },
    });
    const remaining = await pg.handle.db
      .select()
      .from(t.agentContextDocs)
      .where(eq(t.agentContextDocs.agentId, agent.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.repoId).toBe(repoB);
    await app.close();
  });

  it('filters the attachment list by ?repo_id (the repo picker, AC-26)', async () => {
    const app = await makeApp();
    const agent = await makeAgent(app);
    await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context-docs`,
      payload: { repo_id: repoA, docs: [{ path: 'specs/api.md' }] },
    });
    await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context-docs`,
      payload: { repo_id: repoB, docs: [{ path: 'docs/db.md' }] },
    });
    const onlyA = (
      await app.inject({ method: 'GET', url: `/agents/${agent.id}/context-docs?repo_id=${repoA}` })
    ).json();
    expect(onlyA.map((d: { path: string }) => d.path)).toEqual(['specs/api.md']);
    await app.close();
  });

  // ---- AC-30 / AC-31: version bump + immutable snapshot ------------------

  it('an agent attachment edit bumps the version and snapshots the paths (AC-30)', async () => {
    const app = await makeApp();
    const agent = await makeAgent(app);
    expect(agent.version).toBe(1);

    await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context-docs`,
      payload: { repo_id: repoA, docs: [{ path: 'specs/api.md' }, { path: 'docs/db.md' }] },
    });

    const [row] = await pg.handle.db
      .select()
      .from(t.agents)
      .where(eq(t.agents.id, agent.id));
    expect(row!.version).toBe(2);

    const versions = (
      await app.inject({ method: 'GET', url: `/agents/${agent.id}/versions` })
    ).json();
    expect(versions[0].version).toBe(2);
    expect(versions[0].config.context_docs).toEqual([
      { repo_id: repoA, path: 'specs/api.md' },
      { repo_id: repoA, path: 'docs/db.md' },
    ]);
    // v1 predates the attachment and stays as it was — the snapshot is immutable.
    expect(versions[1].config.context_docs).toEqual([]);
    await app.close();
  });

  it('a skill attachment edit bumps the skill version and snapshots the paths (AC-31)', async () => {
    const app = await makeApp();
    const skill = await makeSkill(app);
    expect(skill.version).toBe(1);

    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${skill.id}/context-docs`,
      payload: { repo_id: repoA, docs: [{ path: 'insights/notes.md' }] },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await pg.handle.db.select().from(t.skills).where(eq(t.skills.id, skill.id));
    expect(row!.version).toBe(2);

    const versions = (
      await app.inject({ method: 'GET', url: `/skills/${skill.id}/versions` })
    ).json();
    expect(versions[0].version).toBe(2);
    expect(versions[0].context_docs).toEqual([{ repo_id: repoA, path: 'insights/notes.md' }]);
    expect(versions[1].context_docs).toEqual([]);
    await app.close();
  });

  it('an agent_versions row written before this feature still parses (AC-30)', async () => {
    const app = await makeApp();
    const agent = await makeAgent(app);
    // Overwrite v1's snapshot with the PRE-FEATURE shape: no `context_docs` key
    // at all. `toAgentVersionDto` runs `AgentVersionConfig.parse` on read, so
    // without the schema's `.default([])` this would throw.
    await pg.handle.db
      .update(t.agentVersions)
      .set({
        configJson: {
          provider: 'openai',
          model: 'gpt-4.1',
          system_prompt: 'Review the diff.',
          output_schema: null,
          strategy: 'single-pass',
          ci_fail_on: 'critical',
          repo_intel: true,
          skills: [],
        },
      })
      .where(and(eq(t.agentVersions.agentId, agent.id), eq(t.agentVersions.version, 1)));

    const [legacy] = await pg.handle.db
      .select()
      .from(t.agentVersions)
      .where(and(eq(t.agentVersions.agentId, agent.id), eq(t.agentVersions.version, 1)));
    expect(() => toAgentVersionDto(legacy!)).not.toThrow();
    expect(toAgentVersionDto(legacy!).config.context_docs).toEqual([]);

    const res = await app.inject({ method: 'GET', url: `/agents/${agent.id}/versions` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ---- AC-29: per-repository search roots --------------------------------

  it('resolves the default roots, then the repository override (AC-29)', async () => {
    const app = await makeApp();
    const before = await app.inject({ method: 'GET', url: `/repos/${repoA}/context/search-roots` });
    expect(before.json()).toEqual({ search_roots: ['specs', 'docs', 'insights'] });

    const set = await app.inject({
      method: 'PUT',
      url: `/repos/${repoA}/context/search-roots`,
      payload: { search_roots: ['adr'] },
    });
    expect(set.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/repos/${repoA}/context/search-roots` });
    expect(after.json()).toEqual({ search_roots: ['adr'] });

    // repoB has no setting of its own and keeps the default.
    const other = await app.inject({ method: 'GET', url: `/repos/${repoB}/context/search-roots` });
    expect(other.json()).toEqual({ search_roots: ['specs', 'docs', 'insights'] });

    // Restore so the ordering of tests in this file does not matter.
    await pg.handle.db
      .update(t.repos)
      .set({ contextSearchRoots: null })
      .where(eq(t.repos.id, repoA));
    await app.close();
  });

  // ---- AC-NF-03: workspace scoping ---------------------------------------

  it('denies discovery, preview and attachment for a repo in another workspace (AC-NF-03)', async () => {
    const app = await makeApp();
    const agent = await makeAgent(app);
    const [otherWs] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: `other-${seq++}` })
      .returning();
    const foreignRepo = await makeRepo(`foreign-${seq++}`, otherWs!.id);

    const list = await app.inject({
      method: 'GET',
      url: `/repos/${foreignRepo}/context/documents`,
    });
    expect(list.statusCode).toBe(404);
    expect(list.json().error.code).toBe('not_found');

    const preview = await app.inject({
      method: 'GET',
      url: `/repos/${foreignRepo}/context/documents/content?path=specs/api.md`,
    });
    expect(preview.statusCode).toBe(404);

    const roots = await app.inject({
      method: 'GET',
      url: `/repos/${foreignRepo}/context/search-roots`,
    });
    expect(roots.statusCode).toBe(404);

    const attach = await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context-docs`,
      payload: { repo_id: foreignRepo, docs: [{ path: 'specs/api.md' }] },
    });
    expect(attach.statusCode).toBe(404);
    // …and nothing was written.
    const rows = await pg.handle.db
      .select()
      .from(t.agentContextDocs)
      .where(eq(t.agentContextDocs.repoId, foreignRepo));
    expect(rows).toEqual([]);
    await app.close();
  });

  it('denies attachment for an agent in another workspace (AC-NF-03)', async () => {
    const app = await makeApp();
    const [otherWs] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: `other-${seq++}` })
      .returning();
    const [foreignAgent] = await pg.handle.db
      .insert(t.agents)
      .values({
        workspaceId: otherWs!.id,
        name: 'Foreign',
        provider: 'openai',
        model: 'gpt-4.1',
        systemPrompt: 'x',
      })
      .returning();

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${foreignAgent!.id}/context-docs`,
      payload: { repo_id: repoA, docs: [{ path: 'specs/api.md' }] },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  // ---- discovery + preview through the module's routes -------------------

  it('lists documents and previews one WITHOUT attaching it (AC-01, AC-05, AC-06)', async () => {
    const app = await makeApp();
    const agent = await makeAgent(app);

    const list = await app.inject({ method: 'GET', url: `/repos/${repoA}/context/documents` });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((d: { path: string }) => d.path).sort()).toEqual([
      'docs/db.md',
      'insights/notes.md',
      'specs/api.md',
    ]);
    // The list carries no body — the response schema is an allowlist.
    for (const doc of list.json()) expect(Object.keys(doc).sort()).toEqual(['bytes', 'path', 'type']);

    const preview = await app.inject({
      method: 'GET',
      url: `/repos/${repoA}/context/documents/content?path=specs/api.md`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ path: 'specs/api.md', content: DOCS['specs/api.md'] });

    // Previewing is not attaching.
    const attached = await pg.handle.db
      .select()
      .from(t.agentContextDocs)
      .where(eq(t.agentContextDocs.agentId, agent.id));
    expect(attached).toEqual([]);
    await app.close();
  });
});
