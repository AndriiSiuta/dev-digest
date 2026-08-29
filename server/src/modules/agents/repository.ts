import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { CiFailOn, Provider, ReviewStrategy } from '@devdigest/shared';
import { DEFAULT_AGENT_DESCRIPTION, INITIAL_AGENT_VERSION } from './constants.js';
import { isConfigChange } from './helpers.js';

/**
 * A2 — agents data-access. Owns `agents`, `agent_versions`, and the
 * `agent_skills` link table (shared with A1's skills repository, but A2 owns the
 * agent side: link/reorder/list for an agent). Workspace-scoped throughout.
 */

import type { AgentRow, AgentVersionRow } from '../../db/rows.js';
export type { AgentRow, AgentVersionRow };

export interface InsertAgent {
  workspaceId: string;
  name: string;
  description?: string;
  provider: Provider;
  model: string;
  systemPrompt: string;
  outputSchema?: unknown;
  strategy?: ReviewStrategy;
  ciFailOn?: CiFailOn;
  repoIntel?: boolean;
  enabled?: boolean;
  createdBy?: string | null;
}

export interface UpdateAgent {
  name?: string;
  description?: string;
  provider?: Provider;
  model?: string;
  systemPrompt?: string;
  outputSchema?: unknown;
  strategy?: ReviewStrategy;
  ciFailOn?: CiFailOn;
  repoIntel?: boolean;
  enabled?: boolean;
}

/** A skill linked to an agent (with its order + per-link switch). */
export interface LinkedSkillRow {
  skill: typeof t.skills.$inferSelect;
  order: number;
  /** `agent_skills.enabled` — distinct from the skill's own global `enabled`. */
  enabled: boolean;
}

/** One entry of the ordered set written by `setSkills`. */
export interface SkillLinkInput {
  skillId: string;
  enabled?: boolean;
}

/** One attached project-context document, as stored in `agent_context_docs`. */
export interface ContextDocLinkRow {
  repoId: string;
  path: string;
  order: number;
  enabled: boolean;
}

/** One entry of the ordered set written by `setContextDocs`. */
export interface ContextDocLinkInput {
  path: string;
  enabled?: boolean;
}

export class AgentsRepository {
  constructor(private db: Db) {}

  async list(workspaceId: string): Promise<AgentRow[]> {
    return this.db.select().from(t.agents).where(eq(t.agents.workspaceId, workspaceId));
  }

