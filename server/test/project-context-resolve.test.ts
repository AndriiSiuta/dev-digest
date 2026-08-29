import { describe, it, expect } from 'vitest';
import type { RepoRef } from '@devdigest/shared';
import { ProjectContextService } from '../src/modules/project-context/service.js';
import { MockProjectContextDocs } from '../src/adapters/mocks.js';
import { DEFAULT_SEARCH_ROOTS } from '../src/modules/project-context/constants.js';

/**
 * `resolveForRun` — selection, ordering, dedupe, ceiling and degradation.
 *
 * Hermetic: fake ports plus `MockProjectContextDocs`. `Container` carries
 * private fields and cannot be satisfied by an object literal
 * (`server/INSIGHTS.md`, 2026-08-17), hence the cast.
 */

const WS = 'ws-1';
const AGENT = 'agent-1';
const REPO_A = { id: 'repo-a', owner: 'acme', name: 'payments-api' };
const REPO_B = { id: 'repo-b', owner: 'acme', name: 'billing' };

interface Fixture {
  files?: Record<string, string>;
  /** `agent_context_docs` rows, keyed `${agentId}:${repoId}`. */
  agentDocs?: Record<string, string[]>;
  /** Enabled skill links, in link order. */
  skillLinks?: string[];
  /** `skill_context_docs` rows, keyed `${skillId}:${repoId}`. */
  skillDocs?: Record<string, string[]>;
  searchRoots?: string[] | null;
}

function build(fixture: Fixture = {}) {
  const docs = new MockProjectContextDocs({ ...fixture.files });
  const tokenizerCalls: string[] = [];
  const container = {
    reposRepo: {
      getSearchRoots: async () => fixture.searchRoots ?? null,
      getById: async () => ({ id: REPO_A.id, owner: REPO_A.owner, name: REPO_A.name }),
    },
    agentsRepo: {
      enabledContextDocsForPrompt: async (agentId: string, repoId: string) =>
        (fixture.agentDocs?.[`${agentId}:${repoId}`] ?? []).map((path, order) => ({ path, order })),
      enabledSkillsForPrompt: async () =>
        (fixture.skillLinks ?? []).map((id, order) => ({ skill: { id }, order })),
    },
    skillsRepo: {
      enabledContextDocsForPrompt: async (skillId: string, repoId: string) =>
        (fixture.skillDocs?.[`${skillId}:${repoId}`] ?? []).map((path, order) => ({ path, order })),
    },
    projectContextDocs: docs,
    tokenizer: {
      count: (s: string) => {
        tokenizerCalls.push(s);
        return s.trim().length === 0 ? 0 : s.trim().split(/\s+/).length;
      },
    },
  };
  const service = new ProjectContextService(container as never);
  return { service, docs, tokenizerCalls };
}

const run = (service: ProjectContextService, repo = REPO_A, ceiling?: number) =>
  service.resolveForRun({
    workspaceId: WS,
    agentId: AGENT,
    repo: repo as RepoRef & { id: string },
    ...(ceiling !== undefined ? { ceiling } : {}),
  });

