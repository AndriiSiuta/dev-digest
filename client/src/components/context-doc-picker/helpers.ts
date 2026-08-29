import type { ProjectContextDoc } from "@devdigest/shared";

/** Pure helpers for the project-context document picker. */

/** One attachment, in the shape both the agent and the skill link carry. */
export interface AttachedDoc {
  repo_id: string;
  path: string;
  order: number;
}

/** The attached paths for one repository, in attachment order. */
export function attachedPathsFor(attached: AttachedDoc[], repoId: string | null): string[] {
  if (!repoId) return [];
  return attached
    .filter((a) => a.repo_id === repoId)
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((a) => a.path);
}

/**
 * Filter documents by a path substring, case-insensitively (AC-04). Matching on
 * the PATH rather than the content is deliberate: the list carries no content.
 */
export function filterDocs(docs: ProjectContextDoc[], query: string): ProjectContextDoc[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return docs;
  return docs.filter((d) => d.path.toLowerCase().includes(q));
}

/**
 * Attach or detach one path, preserving the order of everything else. A newly
 * ticked document goes last, so ticking never silently reorders the prompt.
 */
export function togglePath(current: string[], path: string, attach: boolean): string[] {
  if (attach) return current.includes(path) ? current : [...current, path];
  return current.filter((p) => p !== path);
}

/** Bytes → kB, one decimal, for the size hint next to a path. */
export function toKb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}
