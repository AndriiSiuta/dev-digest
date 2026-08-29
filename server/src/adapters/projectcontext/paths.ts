import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { ValidationError } from '../../platform/errors.js';
import { MARKDOWN_EXT } from '../../modules/project-context/constants.js';

/**
 * Pure path and type helpers for project-context discovery. No DB, no network;
 * the filesystem is touched in exactly one place (`realpath`, to resolve a
 * symlink) and only to decide containment.
 *
 * They live under `adapters/` rather than in the module because the mechanical
 * `adapters-stay-outermost` rule forbids an adapter importing a module's
 * `helpers.ts`, and three adapters need them (`projectcontext/fs.ts`,
 * `git/simple-git.ts`, `mocks.ts`). This is the same shape as
 * `adapters/git/diff-parser.ts` — a pure function filed under `adapters/` that
 * application code legitimately imports; classify by whether the code leaves
 * the process, not by folder (`server/INSIGHTS.md`, 2026-08-05). The module
 * re-exports them from its own `helpers.ts` so module code has one import path.
 */

/**
 * A document's type, derived from the search root it was reached through
 * (AC-28): the root's last path segment with one trailing `s` stripped, so
 * `specs → spec`, `docs → doc`, `insights → insight`, and a custom `adr → adr`.
 * Nothing is parsed out of the file and nothing is stored on the attachment.
 */
export function docTypeForRoot(root: string): string {
  const segments = root.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
  const last = segments[segments.length - 1] ?? root;
  return last.endsWith('s') && last.length > 1 ? last.slice(0, -1) : last;
}

/** Whether a filename is a markdown document. `.md.bak` is not (AC-03). */
export function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(MARKDOWN_EXT);
}

/** Normalise a filesystem path to the repo-relative, `/`-separated form we store. */
export function toRepoRelative(cloneRoot: string, absolute: string): string {
  return relative(cloneRoot, absolute).split(sep).join('/');
}

/** True when `child` is `parent` itself or lies beneath it. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve an attached path to an absolute path inside the checkout, or refuse
 * (AC-NF-01).
 *
 * Two conditions, both required: the resolved path is inside `cloneRoot`, AND
 * it is inside one of the configured search roots. The second is what stops an
 * attachment naming `src/index.ts` when the roots are `docs` — a path can be
 * perfectly contained and still be a document the maintainer never chose.
 *
 * `realpath` is applied when the target exists, so a symlink inside `docs/`
 * pointing out of the tree is refused rather than followed. A path that does
 * not exist is left as-is: "missing" is the reader's problem (AC-18), not a
 * containment failure.
 */
export async function resolveWithinRoots(
  cloneRoot: string,
  roots: string[],
  path: string,
): Promise<string> {
  if (path.length === 0) throw new ValidationError('Document path is empty');
  if (isAbsolute(path)) throw new ValidationError(`Document path must be repo-relative: ${path}`);

  const base = resolve(cloneRoot);
  const target = resolve(base, path);
  if (!isWithin(base, target)) {
    throw new ValidationError(`Document path escapes the repository checkout: ${path}`);
  }

  const rootDirs = roots.map((r) => resolve(base, r));
  if (!rootDirs.some((dir) => isWithin(dir, target))) {
    throw new ValidationError(`Document path is outside the configured search roots: ${path}`);
  }

  // Symlinks: compare what the path actually points AT. Both sides go through
  // realpath so a symlinked checkout directory does not read as an escape.
  let realTarget: string;
  let realBase: string;
  try {
    realTarget = await realpath(target);
  } catch {
    // Nothing there to follow — reachability is the reader's concern.
    return target;
  }
  try {
    realBase = await realpath(base);
  } catch {
    realBase = base;
  }
  if (!isWithin(realBase, realTarget)) {
    throw new ValidationError(`Document path resolves outside the repository checkout: ${path}`);
  }
  const realRoots = await Promise.all(
    rootDirs.map(async (dir) => {
      try {
        return await realpath(dir);
      } catch {
        return dir;
      }
    }),
  );
  if (!realRoots.some((dir) => isWithin(dir, realTarget))) {
    throw new ValidationError(`Document path resolves outside the configured search roots: ${path}`);
  }
  return target;
}

/**
 * The same containment rule with only the checkout as the boundary — used to
 * harden `GitClient.readFile`, which had no check at all
 * (`src/adapters/git/simple-git.ts`). Synchronous and lexical on purpose: it
 * guards a primitive on a hot path and must not add an fs round-trip.
 */
export function assertWithinCheckout(cloneRoot: string, path: string): string {
  if (path.length === 0) throw new ValidationError('File path is empty');
  if (isAbsolute(path)) throw new ValidationError(`File path must be repo-relative: ${path}`);
  const base = resolve(cloneRoot);
  const target = resolve(base, path);
  if (!isWithin(base, target)) {
    throw new ValidationError(`File path escapes the repository checkout: ${path}`);
  }
  return join(base, path);
}
