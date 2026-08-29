import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  primaryKey,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces } from './core';
import { repos } from './repos';

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    type: text('type', { enum: ['rubric', 'convention', 'security', 'custom'] }).notNull(),
    source: text('source', {
      enum: ['manual', 'imported_url', 'extracted', 'community'],
    }).notNull(),
    body: text('body').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    evidenceFiles: jsonb('evidence_files').$type<string[]>(),
    createdAt: now(),
  },
  (t) => ({
    // Every read is workspace-scoped (the Skills grid, the agent editor's
    // picker); Postgres does not index foreign keys automatically.
    workspaceIdx: index('skills_workspace_idx').on(t.workspaceId),
    // `text({ enum })` narrows TypeScript only and emits no DB constraint —
    // these mirror the SkillType / SkillSource contract enums into Postgres.
    typeCk: check('skills_type_ck', sql`${t.type} in ('rubric', 'convention', 'security', 'custom')`),
    sourceCk: check(
      'skills_source_ck',
      sql`${t.source} in ('manual', 'imported_url', 'extracted', 'community')`,
    ),
  }),
);

export const skillVersions = pgTable(
  'skill_versions',
  {
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    // The project-context documents attached at snapshot time — `ContextDocRef[]`
    // (repo_id + path), never their text. The snapshot held only `body` before
    // this feature and had nowhere to record an attachment (AC-31). A constant
    // default is non-volatile, so adding it rewrites no rows.
    contextDocs: jsonb('context_docs')
      .$type<{ repo_id: string; path: string }[]>()
      .notNull()
      .default([]),
    // Optional note the author typed when saving ("Added Tests dimension").
    // Nullable by design: a save without one still snapshots, and the UI falls
    // back to a diff-derived summary rather than inventing a message.
    message: text('message'),
    createdAt: now(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.skillId, t.version] }) }),
);

/**
 * Project-context documents attached to a skill, triple `(skill, repo, path)`.
 * The skill-side twin of `agent_context_docs`; a document reaching a run
 * through a linked skill lands in the untrusted `## Project context` section,
 * never in the trusted `## Skills / rules` block (AC-13).
 */
export const skillContextDocs = pgTable(
  'skill_context_docs',
  {
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    /** Repo-relative, `/`-separated. Constrained below, not just in TypeScript. */
    path: text('path').notNull(),
    order: integer('order').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.skillId, t.repoId, t.path] }),
    repoIdx: index('skill_context_docs_repo_idx').on(t.repoId),
    pathCk: check(
      'skill_context_docs_path_ck',
      sql`${t.path} <> '' and ${t.path} !~ '^/' and ${t.path} !~ '(^|/)\\.\\.($|/)'`,
    ),
  }),
);
