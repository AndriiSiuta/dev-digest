import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ProjectContextDoc, RepoRef } from '@devdigest/shared';
import type { ProjectContextDocs } from '../../modules/project-context/types.js';
import { docTypeForRoot, isMarkdown, resolveWithinRoots, toRepoRelative } from './paths.js';

/**
 * `ProjectContextDocs` over the repository checkout on disk.
 *
 * The checkout location is not this adapter's business: `clonePathFor` is
 * injected (sourced from `container.git.clonePathFor`) so where a repo lands
 * stays defined in exactly one place.
 *
 * Nothing here throws for an absent root, an absent checkout, or an unreadable
 * entry — discovery degrades to "fewer documents" so the run continues (AC-19).
 * `read` is the one place an attached path is opened, and it is where
 * containment is enforced (AC-NF-01).
 */
export class FsProjectContextDocs implements ProjectContextDocs {
  constructor(private clonePathFor: (repo: RepoRef) => string) {}

  async list(repo: RepoRef, roots: string[]): Promise<ProjectContextDoc[]> {
    const cloneRoot = resolve(this.clonePathFor(repo));
    const out: ProjectContextDoc[] = [];
    // De-dupe by path keeping the FIRST root in configured order, so a file
    // sitting under two roots takes the root it was reached through (AC-28).
    const seen = new Set<string>();

    for (const root of roots) {
      const type = docTypeForRoot(root);
      const rootDir = resolve(cloneRoot, root);
      for (const absolute of await walkMarkdown(rootDir)) {
        const path = toRepoRelative(cloneRoot, absolute);
        if (seen.has(path)) continue;
        seen.add(path);
        let bytes = 0;
        try {
          bytes = (await stat(absolute)).size;
        } catch {
          // Vanished between walk and stat — list it with an unknown size
          // rather than dropping it; the reader decides reachability.
        }
        out.push({ path, type, bytes });
      }
    }
    return out;
  }

  async read(repo: RepoRef, roots: string[], path: string): Promise<string> {
    const cloneRoot = this.clonePathFor(repo);
    const absolute = await resolveWithinRoots(cloneRoot, roots, path);
    return readFile(absolute, 'utf8');
  }
}

/** Every `.md` file beneath `dir`, at any depth. An absent `dir` yields []. */
async function walkMarkdown(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Root not present in this checkout (or no checkout at all) — contributes
    // nothing, and is not an error.
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkMarkdown(full)));
    } else if (entry.isFile() && isMarkdown(entry.name)) {
      found.push(full);
    }
  }
  // Stable order regardless of the filesystem's own; the maintainer's list and
  // the tests both read better sorted.
  return found.sort();
}