  async listEnabled(workspaceId: string): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.enabled, true)));
  }

  async getById(workspaceId: string, id: string): Promise<AgentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, id)));
    return row;
  }

  /** Delete an agent (scoped to workspace). Versions/skill-links cascade;
   *  agent_runs keep their history with agent_id set null. Returns false if
   *  no such agent existed in the workspace. */
  async deleteById(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, id)))
      .returning({ id: t.agents.id });
    return rows.length > 0;
  }

  /** Insert an agent AND record version 1 in agent_versions (immutable snapshot). */
  async insert(values: InsertAgent): Promise<AgentRow> {
    const [row] = await this.db
      .insert(t.agents)
      .values({
        workspaceId: values.workspaceId,
        name: values.name,
        description: values.description ?? DEFAULT_AGENT_DESCRIPTION,
        provider: values.provider,
        model: values.model,
        systemPrompt: values.systemPrompt,
        outputSchema: (values.outputSchema as object | undefined) ?? null,
        ...(values.strategy !== undefined ? { strategy: values.strategy } : {}),
        ...(values.ciFailOn !== undefined ? { ciFailOn: values.ciFailOn } : {}),
        ...(values.repoIntel !== undefined ? { repoIntel: values.repoIntel } : {}),
        enabled: values.enabled ?? true,
        version: INITIAL_AGENT_VERSION,
        createdBy: values.createdBy ?? null,
      })
      .returning();
    await this.snapshotVersion(row!, INITIAL_AGENT_VERSION);
    return row!;
  }

  /**
   * Update an agent. Any config change bumps the version and snapshots the new
   * config into agent_versions (reproducibility for eval).
   */
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateAgent,
  ): Promise<AgentRow | undefined> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return undefined;

    // A config-affecting change (anything except just toggling enabled) bumps version.
    const configChanged = isConfigChange(existing, patch);
    const nextVersion = configChanged ? existing.version + 1 : existing.version;

    const [row] = await this.db
      .update(t.agents)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
        ...(patch.outputSchema !== undefined
          ? { outputSchema: patch.outputSchema as object }
          : {}),
        ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
        ...(patch.ciFailOn !== undefined ? { ciFailOn: patch.ciFailOn } : {}),
        ...(patch.repoIntel !== undefined ? { repoIntel: patch.repoIntel } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(configChanged ? { version: nextVersion } : {}),
      })
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, id)))
      .returning();

    if (configChanged && row) await this.snapshotVersion(row, nextVersion);
    return row;
  }

  /**
   * Bump the agent's version and snapshot it, because its skill links changed.
   * Linking, unlinking, reordering and toggling a link all change the assembled
   * prompt, so they are config changes in exactly the same sense as editing the
   * system prompt — without this, two runs of "v3" could use different skills.
   */
  private async bumpForSkillChange(agentId: string): Promise<void> {
    const [row] = await this.db
      .update(t.agents)
      .set({ version: sql`${t.agents.version} + 1` })
      .where(eq(t.agents.id, agentId))
      .returning();
    if (row) await this.snapshotVersion(row, row.version);
  }

  private async snapshotVersion(row: AgentRow, version: number): Promise<void> {
    // Only the ENABLED links are recorded: the snapshot answers "what shaped
    // this version's prompt", and a disabled link shapes nothing.
    const skills = await this.enabledSkillIdsForAgent(row.id);
    // Attached documents across EVERY repo, because the version snapshot is not
    // per-repo: a past run must be able to show which documents it was told to
    // read, and the content is deliberately never snapshotted, so this list is
    // the only durable record of that instruction (AC-30).
    const contextDocs = await this.enabledContextDocRefs(row.id);
    await this.db
      .insert(t.agentVersions)
      .values({
        agentId: row.id,
        version,
        configJson: {
          provider: row.provider,
          model: row.model,
          system_prompt: row.systemPrompt,
          output_schema: row.outputSchema,
          strategy: row.strategy,
          ci_fail_on: row.ciFailOn,
          repo_intel: row.repoIntel,
          skills,
          context_docs: contextDocs,
        },
      })
      .onConflictDoNothing();
  }

  // ---- agent_versions (immutable config snapshots) ------------------------

  /** All config snapshots for an agent, newest version first. */
  async listVersions(agentId: string): Promise<AgentVersionRow[]> {
    return this.db
      .select()
      .from(t.agentVersions)
      .where(eq(t.agentVersions.agentId, agentId))
      .orderBy(desc(t.agentVersions.version));
  }

  /** A single config snapshot, or undefined if that version was never recorded. */
  async getVersion(agentId: string, version: number): Promise<AgentVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.agentVersions)
      .where(and(eq(t.agentVersions.agentId, agentId), eq(t.agentVersions.version, version)));
    return row;
  }

  // ---- agent_skills link table (A2 owns the agent side) -------------------

  /** Skills linked to an agent, in `order` ascending. */
  async linkedSkills(agentId: string): Promise<LinkedSkillRow[]> {
    const rows = await this.db
      .select({
        skill: t.skills,
        order: t.agentSkills.order,
        enabled: t.agentSkills.enabled,
      })
      .from(t.agentSkills)
      .innerJoin(t.skills, eq(t.agentSkills.skillId, t.skills.id))
      .where(eq(t.agentSkills.agentId, agentId))
      .orderBy(asc(t.agentSkills.order));
    return rows.map((r) => ({ skill: r.skill, order: r.order, enabled: r.enabled }));
  }

  async skillIdsForAgent(agentId: string): Promise<string[]> {
    const links = await this.linkedSkills(agentId);
    return links.map((l) => l.skill.id);
  }

  /** Ids of the links that actually reach the prompt (both switches on). */
  async enabledSkillIdsForAgent(agentId: string): Promise<string[]> {
    const links = await this.enabledSkillsForPrompt(agentId);
    return links.map((l) => l.skill.id);
  }

  /**
   * The skills that shape this agent's prompt, in link order: both the per-link
   * switch AND the skill's own global `enabled` must be true. This is the ONLY
   * query the review pipeline uses — everything else is editor-facing.
   */
  async enabledSkillsForPrompt(agentId: string): Promise<LinkedSkillRow[]> {
    const rows = await this.db
      .select({
        skill: t.skills,
        order: t.agentSkills.order,
        enabled: t.agentSkills.enabled,
      })
      .from(t.agentSkills)
      .innerJoin(t.skills, eq(t.agentSkills.skillId, t.skills.id))
      .where(
        and(
          eq(t.agentSkills.agentId, agentId),
          eq(t.agentSkills.enabled, true),
          eq(t.skills.enabled, true),
        ),
      )
      .orderBy(asc(t.agentSkills.order));
    return rows.map((r) => ({ skill: r.skill, order: r.order, enabled: r.enabled }));
  }

  /** Link a skill to an agent at a given order (idempotent: upserts order). */
  async linkSkill(
    agentId: string,
    skillId: string,
    order: number,
    enabled = true,
  ): Promise<void> {
    await this.db
      .insert(t.agentSkills)
      .values({ agentId, skillId, order, enabled })
      .onConflictDoUpdate({
        target: [t.agentSkills.agentId, t.agentSkills.skillId],
        set: { order, enabled },
      });
    await this.bumpForSkillChange(agentId);
  }

  async unlinkSkill(agentId: string, skillId: string): Promise<void> {
    await this.db
      .delete(t.agentSkills)
      .where(and(eq(t.agentSkills.agentId, agentId), eq(t.agentSkills.skillId, skillId)));
    await this.bumpForSkillChange(agentId);
  }

  /**
   * Replace the full set of linked skills for an agent with `links`, assigning
   * order = index. Used by the "Skills" editor tab (attach / reorder / toggle).
   * Skills not in the list are unlinked.
   *
   * NOTE: delete-then-insert without a transaction — this repo runs nothing in
   * one (see server/INSIGHTS.md), so a crash between the two statements leaves
   * the agent with no links rather than a half-applied set.
   */
  async setSkills(agentId: string, links: SkillLinkInput[]): Promise<void> {
    await this.db.delete(t.agentSkills).where(eq(t.agentSkills.agentId, agentId));
    if (links.length > 0) {
      await this.db.insert(t.agentSkills).values(
        links.map((l, i) => ({
          agentId,
          skillId: l.skillId,
          order: i,
          enabled: l.enabled ?? true,
        })),
      );
    }
    await this.bumpForSkillChange(agentId);
  }

  // ---- agent_context_docs (A2 owns the agent side) ------------------------
  //
  // This table lives with the agents repository rather than in the
  // project-context module for one load-bearing reason: `snapshotVersion` must
  // read the current attachment set to write it into the version snapshot, and
  // putting the table anywhere else makes the owning repository and
  // project-context mutually dependent.

  /** Attachments for an agent, optionally narrowed to one repo. Editor-facing. */
  async contextDocsForAgent(agentId: string, repoId?: string): Promise<ContextDocLinkRow[]> {
    return this.db
      .select({
        repoId: t.agentContextDocs.repoId,
        path: t.agentContextDocs.path,
        order: t.agentContextDocs.order,
        enabled: t.agentContextDocs.enabled,
      })
      .from(t.agentContextDocs)
      .where(
        repoId === undefined
          ? eq(t.agentContextDocs.agentId, agentId)
          : and(eq(t.agentContextDocs.agentId, agentId), eq(t.agentContextDocs.repoId, repoId)),
      )
      .orderBy(asc(t.agentContextDocs.repoId), asc(t.agentContextDocs.order));
  }

  /**
   * The documents that shape this agent's prompt FOR ONE REPO, in attachment
   * order. A run is always for exactly one repository, so it never has to choose
   * between repos (AC-27). The only query the review pipeline uses.
   */
  async enabledContextDocsForPrompt(
    agentId: string,
    repoId: string,
  ): Promise<{ path: string; order: number }[]> {
    return this.db
      .select({ path: t.agentContextDocs.path, order: t.agentContextDocs.order })
      .from(t.agentContextDocs)
      .where(
        and(
          eq(t.agentContextDocs.agentId, agentId),
          eq(t.agentContextDocs.repoId, repoId),
          eq(t.agentContextDocs.enabled, true),
        ),
      )
      .orderBy(asc(t.agentContextDocs.order));
  }

  /** Every enabled attachment as a `ContextDocRef`, for the version snapshot. */
  private async enabledContextDocRefs(
    agentId: string,
  ): Promise<{ repo_id: string; path: string }[]> {
    const rows = await this.db
      .select({ repoId: t.agentContextDocs.repoId, path: t.agentContextDocs.path })
      .from(t.agentContextDocs)
      .where(and(eq(t.agentContextDocs.agentId, agentId), eq(t.agentContextDocs.enabled, true)))
      .orderBy(asc(t.agentContextDocs.repoId), asc(t.agentContextDocs.order));
    return rows.map((r) => ({ repo_id: r.repoId, path: r.path }));
  }

  /**
   * Replace the attachment set for ONE (agent, repo) pair, order = index.
   *
   * Scoped to `(agentId, repoId)` and never across repos: the Context tab's repo
   * picker moves between repositories, and a delete that spanned them would wipe
   * the other repository's documents on every switch (AC-26, AC-27). Unticking a
   * document simply leaves it out of `docs` (AC-24).
   *
   * NOTE: delete-then-insert without a transaction — this repo runs nothing in
   * one (see server/INSIGHTS.md), so a crash between the two statements leaves
   * THAT repo's set empty rather than half-applied.
   */
  async setContextDocs(
    agentId: string,
    repoId: string,
    docs: ContextDocLinkInput[],
  ): Promise<void> {
    await this.db
      .delete(t.agentContextDocs)
      .where(and(eq(t.agentContextDocs.agentId, agentId), eq(t.agentContextDocs.repoId, repoId)));
    if (docs.length > 0) {
      await this.db.insert(t.agentContextDocs).values(
        docs.map((d, i) => ({
          agentId,
          repoId,
          path: d.path,
          order: i,
          enabled: d.enabled ?? true,
        })),
      );
    }
    await this.bumpForContextChange(agentId);
  }

  /**
   * Bump the agent's version and snapshot it, because its attached documents
   * changed — the same rule `bumpForSkillChange` applies to skill links, and for
   * the same reason: two runs of "v3" must not have been told to read different
   * documents (AC-30).
   */
  private async bumpForContextChange(agentId: string): Promise<void> {
    const [row] = await this.db
      .update(t.agents)
      .set({ version: sql`${t.agents.version} + 1` })
      .where(eq(t.agents.id, agentId))
      .returning();
    if (row) await this.snapshotVersion(row, row.version);
  }
}
