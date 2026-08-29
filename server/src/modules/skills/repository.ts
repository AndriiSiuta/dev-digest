import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { SkillSource, SkillType } from '@devdigest/shared';
import { INITIAL_SKILL_VERSION } from './constants.js';
import { isSkillConfigChange } from './helpers.js';

/**
 * A1 — skills data-access. Owns `skills` and `skill_versions`. The
 * `agent_skills` link table is owned by A2 (the agents repository) — this side
 * only READS it, for the used-by count and the "which agents use this skill"
 * lookup shown before a delete. Workspace-scoped throughout.
 */

import type { SkillRow, SkillVersionRow } from '../../db/rows.js';
export type { SkillRow, SkillVersionRow };

export interface InsertSkill {
  workspaceId: string;
  name: string;
  description: string;
  type: SkillType;
  source?: SkillSource;
  body: string;
  enabled?: boolean;
  evidenceFiles?: string[] | null;
}

export interface UpdateSkill {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
  enabled?: boolean;
}

/** One attached project-context document, as stored in `skill_context_docs`. */
export interface SkillContextDocLinkRow {
  repoId: string;
  path: string;
  order: number;
  enabled: boolean;
}

/** One entry of the ordered set written by `setContextDocs`. */
export interface SkillContextDocLinkInput {
  path: string;
  enabled?: boolean;
}

/** A skill plus how many agents link it (the grid's used-by count). */
export interface SkillWithUsage {
  skill: SkillRow;
  usedBy: number;
}

export class SkillsRepository {
  constructor(private db: Db) {}

  /**
   * All skills in a workspace, newest first, each with its link count. One
   * query with a LEFT JOIN + GROUP BY rather than a count per row.
   */
  async listWithUsage(workspaceId: string): Promise<SkillWithUsage[]> {
    const rows = await this.db
      .select({ skill: t.skills, usedBy: sql<number>`count(${t.agentSkills.agentId})::int` })
      .from(t.skills)
      .leftJoin(t.agentSkills, eq(t.agentSkills.skillId, t.skills.id))
      .where(eq(t.skills.workspaceId, workspaceId))
      .groupBy(t.skills.id)
      .orderBy(desc(t.skills.createdAt));
    return rows.map((r) => ({ skill: r.skill, usedBy: r.usedBy }));
  }

