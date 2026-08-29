/**
 * Eval case creation — hermetic, on the `test/helpers/eval.ts` harness. Pins
 * the one-click finding → frozen case path and all four refusals
 * (AC-01..03, AC-05..08).
 */
import { describe, it, expect } from 'vitest';
import { buildEvalHarness, AGENT_ID, FINDING_ID, FIXTURE_PATCH, WORKSPACE_ID } from './helpers/eval.js';

const ACCEPTED = { acceptedAt: new Date('2026-08-29T00:00:00.000Z'), dismissedAt: null };
const DISMISSED = { acceptedAt: null, dismissedAt: new Date('2026-08-29T00:00:00.000Z') };

describe('createCaseFromFinding', () => {
  it('an accepted finding becomes a must_find case owned by the review agent (AC-01)', async () => {
    const h = buildEvalHarness({ finding: ACCEPTED });
    const created = await h.service.createCaseFromFinding(WORKSPACE_ID, FINDING_ID);

    expect(created.owner_kind).toBe('agent');
    expect(created.owner_id).toBe(AGENT_ID);
    expect(created.name).toBe(h.finding.title);
    expect(created.expected_output).toEqual({
      kind: 'must_find',
      file: 'src/config.ts',
      start_line: 11,
      end_line: 11,
    });
    expect(h.evalRepo.cases).toHaveLength(1);
  });

  it('a dismissed finding becomes a must_not_flag case (AC-02)', async () => {
    const h = buildEvalHarness({ finding: DISMISSED });
    const created = await h.service.createCaseFromFinding(WORKSPACE_ID, FINDING_ID);
    expect((created.expected_output as { kind: string }).kind).toBe('must_not_flag');
  });

  it('freezes the verbatim patch and the PR meta (AC-03)', async () => {
    const h = buildEvalHarness({ finding: ACCEPTED });
    const created = await h.service.createCaseFromFinding(WORKSPACE_ID, FINDING_ID);

    // Byte-equal to the stored pr_files.patch — no reformatting, no headers.
    expect(created.input_diff).toBe(FIXTURE_PATCH);
    expect(created.input_files).toEqual(['src/config.ts']);
    expect(created.input_meta).toEqual({
      pr_title: h.pull.title,
      pr_body: h.pull.body,
      repo: 'acme/payments-api',
      pr_number: h.pull.number,
      source_finding_id: FINDING_ID,
    });
  });

  it('refuses an undecided finding with 409 finding_undecided, creating nothing (AC-05)', async () => {
    const h = buildEvalHarness(); // neither accepted nor dismissed
    await expect(h.service.createCaseFromFinding(WORKSPACE_ID, FINDING_ID)).rejects.toMatchObject({
      code: 'finding_undecided',
      statusCode: 409,
    });
    expect(h.evalRepo.cases).toHaveLength(0);
  });

  it('refuses a duplicate with 409 eval_case_exists naming the existing case (AC-06)', async () => {
    const h = buildEvalHarness({ finding: ACCEPTED });
    const first = await h.service.createCaseFromFinding(WORKSPACE_ID, FINDING_ID);
    await expect(h.service.createCaseFromFinding(WORKSPACE_ID, FINDING_ID)).rejects.toMatchObject({
      code: 'eval_case_exists',
      statusCode: 409,
      details: { existing_case_id: first.id },
    });
    expect(h.evalRepo.cases).toHaveLength(1);
  });

  it('refuses with 422 no_diff_fragment when the stored patch is null (AC-07)', async () => {
    const h = buildEvalHarness({
      finding: ACCEPTED,
      prFiles: [{ path: 'src/config.ts', patch: null }],
    });
    await expect(h.service.createCaseFromFinding(WORKSPACE_ID, FINDING_ID)).rejects.toMatchObject({
      code: 'no_diff_fragment',
      statusCode: 422,
    });
    expect(h.evalRepo.cases).toHaveLength(0);
  });

  it('refuses when the file has no stored row at all (AC-07)', async () => {
    const h = buildEvalHarness({ finding: ACCEPTED, prFiles: [] });
    await expect(h.service.createCaseFromFinding(WORKSPACE_ID, FINDING_ID)).rejects.toMatchObject({
      code: 'no_diff_fragment',
    });
    expect(h.evalRepo.cases).toHaveLength(0);
  });

  it('refuses when the review has no agent, creating nothing (AC-08)', async () => {
    const h = buildEvalHarness({ finding: ACCEPTED, reviewAgentId: null });
    await expect(h.service.createCaseFromFinding(WORKSPACE_ID, FINDING_ID)).rejects.toMatchObject({
      code: 'not_found',
      message: 'Agent for this finding no longer exists',
    });
    expect(h.evalRepo.cases).toHaveLength(0);
  });

  it('refuses when the agent no longer exists, creating nothing (AC-08)', async () => {
    const h = buildEvalHarness({ finding: ACCEPTED, agentMissing: true });
    await expect(h.service.createCaseFromFinding(WORKSPACE_ID, FINDING_ID)).rejects.toMatchObject({
      code: 'not_found',
      message: 'Agent for this finding no longer exists',
    });
    expect(h.evalRepo.cases).toHaveLength(0);
  });

  it('404s a finding in another workspace before any other check (AC-NF-01)', async () => {
    const h = buildEvalHarness({ finding: ACCEPTED });
    await expect(
      h.service.createCaseFromFinding('00000000-0000-4000-8000-0000000000ff', FINDING_ID),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Finding not found' });
    expect(h.evalRepo.cases).toHaveLength(0);
  });
});

describe('listCases / deleteCase', () => {
  it('lists only the agent\'s cases and deletes with tenancy', async () => {
    const h = buildEvalHarness();
    const mine = h.evalRepo.addCase();
    h.evalRepo.addCase({ ownerId: '00000000-0000-4000-8000-0000000000aa' });

    const listed = await h.service.listCases(WORKSPACE_ID, AGENT_ID);
    expect(listed.map((c) => c.id)).toEqual([mine.id]);

    await h.service.deleteCase(WORKSPACE_ID, mine.id);
    expect(await h.service.listCases(WORKSPACE_ID, AGENT_ID)).toEqual([]);

    // A case outside the workspace is a 404, not a silent no-op delete.
    const foreign = h.evalRepo.addCase({ workspaceId: '00000000-0000-4000-8000-0000000000ff' });
    await expect(h.service.deleteCase(WORKSPACE_ID, foreign.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
