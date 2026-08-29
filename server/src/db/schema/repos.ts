import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces, users } from './core';

export const repos = pgTable(
  'repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    clonePath: text('clone_path'),
    // The roots project-context discovery scans this repository under. NULLABLE
    // on purpose: NULL means "no repository setting of its own", which is
    // exactly the condition under which the workspace default
    // (`specs`/`docs`/`insights`) applies (AC-29). An empty array is a
    // different, deliberate statement — scan nothing.
    contextSearchRoots: jsonb('context_search_roots').$type<string[]>(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: now(),
  },
  (t) => ({
    uq: uniqueIndex('repos_ws_fullname_uq').on(t.workspaceId, t.fullName),
    wsIdx: index('repos_ws_idx').on(t.workspaceId),
    // Safe on an existing table only because the column is brand new and every
    // existing row is NULL — a CHECK is satisfied when its expression is NULL.
    searchRootsCk: check(
      'repos_context_search_roots_ck',
      sql`${t.contextSearchRoots} is null or jsonb_typeof(${t.contextSearchRoots}) = 'array'`,
    ),
  }),
);