  async getById(workspaceId: string, id: string): Promise<SkillRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)));
    return row;
  }

  /** Ids that exist in this workspace, out of the given set (link validation). */
  async existingIds(workspaceId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .select({ id: t.skills.id })
      .from(t.skills)
      .where(eq(t.skills.workspaceId, workspaceId));
    const all = new Set(rows.map((r) => r.id));
    return new Set(ids.filter((id) => all.has(id)));
  }

  /** Insert a skill AND record version 1 (immutable body snapshot). */
  async insert(values: InsertSkill): Promise<SkillRow> {
    const [row] = await this.db
      .insert(t.skills)
      .values({
        workspaceId: values.workspaceId,
        name: values.name,
        description: values.description,
        type: values.type,
        source: values.source ?? 'manual',
        body: values.body,
        enabled: values.enabled ?? true,
        version: INITIAL_SKILL_VERSION,
        evidenceFiles: values.evidenceFiles ?? null,
      })
      .returning();
    await this.snapshotVersion(row!, INITIAL_SKILL_VERSION);
    return row!;
  }

  /**
   * Update a skill. A content change (anything but toggling `enabled`) bumps the
   * version and snapshots the new body into `skill_versions`, together with the
   * author's optional note about what changed.
   */
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateSkill,
    versionMessage?: string,
  ): Promise<SkillRow | undefined> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return undefined;

    const contentChanged = isSkillConfigChange(existing, patch);
    const nextVersion = contentChanged ? existing.version + 1 : existing.version;

    const [row] = await this.db
      .update(t.skills)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(contentChanged ? { version: nextVersion } : {}),
      })
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)))
      .returning();

    if (contentChanged && row) await this.snapshotVersion(row, nextVersion, versionMessage);
    return row;
  }

  /** Delete a skill; `agent_skills` and `skill_versions` cascade. */
  async deleteById(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)))
      .returning({ id: t.skills.id });
    return rows.length > 0;
  }

  private async snapshotVersion(
    row: SkillRow,
    version: number,
    message?: string,
  ): Promise<void> {
    const trimmed = message?.trim();
    // Attached documents across every repo — the snapshot held only `body`
    // before this feature and had nowhere to record an attachment (AC-31).
    const contextDocs = await this.enabledContextDocRefs(row.id);
    await this.db
      .insert(t.skillVersions)
      .values({
        skillId: row.id,
        version,
        body: row.body,
        contextDocs,
        // Empty string and "not supplied" mean the same thing here — both leave
        // the column NULL so the UI falls back to the derived summary.
        message: trimmed ? trimmed : null,
      })
      .onConflictDoNothing();
  }

  // ---- skill_versions (immutable body snapshots) --------------------------

  async listVersions(skillId: string): Promise<SkillVersionRow[]> {
    return this.db
      .select()
      .from(t.skillVersions)
      .where(eq(t.skillVersions.skillId, skillId))
      .orderBy(desc(t.skillVersions.version));
  }

  async getVersion(skillId: string, version: number): Promise<SkillVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.skillVersions)
      .where(and(eq(t.skillVersions.skillId, skillId), eq(t.skillVersions.version, version)));
    return row;
  }

  // ---- read-only view of the link table (A2 owns writes) ------------------

  /** Agents linking this skill, for the delete confirmation. */
  async linkedAgents(skillId: string): Promise<Array<{ id: string; name: string }>> {
    return this.db
      .select({ id: t.agents.id, name: t.agents.name })
      .from(t.agentSkills)
      .innerJoin(t.agents, eq(t.agentSkills.agentId, t.agents.id))
      .where(eq(t.agentSkills.skillId, skillId))
      .orderBy(asc(t.agents.name));
  }

  // ---- skill_context_docs (A1 owns the skill side) ------------------------
  //
  // Owned here for the same reason the agent side is owned by the agents
  // repository: `snapshotVersion` must read the current attachment set to write
  // it into `skill_versions.context_docs`.

  /** Attachments for a skill, optionally narrowed to one repo. Editor-facing. */
  async contextDocsForSkill(skillId: string, repoId?: string): Promise<SkillContextDocLinkRow[]> {
    return this.db
      .select({
        repoId: t.skillContextDocs.repoId,
        path: t.skillContextDocs.path,
        order: t.skillContextDocs.order,
        enabled: t.skillContextDocs.enabled,
      })
      .from(t.skillContextDocs)
      .where(
        repoId === undefined
          ? eq(t.skillContextDocs.skillId, skillId)
          : and(eq(t.skillContextDocs.skillId, skillId), eq(t.skillContextDocs.repoId, repoId)),
      )
      .orderBy(asc(t.skillContextDocs.repoId), asc(t.skillContextDocs.order));
  }

  /**
   * The documents a linked skill contributes to a run's prompt FOR ONE REPO, in
   * attachment order. They reach the untrusted `## Project context` section,
   * never the trusted `## Skills / rules` block (AC-13).
   */
  async enabledContextDocsForPrompt(
    skillId: string,
    repoId: string,
  ): Promise<{ path: string; order: number }[]> {
    return this.db
      .select({ path: t.skillContextDocs.path, order: t.skillContextDocs.order })
      .from(t.skillContextDocs)
      .where(
        and(
          eq(t.skillContextDocs.skillId, skillId),
          eq(t.skillContextDocs.repoId, repoId),
          eq(t.skillContextDocs.enabled, true),
        ),
      )
      .orderBy(asc(t.skillContextDocs.order));
  }

  /** Every enabled attachment as a `ContextDocRef`, for the version snapshot. */
  private async enabledContextDocRefs(
    skillId: string,
  ): Promise<{ repo_id: string; path: string }[]> {
    const rows = await this.db
      .select({ repoId: t.skillContextDocs.repoId, path: t.skillContextDocs.path })
      .from(t.skillContextDocs)
      .where(and(eq(t.skillContextDocs.skillId, skillId), eq(t.skillContextDocs.enabled, true)))
      .orderBy(asc(t.skillContextDocs.repoId), asc(t.skillContextDocs.order));
    return rows.map((r) => ({ repo_id: r.repoId, path: r.path }));
  }

  /**
   * Replace the attachment set for ONE (skill, repo) pair, order = index.
   * Scoped to the repo for the same reason as the agent side (AC-26/AC-27), and
   * non-transactional for the same reason (see server/INSIGHTS.md).
   */
  async setContextDocs(
    skillId: string,
    repoId: string,
    docs: SkillContextDocLinkInput[],
  ): Promise<void> {
    await this.db
      .delete(t.skillContextDocs)
      .where(and(eq(t.skillContextDocs.skillId, skillId), eq(t.skillContextDocs.repoId, repoId)));
    if (docs.length > 0) {
      await this.db.insert(t.skillContextDocs).values(
        docs.map((d, i) => ({
          skillId,
          repoId,
          path: d.path,
          order: i,
          enabled: d.enabled ?? true,
        })),
      );
    }
    await this.bumpForContextChange(skillId);
  }

  /**
   * Bump the skill's version and snapshot it, because its attached documents
   * changed — attachments shape the prompt exactly as the body does (AC-31).
   */
  private async bumpForContextChange(skillId: string): Promise<void> {
    const [row] = await this.db
      .update(t.skills)
      .set({ version: sql`${t.skills.version} + 1` })
      .where(eq(t.skills.id, skillId))
      .returning();
    if (row) await this.snapshotVersion(row, row.version);
  }
}
