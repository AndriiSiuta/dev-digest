/**
 * AC-38 — nothing generates a brief as a side effect.
 *
 * The two things "SHALL NOT generate a brief" actually means are the PAID CALL
 * and the WRITE, so those are what this asserts: no structured completion named
 * `PrBriefDraft`, and no `saveBrief`. It deliberately does NOT spy on
 * `BriefFacade.generate` — that spy false-positives (a cache-hit `generate`
 * returns the stored brief and spends nothing, yet trips it) and false-negatives
 * (a future path constructing `BriefService` directly slips past it).
 *
 * Both harnesses wire the brief facade PRESENT and resolving to empty. An
 * ABSENT facade throws `Cannot read properties of undefined` inside a
 * best-effort `catch`, which is swallowed, and the test then passes for the
 * wrong reason (`server/INSIGHTS.md`, *What Doesn't Work*, 2026-08-28).
 */
import { describe, it, expect } from 'vitest';
import type { Brief, PrBriefRecord, StructuredRequest } from '@devdigest/shared';
import { getTableName } from 'drizzle-orm';
import * as t from '../src/db/schema.js';
import { MockGitHubClient } from '../src/adapters/mocks.js';
import { PullsService } from '../src/modules/pulls/service.js';
import { BRIEF_SCHEMA_NAME } from '../src/modules/brief/constants.js';
import { buildHarness } from './helpers/run-executor.js';

const EMPTY_BRIEF: Brief = {
  what: '',
  why: '',
  risk_level: 'none',
  risks: [],
  review_focus: [],
  degraded: false,
  missing_inputs: [],
};

const EMPTY_RECORD: PrBriefRecord = {
  pr_id: '00000000-0000-4000-8000-000000000003',
  brief: EMPTY_BRIEF,
  head_sha: 'a1b2c3d4',
  pr_head_sha: 'a1b2c3d4',
  model: null,
  generated_at: '2026-08-29T00:00:00.000Z',
};

/** A brief facade + repository that are wired, reachable, and record everything. */
function briefSeam() {
  const saved: unknown[] = [];
  return {
    saved,
    brief: {
      get: async () => undefined,
      generate: async () => EMPTY_RECORD,
    },
    briefRepo: {
      getBrief: async () => undefined,
      saveBrief: async (prId: string, values: unknown) => {
        saved.push({ prId, values });
      },
    },
  };
}

const briefDraftCalls = (calls: { method: string; req: unknown }[]) =>
  calls.filter(
    (c) =>
      c.method === 'completeStructured' &&
      (c.req as StructuredRequest<unknown>).schemaName === BRIEF_SCHEMA_NAME,
  );

describe('a review run generates no brief (AC-26, AC-38)', () => {
  it('makes no PrBriefDraft call and writes no brief', async () => {
    const seam = briefSeam();
    const harness = buildHarness({ container: { ...seam } });

    await harness.run();

    // Positive control: the run really happened, so the assertions below are
    // about the brief being absent rather than about nothing having run.
    expect(harness.llmCallCount()).toBeGreaterThan(0);
    expect(harness.recorded.reviews).toHaveLength(1);

    expect(briefDraftCalls(harness.llm.calls)).toEqual([]);
    expect(seam.saved).toEqual([]);
  });
});

describe('a PR sync generates no brief (AC-38)', () => {
  it('refreshes the PR detail from GitHub without a PrBriefDraft call or a brief write', async () => {
    const seam = briefSeam();
    const llmCalls: { method: string; req: unknown }[] = [];

    const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
    const REPO_ID = '00000000-0000-4000-8000-000000000002';
    const PR_ID = '00000000-0000-4000-8000-000000000003';

    const pullRow = { id: PR_ID, workspaceId: WORKSPACE_ID, repoId: REPO_ID, number: 482 };
    const repoRow = { id: REPO_ID, workspaceId: WORKSPACE_ID, owner: 'acme', name: 'payments-api' };

    // The writes `replaceDetail` makes are the point of the sync path; they are
    // accepted and discarded here, so what is left to observe is whether the
    // brief seam was touched.
    const writes: string[] = [];
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => (table === t.pullRequests ? [pullRow] : [repoRow]),
        }),
      }),
      delete: (table: unknown) => ({
        where: async () => {
          writes.push(`delete:${getTableName(table as Parameters<typeof getTableName>[0])}`);
        },
      }),
      insert: (table: unknown) => ({
        values: async () => {
          writes.push(`insert:${getTableName(table as Parameters<typeof getTableName>[0])}`);
        },
      }),
      update: (table: unknown) => ({
        set: () => ({
          where: async () => {
            writes.push(`update:${getTableName(table as Parameters<typeof getTableName>[0])}`);
          },
        }),
      }),
    };

    const container = {
      db,
      github: async () => new MockGitHubClient(),
      reviewRepo: {},
      llm: async () => ({
        completeStructured: async (req: unknown) => {
          llmCalls.push({ method: 'completeStructured', req });
          throw new Error('the sync path must not reach a model');
        },
      }),
      ...seam,
    };

    const service = new PullsService(container as never);
    const detail = await service.detail(WORKSPACE_ID, PR_ID);

    // Positive control: the sync really ran and really wrote.
    expect(detail.id).toBe(PR_ID);
    expect(writes).toContain('insert:pr_files');
    expect(writes).toContain('update:pull_requests');
    // …and no brief was written to `pr_brief` on the way through.
    expect(writes.some((w) => w.endsWith('pr_brief'))).toBe(false);

    expect(briefDraftCalls(llmCalls)).toEqual([]);
    expect(seam.saved).toEqual([]);
  });
});
