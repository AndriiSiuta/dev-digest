import type { Container } from '../../platform/container.js';
import type {
  ProjectContextDoc,
  ProjectContextDocContent,
  RepoRef,
  SpecRead,
} from '@devdigest/shared';
import { AppError, NotFoundError } from '../../platform/errors.js';
import { DEFAULT_SEARCH_ROOTS, PROJECT_CONTEXT_TOKEN_CEILING } from './constants.js';
import type {
  ContextDocsAgentsRepo,
  ContextDocsSkillsRepo,
  ProjectContextFacade,
  ResolvedContextDoc,
  ResolvedProjectContext,
} from './types.js';

/**
 * project-context — application service.
 *
 * A stage-2 module: routes + service, no repository of its own. It owns no
 * tables — `agent_context_docs` and `skill_context_docs` belong to the agents
 * and skills repositories, which is what lets those repositories snapshot the
 * attachment set into a version — so it reads through the container.
 *
 * Every method takes `workspaceId` and resolves the repository inside it before
 * touching a checkout (AC-NF-03): a repo id from another workspace must never
 * reach discovery, preview or attachment.
 */
export class ProjectContextService implements ProjectContextFacade {
  constructor(private container: Container) {}

  /**
   * The roots this repository is scanned under: its own setting when it has
   * one, else the workspace default (AC-29).
   *
   * One function on purpose — a future workspace-level override slots in as a
   * middle rung here without touching a single caller.
   */
  async resolveSearchRoots(workspaceId: string, repoId: string): Promise<string[]> {
    const own = await this.container.reposRepo.getSearchRoots(workspaceId, repoId);
    return own ?? [...DEFAULT_SEARCH_ROOTS];
  }

