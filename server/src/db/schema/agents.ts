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
import { workspaces, users } from './core';
import { skills } from './skills';
import { repos } from './repos';

// ============================================================ Agents & skills

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  provider: text('provider', { enum: ['openai', 'anthropic', 'openrouter'] }).notNull(),
  model: text('model').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  outputSchema: jsonb('output_schema'),
  // Review execution strategy — whole diff in one call (default) vs per-file.
  strategy: text('strategy', { enum: ['single-pass', 'map-reduce', 'auto'] })
    .notNull()
    .default('single-pass'),
  // CI gate policy — when a CI review should BLOCK (REQUEST_CHANGES + fail the
  // check) vs just comment. Deterministic from finding severities.
  ciFailOn: text('ci_fail_on', { enum: ['never', 'critical', 'warning', 'any'] })
    .notNull()
    .default('critical'),
  // Whether this agent's reviews get repo-intel context (repo skeleton + callers
  // + file-rank note) injected into the prompt. Default on; the global
  // REPO_INTEL_ENABLED flag is the second gate (facade degrades when off).
  repoIntel: boolean('repo_intel').notNull().default(true),
  enabled: boolean('enabled').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: now(),
});

export const agentVersions = pgTable(
  'agent_versions',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    configJson: jsonb('config_json').notNull(),
    createdAt: now(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.agentId, t.version] }) }),
);

export const agentSkills = pgTable(
  'agent_skills',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    order: integer('order').notNull().default(0),
    // Per-link switch, distinct from the skill's own global `enabled`. Unchecking
    // a skill in the agent's Skills tab keeps the link (and its order) but stops
    // the body being appended to THIS agent's prompt. A skill is injected only
    // when both flags are true.
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.skillId] }),
    // Reverse lookup: "which agents use this skill?" (the Skills grid's used-by
    // count and the delete confirmation). The PK covers agent_id only.
    skillIdx: index('agent_skills_skill_idx').on(t.skillId),
  }),
);

/**
 * Project-context documents attached to an agent, identified by the triple
 * `(agent, repo, path)` — an agent reused across repositories carries a
 * different document set in each. The document's TEXT is deliberately absent:
 * it is read from the checkout at run time, so there is no body column here
 * and nothing to go stale (`specs/03-project-context-folder.md`, AC-07).
 */
export const agentContextDocs = pgTable(
  'agent_context_docs',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    /** Repo-relative, `/`-separated. Constrained below, not just in TypeScript. */
    path: text('path').notNull(),
    order: integer('order').notNull().default(0),
    // Per-link switch, the same shape `agent_skills.enabled` carries: unticking
    // keeps neither the row nor its order — the Context tab replaces the set —
    // but a future "keep it, mute it" affordance needs no migration.
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.repoId, t.path] }),
    // "Which agents read documents from this repo?" — Postgres does not index
    // foreign keys, and the PK's leading column is agent_id.
    repoIdx: index('agent_context_docs_repo_idx').on(t.repoId),
    // Defence in depth for AC-NF-01 at the storage layer: the reader refuses a
    // traversal path, and so does the table. Safe to declare here because the
    // table is brand new — `ADD CONSTRAINT … CHECK` validates existing rows.
    pathCk: check(
      'agent_context_docs_path_ck',
      sql`${t.path} <> '' and ${t.path} !~ '^/' and ${t.path} !~ '(^|/)\\.\\.($|/)'`,
    ),
  }),
);
