import type { ProjectContextDoc, RepoRef, SpecRead } from '@devdigest/shared';

/**
 * project-context — the module's ports.
 *
 * `ProjectContextDocs` is the discovery/read port. It lives here rather than in
 * `vendor/shared/adapters.ts` because only this module needs it, and every
 * shape in `vendor/shared` is a fifth file that has to be hand-mirrored into
 * the client for no benefit (root `INSIGHTS.md`, 2026-07-29).
 */
export interface ProjectContextDocs {
  /**
   * Every markdown document beneath `roots` in the repository's checkout,
   * repo-relative and `/`-separated, recursively to any depth (AC-01, AC-02).
   * A configured root that is absent contributes nothing, and a repository with
   * no checkout at all yields `[]` — neither is an error, which is what lets a
   * run degrade instead of failing (AC-19).
   */
  list(repo: RepoRef, roots: string[]): Promise<ProjectContextDoc[]>;
  /**
   * One document's content. `roots` travels with the call because containment
   * is checked against them (AC-NF-01) — the port speaks the caller's
   * vocabulary, not the filesystem's. Throws when the path is unreachable or
   * escapes; the resolver turns that into `status: 'unreachable'` (AC-18).
   */
  read(repo: RepoRef, roots: string[], path: string): Promise<string>;
}

/**
 * The reads the resolver needs from the agents repository, declared structurally
 * so the module never `import type`s a sibling module's repository.
 * `AgentsRepository` satisfies this with no import at all, which keeps the
 * dependency graph clean for the right reason rather than an invisible one
 * (`server/INSIGHTS.md`, 2026-08-16).
 */
export interface ContextDocsAgentsRepo {
  enabledContextDocsForPrompt(
    agentId: string,
    repoId: string,
  ): Promise<{ path: string; order: number }[]>;
  enabledSkillsForPrompt(agentId: string): Promise<{ skill: { id: string }; order: number }[]>;
}

/** The same narrow port over the skills repository. */
export interface ContextDocsSkillsRepo {
  enabledContextDocsForPrompt(
    skillId: string,
    repoId: string,
  ): Promise<{ path: string; order: number }[]>;
}

/** Per-repository search roots, read through the repos repository. */
export interface ContextSearchRootsRepo {
  getSearchRoots(workspaceId: string, repoId: string): Promise<string[] | null>;
}

/** One attached document that reached the prompt. */
export interface ResolvedContextDoc {
  path: string;
  text: string;
}

/** What one run's project-context resolution produced. */
export interface ResolvedProjectContext {
  /** In prompt order; feeds `reviewPullRequest`'s `specs` slot. */
  specs: ResolvedContextDoc[];
  /** Every document considered, included or not — the trace's `specs_read`. */
  specsRead: SpecRead[];
  /** Combined token cost of the INCLUDED documents. */
  tokens: number;
}

/**
 * project-context — the facade the reviews module reaches through
 * `container.projectContext`, so it never imports this module's service.
 */
export interface ProjectContextFacade {
  resolveForRun(input: {
    workspaceId: string;
    agentId: string;
    repo: RepoRef & { id: string };
    ceiling?: number;
  }): Promise<ResolvedProjectContext>;
}
