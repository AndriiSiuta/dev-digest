import { eq } from 'drizzle-orm';
import { Brief } from '@devdigest/shared';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/** The stored brief plus its queryable provenance columns (AC-43). */
export interface StoredBrief {
  brief: Brief;
  headSha: string;
  model: string | null;
  generatedAt: Date;
}

/**
 * brief — data access. The ONLY code that touches `pr_brief`; the brief module
 * owns the table, so this is a module-local repository rather than a fourth
 * aggregate on `ReviewRepository`.
 */
export class BriefRepository {
  constructor(private db: Db) {}

  /**
   * The PR's stored brief, or `undefined`.
   *
   * ALL COLUMNS, deliberately — the same bare `select()` `getIntent` uses
   * (`modules/reviews/repository/pull.repo.ts:83`). A projection like
   * `select({ json: t.prBrief.json })` compiles, leaves `headSha` `undefined`,
   * makes the service's `stored.headSha === pull.headSha` cache check always
   * false, and turns every request into a paid model call — a silent, expensive
   * failure no type error catches.
   *
   * `Brief.parse` at the boundary: a legacy or garbage payload surfaces here as
   * a parse failure rather than as a malformed response, and Drizzle row types
   * stop at this line.
   */
  async getBrief(prId: string): Promise<StoredBrief | undefined> {
    const [row] = await this.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));
    if (!row) return undefined;
    return {
      brief: Brief.parse(row.json),
      headSha: row.headSha,
      model: row.model,
      generatedAt: row.generatedAt,
    };
  }

  /**
   * Write the PR's single brief.
   *
   * The upsert on the primary key is the whole answer to AC-25 and AC-42: one
   * row per PR, last writer wins, no accumulation per head SHA, and no lock —
   * which matters because nothing in this server runs inside a transaction
   * (`server/INSIGHTS.md`, 2026-08-05). It is also a SINGLE write, which is what
   * lets AC-15 hold: the row is only ever touched after the model call and the
   * grounding gate have both succeeded.
   */
  async saveBrief(
    prId: string,
    values: { brief: Brief; headSha: string; model: string | null },
  ): Promise<void> {
    const set = {
      json: values.brief,
      headSha: values.headSha,
      model: values.model,
      generatedAt: new Date(),
    };
    await this.db
      .insert(t.prBrief)
      .values({ prId, ...set })
      .onConflictDoUpdate({ target: t.prBrief.prId, set });
  }
}
