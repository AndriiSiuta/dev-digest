import { z } from 'zod';

/**
 * Project context — markdown documents discovered in a repository checkout and
 * manually attached to an agent or a skill. The attachment stores the PATH
 * only; the document's text is read from the checkout at run time and is never
 * snapshotted (`specs/03-project-context-folder.md`).
 */

/**
 * A document's type, DERIVED from the search root it was found under — never
 * declared and never stored on the attachment. The default roots
 * (`specs`/`docs`/`insights`) yield `spec` / `doc` / `insight`, but the root set
 * is per-repository configurable, so a custom root such as `adr` produces a
 * value outside those three. That is why this is `z.string()` and not an enum.
 */
export const ProjectContextDocType = z.string();
export type ProjectContextDocType = z.infer<typeof ProjectContextDocType>;

/**
 * One discovered document, as the Context tab lists it. Carries NO body: a
 * preview is fetched one document at a time (`ProjectContextDocContent`), and
 * `bytes` comes from `stat` so rendering a list never reads a file. Token
 * counts are deliberately absent here — counting them would mean reading every
 * document just to draw a list.
 */
export const ProjectContextDoc = z.object({
  /** Repo-relative, `/`-separated. */
  path: z.string(),
  type: ProjectContextDocType,
  bytes: z.number().int(),
});
export type ProjectContextDoc = z.infer<typeof ProjectContextDoc>;

/** The one-at-a-time read-only preview of a single document. */
export const ProjectContextDocContent = z.object({
  path: z.string(),
  content: z.string(),
});
export type ProjectContextDocContent = z.infer<typeof ProjectContextDocContent>;

/**
 * The identity of an attached document inside an immutable version snapshot.
 * A path alone is ambiguous — the same agent can carry different documents in
 * different repositories — so the repo travels with it.
 */
export const ContextDocRef = z.object({
  repo_id: z.string(),
  path: z.string(),
});
export type ContextDocRef = z.infer<typeof ContextDocRef>;

/**
 * An agent's attachment of one document, identified by the triple
 * `(agent, repo, path)`. `enabled` is the per-link switch, the same shape
 * `AgentSkillLink` already carries.
 */
export const AgentContextDocLink = z.object({
  agent_id: z.string(),
  repo_id: z.string(),
  path: z.string(),
  order: z.number().int(),
  enabled: z.boolean(),
});
export type AgentContextDocLink = z.infer<typeof AgentContextDocLink>;

/** The skill-side twin of `AgentContextDocLink`; triple `(skill, repo, path)`. */
export const SkillContextDocLink = z.object({
  skill_id: z.string(),
  repo_id: z.string(),
  path: z.string(),
  order: z.number().int(),
  enabled: z.boolean(),
});
export type SkillContextDocLink = z.infer<typeof SkillContextDocLink>;

/**
 * Replace the attachment set FOR ONE REPOSITORY. Scoping by `repo_id` is
 * load-bearing: a body that replaced every repository's attachments would wipe
 * the other repository's documents each time the Context tab's repo picker
 * moved. Order is the array order.
 */
export const SetContextDocsBody = z.object({
  repo_id: z.string(),
  docs: z.array(
    z.object({
      path: z.string(),
      enabled: z.boolean().optional(),
    }),
  ),
});
export type SetContextDocsBody = z.infer<typeof SetContextDocsBody>;

/**
 * A repository's own search roots. Absent/unset means the repository has no
 * setting of its own and the workspace default applies.
 */
export const RepoContextSettings = z.object({
  search_roots: z.array(z.string()),
});
export type RepoContextSettings = z.infer<typeof RepoContextSettings>;
