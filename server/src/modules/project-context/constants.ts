/**
 * project-context — module constants.
 */

/**
 * The workspace-level default search roots, applied to a repository that has no
 * `repos.context_search_roots` of its own (AC-29). Their last path segments are
 * what `docTypeForRoot` depluralises into the `spec` / `doc` / `insight` types
 * the spec names (AC-28).
 */
export const DEFAULT_SEARCH_ROOTS = ['specs', 'docs', 'insights'] as const;

/** The only extension discovery accepts. Non-markdown is out of scope (AC-03). */
export const MARKDOWN_EXT = '.md';

/**
 * The combined token ceiling for one run's project context (AC-21).
 *
 * Sized against its neighbour, `DEFAULT_REPO_MAP_TOKEN_BUDGET = 1500`
 * (`src/modules/repo-intel/constants.ts`): whole documents are far larger than
 * a skeleton, and the diff is the real budget consumer, so this leaves room for
 * several documents without crowding the diff out. There is no measured basis
 * for the exact number and none is claimed. Overridable per call so a test can
 * inject a tiny ceiling instead of building a 12k-token fixture.
 */
export const PROJECT_CONTEXT_TOKEN_CEILING = 12_000;