  /** The repo, as a `RepoRef`, or a 404 when it is not in this workspace. */
  private async repoRefIn(workspaceId: string, repoId: string): Promise<RepoRef> {
    const repo = await this.container.reposRepo.getById(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repository not found');
    return { owner: repo.owner, name: repo.name };
  }

  /** Every discoverable document in a repository's checkout (AC-01). */
  async listDocuments(workspaceId: string, repoId: string): Promise<ProjectContextDoc[]> {
    const ref = await this.repoRefIn(workspaceId, repoId);
    const roots = await this.resolveSearchRoots(workspaceId, repoId);
    return this.container.projectContextDocs.list(ref, roots);
  }

  /**
   * One document's content, for the read-only preview (AC-05). Reading is not
   * attaching — nothing here writes an attachment row (AC-06).
   */
  async readDocument(
    workspaceId: string,
    repoId: string,
    path: string,
  ): Promise<ProjectContextDocContent> {
    const ref = await this.repoRefIn(workspaceId, repoId);
    const roots = await this.resolveSearchRoots(workspaceId, repoId);
    try {
      const content = await this.container.projectContextDocs.read(ref, roots, path);
      return { path, content };
    } catch (err) {
      // A containment refusal is already an AppError (422) and must surface as
      // one — swallowing it into a 404 would hide a traversal attempt. Anything
      // else is a missing/unreadable file, which is a 404, not a 500.
      if (err instanceof AppError) throw err;
      throw new NotFoundError(`Document not found: ${path}`);
    }
  }

  /** The repository's search-roots setting, resolved (AC-29). */
  async getSearchRoots(workspaceId: string, repoId: string): Promise<{ search_roots: string[] }> {
    await this.repoRefIn(workspaceId, repoId);
    return { search_roots: await this.resolveSearchRoots(workspaceId, repoId) };
  }

  // The attachment reads go through NARROW structural ports rather than the
  // repository classes: `AgentsRepository` / `SkillsRepository` satisfy these
  // with no import, so nothing here names another module's data layer
  // (`server/INSIGHTS.md`, 2026-08-16).
  private get agents(): ContextDocsAgentsRepo {
    return this.container.agentsRepo;
  }

  private get skills(): ContextDocsSkillsRepo {
    return this.container.skillsRepo;
  }

  /**
   * Everything one run should read, in prompt order, already read and counted.
   *
   * Holds NO instance state across calls (AC-22): two concurrent runs of the
   * same agent each read and count independently and get their own `specsRead`.
   *
   * Order of operations, all of which are spec-level decisions rather than
   * implementation detail:
   *  1. the agent's own enabled attachments for THIS repo, in `order` (AC-32);
   *  2. then each enabled linked skill's attachments, in skill-link order,
   *     reusing the ordering `enabledSkillsForPrompt` already establishes;
   *  3. only attachments whose repo is the PR's repository (AC-27);
   *  4. de-duplicated by path, FIRST occurrence wins, so a document attached
   *     both directly and via a skill appears once at the agent's position
   *     (AC-20);
   *  5. read from the checkout at run time — nothing is read from stored text,
   *     because there is none (AC-09);
   *  6. an unreachable path is skipped, the run continues, and it is recorded
   *     as `unreachable` (AC-18) — the `IntentService.gather` degradation shape;
   *  7. the first document that would cross the ceiling AND EVERY DOCUMENT
   *     AFTER IT is omitted whole, never truncated (AC-21).
   *
   * Note the emergent consequence of 2 and 7 together: because overflow drops
   * from the end and a linked skill's documents sort last, a SKILL'S DOCUMENTS
   * ARE THE FIRST THING OMITTED at the ceiling. That falls out of two
   * independently reasonable decisions; it is intended, it is asserted in
   * `test/project-context-resolve.test.ts`, and it must not be "fixed" here by
   * reordering — that would be a spec change with a new AC-ID.
   */
  async resolveForRun(input: {
    workspaceId: string;
    agentId: string;
    repo: RepoRef & { id: string };
    ceiling?: number;
  }): Promise<ResolvedProjectContext> {
    const { workspaceId, agentId, repo } = input;
    const ceiling = input.ceiling ?? PROJECT_CONTEXT_TOKEN_CEILING;
    const roots = await this.resolveSearchRoots(workspaceId, repo.id);

    const ordered = await this.orderedPaths(agentId, repo.id);
    if (ordered.length === 0) return { specs: [], specsRead: [], tokens: 0 };

    const specs: ResolvedContextDoc[] = [];
    const specsRead: SpecRead[] = [];
    let tokens = 0;
    let overflowed = false;

    for (const path of ordered) {
      if (overflowed) {
        specsRead.push({ path, tokens: 0, status: 'omitted' });
        continue;
      }
      let text: string;
      try {
        text = await this.container.projectContextDocs.read(
          { owner: repo.owner, name: repo.name },
          roots,
          path,
        );
      } catch {
        // Moved, deleted, or refused by containment — skip it and keep going.
        specsRead.push({ path, tokens: 0, status: 'unreachable' });
        continue;
      }
      const cost = this.container.tokenizer.count(text);
      if (tokens + cost > ceiling) {
        overflowed = true;
        specsRead.push({ path, tokens: 0, status: 'omitted' });
        continue;
      }
      tokens += cost;
      specs.push({ path, text });
      specsRead.push({ path, tokens: cost, status: 'included' });
    }

    return { specs, specsRead, tokens };
  }

  /** Selection + ordering + dedupe, before anything is read (AC-20, AC-32). */
  private async orderedPaths(agentId: string, repoId: string): Promise<string[]> {
    const own = await this.agents.enabledContextDocsForPrompt(agentId, repoId);
    const paths = own.map((d) => d.path);

    const links = await this.agents.enabledSkillsForPrompt(agentId);
    for (const link of links) {
      const fromSkill = await this.skills.enabledContextDocsForPrompt(link.skill.id, repoId);
      paths.push(...fromSkill.map((d) => d.path));
    }

    const seen = new Set<string>();
    return paths.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  }

  /** Replace the repository's search-roots setting (AC-29). */
  async setSearchRoots(
    workspaceId: string,
    repoId: string,
    roots: string[],
  ): Promise<{ search_roots: string[] }> {
    const ok = await this.container.reposRepo.setSearchRoots(workspaceId, repoId, roots);
    if (!ok) throw new NotFoundError('Repository not found');
    return { search_roots: roots };
  }
}
