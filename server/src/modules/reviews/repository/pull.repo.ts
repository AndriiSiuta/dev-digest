import { and, eq } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { IntentSource, PrIntentRecord } from '@devdigest/shared';
import type { PullRow } from '../../../db/rows.js';

// ---- PR lookup (workspace-scoped) -----------------------------------------

export async function getPull(
  db: Db,
  workspaceId: string,
  prId: string,
): Promise<PullRow | undefined> {
  const [row] = await db
    .select()
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
  return row;
}

export async function getRepo(
  db: Db,
  repoId: string,
): Promise<typeof t.repos.$inferSelect | undefined> {
  const [row] = await db.select().from(t.repos).where(eq(t.repos.id, repoId));
  return row;
}

export async function getPrFiles(
  db: Db,
  prId: string,
): Promise<(typeof t.prFiles.$inferSelect)[]> {
  return db.select().from(t.prFiles).where(eq(t.prFiles.prId, prId));
}

/**
 * Record the commit a review just ran against, so the PR list can derive
 * `reviewed` vs `needs_review` (head moved since the last review) vs `stale`.
 */
export async function markReviewed(db: Db, prId: string, sha: string): Promise<void> {
  await db
    .update(t.pullRequests)
    .set({ lastReviewedSha: sha })
    .where(eq(t.pullRequests.id, prId));
}

// ---- intent ---------------------------------------------------------------

/**
 * What a (re)classification writes. `classified_at` is set here (now) and
 * `missing_context` is DERIVED from `sources` on read, so neither is a field.
 */
export interface IntentWrite {
  intent: string;
  in_scope: string[];
  out_of_scope: string[];
  risk_areas: string[];
  confidence: number | null;
  sources: IntentSource[];
  model: string | null;
  head_sha: string | null;
}

export async function upsertIntent(db: Db, prId: string, intent: IntentWrite): Promise<void> {
  const values = {
    intent: intent.intent,
    inScope: intent.in_scope,
    outOfScope: intent.out_of_scope,
    riskAreas: intent.risk_areas,
    confidence: intent.confidence,
    sources: intent.sources,
    model: intent.model,
    headSha: intent.head_sha,
    classifiedAt: new Date(),
  };
  await db
    .insert(t.prIntent)
    .values({ prId, ...values })
    .onConflictDoUpdate({ target: t.prIntent.prId, set: values });
}

export async function getIntent(db: Db, prId: string): Promise<PrIntentRecord | undefined> {
  const [row] = await db.select().from(t.prIntent).where(eq(t.prIntent.prId, prId));
  if (!row) return undefined;
  return {
    pr_id: row.prId,
    intent: row.intent,
    in_scope: row.inScope,
    out_of_scope: row.outOfScope,
    risk_areas: row.riskAreas,
    confidence: row.confidence,
    sources: row.sources,
    // Derived, not stored: any source that never reached the prompt means the
    // classification ran on partial context.
    missing_context: row.sources.some(
      (s) => s.status === 'unreachable' || s.status === 'unsupported',
    ),
    model: row.model,
    head_sha: row.headSha,
    classified_at: row.classifiedAt.toISOString(),
  };
}
