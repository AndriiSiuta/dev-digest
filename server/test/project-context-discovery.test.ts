import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoRef } from '@devdigest/shared';
import { FsProjectContextDocs } from '../src/adapters/projectcontext/fs.js';
import { docTypeForRoot } from '../src/modules/project-context/helpers.js';
import { DEFAULT_SEARCH_ROOTS } from '../src/modules/project-context/constants.js';

/**
 * Discovery over a real fixture tree (AC-01, AC-02, AC-03, AC-28).
 *
 * Hermetic: the filesystem is not the network, and the spec's "how it is
 * checked" column names discovery over a fixture tree. The tree is created
 * under `os.tmpdir()` and torn down here — no Postgres, no Docker, no clone.
 */

const REPO: RepoRef = { owner: 'acme', name: 'payments-api' };
const ROOTS = [...DEFAULT_SEARCH_ROOTS];

let cloneRoot: string;
let docs: FsProjectContextDocs;

beforeAll(async () => {
  cloneRoot = await mkdtemp(join(tmpdir(), 'devdigest-ctx-'));
  await mkdir(join(cloneRoot, 'specs'), { recursive: true });
  await mkdir(join(cloneRoot, 'docs', 'a', 'b', 'c'), { recursive: true });
  await mkdir(join(cloneRoot, 'insights'), { recursive: true });
  await mkdir(join(cloneRoot, 'src'), { recursive: true });

  await writeFile(join(cloneRoot, 'specs', 'api.md'), '# api spec\n');
  await writeFile(join(cloneRoot, 'docs', 'a', 'b', 'c', 'deep.md'), '# deep\n');
  await writeFile(join(cloneRoot, 'insights', 'notes.md'), '# insight\n');
  // Non-markdown neighbours that must NOT be listed (AC-03).
  await writeFile(join(cloneRoot, 'docs', 'README.txt'), 'text');
  await writeFile(join(cloneRoot, 'docs', 'notes.rst'), 'rst');
  await writeFile(join(cloneRoot, 'docs', 'LICENSE'), 'no extension');
  await writeFile(join(cloneRoot, 'docs', 'stale.md.bak'), '# backup');
  // Outside every configured root.
  await writeFile(join(cloneRoot, 'src', 'index.ts'), 'export {};');

  docs = new FsProjectContextDocs(() => cloneRoot);
});

afterAll(async () => {
  await rm(cloneRoot, { recursive: true, force: true });
});

describe('project-context discovery', () => {
  it('lists every markdown document under the configured roots, repo-relative (AC-01)', async () => {
    const found = await docs.list(REPO, ROOTS);
    expect(found.map((d) => d.path).sort()).toEqual([
      'docs/a/b/c/deep.md',
      'insights/notes.md',
      'specs/api.md',
    ]);
    expect(found.every((d) => d.bytes > 0)).toBe(true);
  });

  it('descends to any depth beneath a root (AC-02)', async () => {
    const found = await docs.list(REPO, ['docs']);
    expect(found.map((d) => d.path)).toContain('docs/a/b/c/deep.md');
  });

  it('excludes everything that is not markdown (AC-03)', async () => {
    const paths = (await docs.list(REPO, ROOTS)).map((d) => d.path);
    for (const excluded of [
      'docs/README.txt',
      'docs/notes.rst',
      'docs/LICENSE',
      'docs/stale.md.bak',
      'src/index.ts',
    ]) {
      expect(paths).not.toContain(excluded);
    }
  });

  it('derives the type from the root it was reached through (AC-28)', async () => {
    const byPath = new Map((await docs.list(REPO, ROOTS)).map((d) => [d.path, d.type]));
    expect(byPath.get('specs/api.md')).toBe('spec');
    expect(byPath.get('docs/a/b/c/deep.md')).toBe('doc');
    expect(byPath.get('insights/notes.md')).toBe('insight');
  });

  it('depluralises only a trailing s, and leaves a custom root alone (AC-28)', () => {
    expect(docTypeForRoot('specs')).toBe('spec');
    expect(docTypeForRoot('docs')).toBe('doc');
    expect(docTypeForRoot('insights')).toBe('insight');
    expect(docTypeForRoot('adr')).toBe('adr');
    // Nested roots take their LAST segment.
    expect(docTypeForRoot('server/specs')).toBe('spec');
  });

  it('keeps the first configured root when a file sits under two (AC-28)', async () => {
    // `docs` reached first, so `docs/a/b/c/deep.md` is typed `doc` even though
    // the second, more specific root also contains it.
    const found = await docs.list(REPO, ['docs', 'docs/a']);
    expect(found.filter((d) => d.path === 'docs/a/b/c/deep.md')).toHaveLength(1);
    expect(found.find((d) => d.path === 'docs/a/b/c/deep.md')?.type).toBe('doc');
  });

  it('treats a configured root that is absent as contributing nothing, not an error', async () => {
    await expect(docs.list(REPO, ['specs', 'adr'])).resolves.toEqual([
      { path: 'specs/api.md', type: 'spec', bytes: expect.any(Number) },
    ]);
  });

  it('yields [] for a repository with no checkout directory at all (AC-19)', async () => {
    const missing = new FsProjectContextDocs(() => join(cloneRoot, 'no-such-checkout'));
    await expect(missing.list(REPO, ROOTS)).resolves.toEqual([]);
  });

  it('reads one document at a time from the checkout (AC-05, AC-09)', async () => {
    await expect(docs.read(REPO, ROOTS, 'specs/api.md')).resolves.toBe('# api spec\n');
  });

  it('reflects an edit made between two reads — nothing is read from stored text (AC-09)', async () => {
    await writeFile(join(cloneRoot, 'specs', 'api.md'), '# api spec v2\n');
    await expect(docs.read(REPO, ROOTS, 'specs/api.md')).resolves.toBe('# api spec v2\n');
    await writeFile(join(cloneRoot, 'specs', 'api.md'), '# api spec\n');
  });
});
