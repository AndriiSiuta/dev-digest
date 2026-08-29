import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoRef } from '@devdigest/shared';
import { FsProjectContextDocs } from '../src/adapters/projectcontext/fs.js';
import { SimpleGitClient } from '../src/adapters/git/simple-git.js';
import { ValidationError } from '../src/platform/errors.js';

/**
 * AC-NF-01 — an attached path that resolves outside the configured search roots
 * of its repository checkout is refused, not read.
 *
 * Two layers are exercised: the reader every attached path goes through
 * (`FsProjectContextDocs.read`), and the primitive underneath it
 * (`SimpleGitClient.readFile`), which had no containment check at all before
 * this feature — it is the defect the spec names as the reason AC-NF-01 is a
 * hard requirement.
 */

const REPO: RepoRef = { owner: 'acme', name: 'payments-api' };
const ROOTS = ['docs'];

let sandbox: string;
let cloneRoot: string;
let docs: FsProjectContextDocs;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'devdigest-containment-'));
  cloneRoot = join(sandbox, 'clones', 'acme', 'payments-api');
  await mkdir(join(cloneRoot, 'docs', 'a'), { recursive: true });
  await mkdir(join(cloneRoot, 'src'), { recursive: true });

  await writeFile(join(cloneRoot, 'docs', 'a', 'b.md'), '# ordinary document\n');
  await writeFile(join(cloneRoot, 'src', 'index.ts'), 'export {};');
  // A secret sitting next to the checkout, and one outside it entirely.
  await writeFile(join(cloneRoot, 'secret.md'), 'CHECKOUT SECRET');
  await writeFile(join(sandbox, 'outside.md'), 'OUTSIDE SECRET');
  // A symlink INSIDE a configured root whose target leaves the tree.
  await symlink(join(sandbox, 'outside.md'), join(cloneRoot, 'docs', 'escape.md'));

  docs = new FsProjectContextDocs(() => cloneRoot);
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('FsProjectContextDocs.read — containment (AC-NF-01)', () => {
  it('reads an ordinary repo-relative document inside a configured root', async () => {
    await expect(docs.read(REPO, ROOTS, 'docs/a/b.md')).resolves.toBe('# ordinary document\n');
  });

  it.each([
    ['a parent-relative escape', '../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a traversal that starts inside a root', 'docs/../../secret.md'],
    ['a traversal with a redundant segment', 'docs/./../../secret.md'],
    ['an escape back into the checkout root', 'docs/../secret.md'],
    ['a path inside the checkout but outside the roots', 'src/index.ts'],
    ['an empty path', ''],
  ])('refuses %s', async (_label, path) => {
    await expect(docs.read(REPO, ROOTS, path)).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a symlink inside docs/ whose target leaves the checkout', async () => {
    await expect(docs.read(REPO, ROOTS, 'docs/escape.md')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('SimpleGitClient.readFile — containment (AC-NF-01)', () => {
  const git = () => new SimpleGitClient(join(sandbox, 'clones'));

  it('still reads an ordinary repo-relative path', async () => {
    await expect(git().readFile(REPO, 'docs/a/b.md')).resolves.toBe('# ordinary document\n');
    // Unrestricted by search roots on purpose: this primitive serves the intent
    // classifier's PR-body doc refs, which are not project context.
    await expect(git().readFile(REPO, 'src/index.ts')).resolves.toBe('export {};');
  });

  it('refuses a ../ escape instead of reading the host filesystem', async () => {
    await expect(git().readFile(REPO, '../../outside.md')).rejects.toBeInstanceOf(ValidationError);
    await expect(git().readFile(REPO, '/etc/passwd')).rejects.toBeInstanceOf(ValidationError);
  });
});