describe('resolveForRun — selection and ordering', () => {
  it('puts the agent-s own documents first, then linked skills in link order (AC-32)', async () => {
    const { service } = build({
      files: {
        'docs/own-a.md': 'own a',
        'docs/own-b.md': 'own b',
        'docs/from-s1.md': 'skill one',
        'docs/from-s2.md': 'skill two',
      },
      agentDocs: { [`${AGENT}:${REPO_A.id}`]: ['docs/own-a.md', 'docs/own-b.md'] },
      skillLinks: ['skill-1', 'skill-2'],
      skillDocs: {
        [`skill-1:${REPO_A.id}`]: ['docs/from-s1.md'],
        [`skill-2:${REPO_A.id}`]: ['docs/from-s2.md'],
      },
    });
    const out = await run(service);
    expect(out.specs.map((s) => s.path)).toEqual([
      'docs/own-a.md',
      'docs/own-b.md',
      'docs/from-s1.md',
      'docs/from-s2.md',
    ]);
  });

  it('includes a document attached both directly and via a skill exactly once (AC-20)', async () => {
    const { service } = build({
      files: { 'docs/shared.md': 'shared', 'docs/other.md': 'other' },
      agentDocs: { [`${AGENT}:${REPO_A.id}`]: ['docs/shared.md'] },
      skillLinks: ['skill-1', 'skill-2'],
      skillDocs: {
        [`skill-1:${REPO_A.id}`]: ['docs/shared.md'],
        [`skill-2:${REPO_A.id}`]: ['docs/shared.md', 'docs/other.md'],
      },
    });
    const out = await run(service);
    // Once, and at the AGENT's position (first), not the skill's.
    expect(out.specs.map((s) => s.path)).toEqual(['docs/shared.md', 'docs/other.md']);
    expect(out.specsRead.filter((s) => s.path === 'docs/shared.md')).toHaveLength(1);
  });

  it('resolves only the attachments of the PR-s own repository (AC-27)', async () => {
    const { service } = build({
      files: { 'docs/a.md': 'for repo a', 'docs/b.md': 'for repo b' },
      agentDocs: {
        [`${AGENT}:${REPO_A.id}`]: ['docs/a.md'],
        [`${AGENT}:${REPO_B.id}`]: ['docs/b.md'],
      },
    });
    expect((await run(service, REPO_A)).specs.map((s) => s.path)).toEqual(['docs/a.md']);
    expect((await run(service, REPO_B)).specs.map((s) => s.path)).toEqual(['docs/b.md']);
  });
});

describe('resolveForRun — reading and degradation', () => {
  it('reads from the checkout at run time, so an edit between runs shows up (AC-09)', async () => {
    const { service, docs } = build({
      files: { 'docs/api.md': 'version one' },
      agentDocs: { [`${AGENT}:${REPO_A.id}`]: ['docs/api.md'] },
    });
    expect((await run(service)).specs[0]?.text).toBe('version one');
    docs.set('docs/api.md', 'version two');
    expect((await run(service)).specs[0]?.text).toBe('version two');
  });

  it('skips a path that no longer exists, keeps the rest, marks it unreachable (AC-18)', async () => {
    const { service, docs } = build({
      files: { 'docs/gone.md': 'about to vanish', 'docs/stays.md': 'still here' },
      agentDocs: { [`${AGENT}:${REPO_A.id}`]: ['docs/gone.md', 'docs/stays.md'] },
    });
    docs.delete('docs/gone.md');
    const out = await run(service);
    expect(out.specs.map((s) => s.path)).toEqual(['docs/stays.md']);
    expect(out.specsRead).toEqual([
      { path: 'docs/gone.md', tokens: 0, status: 'unreachable' },
      { path: 'docs/stays.md', tokens: 2, status: 'included' },
    ]);
  });

  it('returns an empty result — no throw — when the repository has no checkout (AC-19)', async () => {
    // No files at all: every read fails, exactly as an absent checkout behaves.
    const { service } = build({
      files: {},
      agentDocs: { [`${AGENT}:${REPO_A.id}`]: ['docs/api.md'] },
    });
    const out = await run(service);
    expect(out.specs).toEqual([]);
    expect(out.tokens).toBe(0);
    expect(out.specsRead).toEqual([{ path: 'docs/api.md', tokens: 0, status: 'unreachable' }]);
  });

  it('returns an empty result for an agent with nothing attached', async () => {
    const { service } = build({ files: { 'docs/api.md': 'unattached' } });
    await expect(run(service)).resolves.toEqual({ specs: [], specsRead: [], tokens: 0 });
  });
});

describe('resolveForRun — the token ceiling', () => {
  it('drops from the end, whole documents only, and records the omitted paths (AC-21)', async () => {
    const { service } = build({
      // The counting spy is one token per word.
      files: {
        'docs/one.md': 'a b c',
        'docs/two.md': 'd e f',
        'docs/three.md': 'g h i',
      },
      agentDocs: {
        [`${AGENT}:${REPO_A.id}`]: ['docs/one.md', 'docs/two.md', 'docs/three.md'],
      },
    });
    const out = await run(service, REPO_A, 7);
    expect(out.specs.map((s) => s.path)).toEqual(['docs/one.md', 'docs/two.md']);
    expect(out.tokens).toBe(6);
    // Never truncated mid-document: every included document's text is intact.
    expect(out.specs.map((s) => s.text)).toEqual(['a b c', 'd e f']);
    expect(out.specsRead).toEqual([
      { path: 'docs/one.md', tokens: 3, status: 'included' },
      { path: 'docs/two.md', tokens: 3, status: 'included' },
      { path: 'docs/three.md', tokens: 0, status: 'omitted' },
    ]);
  });

  it('omits EVERY document after the first overflow, not just the oversized one (AC-21)', async () => {
    const { service } = build({
      files: {
        'docs/one.md': 'a b c',
        'docs/big.md': 'x '.repeat(20).trim(),
        'docs/small.md': 'y',
      },
      agentDocs: {
        [`${AGENT}:${REPO_A.id}`]: ['docs/one.md', 'docs/big.md', 'docs/small.md'],
      },
    });
    const out = await run(service, REPO_A, 10);
    expect(out.specs.map((s) => s.path)).toEqual(['docs/one.md']);
    // `docs/small.md` would still fit on its own — it is omitted anyway.
    expect(out.specsRead.map((s) => s.status)).toEqual(['included', 'omitted', 'omitted']);
  });

  it("omits a linked skill's documents first, because skills sort last (AC-21 x AC-32)", async () => {
    // A consequence of two independently reasonable decisions — overflow drops
    // from the end (AC-21) and skill documents sort last (AC-32). Asserted here
    // so a later reader can see it was intended, not an accident.
    const { service } = build({
      files: { 'docs/own.md': 'a b c', 'docs/from-skill.md': 'd e f' },
      agentDocs: { [`${AGENT}:${REPO_A.id}`]: ['docs/own.md'] },
      skillLinks: ['skill-1'],
      skillDocs: { [`skill-1:${REPO_A.id}`]: ['docs/from-skill.md'] },
    });
    const out = await run(service, REPO_A, 4);
    expect(out.specs.map((s) => s.path)).toEqual(['docs/own.md']);
    expect(out.specsRead.find((s) => s.path === 'docs/from-skill.md')?.status).toBe('omitted');
  });

  it('counts tokens with the INJECTED tokenizer, never a local heuristic (AC-NF-06)', async () => {
    const { service, tokenizerCalls } = build({
      files: { 'docs/api.md': 'one two three four' },
      agentDocs: { [`${AGENT}:${REPO_A.id}`]: ['docs/api.md'] },
    });
    const out = await run(service);
    expect(tokenizerCalls).toContain('one two three four');
    expect(out.specsRead[0]?.tokens).toBe(4);
  });
});

describe('resolveForRun — concurrency and search roots', () => {
  it('two concurrent calls each produce their own specsRead (AC-22)', async () => {
    const { service } = build({
      files: { 'docs/a.md': 'a a', 'docs/b.md': 'b b b' },
      agentDocs: {
        [`${AGENT}:${REPO_A.id}`]: ['docs/a.md'],
        [`${AGENT}:${REPO_B.id}`]: ['docs/b.md'],
      },
    });
    const [first, second] = await Promise.all([run(service, REPO_A), run(service, REPO_B)]);
    expect(first!.specsRead).toEqual([{ path: 'docs/a.md', tokens: 2, status: 'included' }]);
    expect(second!.specsRead).toEqual([{ path: 'docs/b.md', tokens: 3, status: 'included' }]);
    // Neither run's numbers leaked into the other.
    expect(first!.tokens).toBe(2);
    expect(second!.tokens).toBe(3);
  });

  it('falls back to the default roots when the repo has no setting of its own (AC-29)', async () => {
    const { service } = build({});
    await expect(service.resolveSearchRoots(WS, REPO_A.id)).resolves.toEqual([
      ...DEFAULT_SEARCH_ROOTS,
    ]);
  });

  it("uses the repository's own roots when it has them (AC-29)", async () => {
    const { service } = build({ searchRoots: ['adr', 'rfcs'] });
    await expect(service.resolveSearchRoots(WS, REPO_A.id)).resolves.toEqual(['adr', 'rfcs']);
  });

  it('honours an empty roots array as "scan nothing", not as "unset" (AC-29)', async () => {
    const { service } = build({ searchRoots: [] });
    await expect(service.resolveSearchRoots(WS, REPO_A.id)).resolves.toEqual([]);
  });
});
