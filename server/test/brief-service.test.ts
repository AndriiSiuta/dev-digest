/**
 * BriefService — the whole gather → one model call → ground → persist path,
 * hermetic. Every facade on the harness container is wired and resolves to
 * something empty, never absent, so the best-effort `catch` in the gather step
 * cannot make an assertion pass for the wrong reason
 * (`server/INSIGHTS.md`, 2026-08-28).
 */
import { describe, it, expect } from 'vitest';
import {
  FEATURE_MODELS,
  FeatureModelId,
  PrBriefRecord,
  type Brief,
  type StructuredRequest,
} from '@devdigest/shared';
import { NotFoundError } from '../src/platform/errors.js';
import {
  BRIEF_MAX_TOKENS,
  BRIEF_TIMEOUT_MS,
  BRIEF_SCHEMA_NAME,
} from '../src/modules/brief/constants.js';
import {
  buildBriefHarness,
  DEFAULT_DRAFT,
  EMPTY_BLAST,
  HEAD_SHA,
  PR_ID,
  WORKSPACE_ID,
  type BriefHarness,
  type BriefHarnessOptions,
} from './helpers/brief.js';

function run(harness: BriefHarness, force = false) {
  return harness.service.generate(harness.workspaceId, harness.prId, {
    force,
    logger: harness.logger,
  });
}

function generate(opts: BriefHarnessOptions = {}, force = false) {
  const harness = buildBriefHarness(opts);
  return run(harness, force).then((record) => ({ harness, record }));
}

const STORED_BRIEF: Brief = {
  what: 'stored what',
  why: 'stored why',
  risk_level: 'low',
  risks: [],
  review_focus: [],
  degraded: false,
  missing_inputs: [],
};

describe('BriefService.generate — the happy path', () => {
  it('returns an envelope that parses against PrBriefRecord (AC-01)', async () => {
    const { record } = await generate();
    const parsed = PrBriefRecord.parse(record);
    expect(parsed.pr_id).toBe(PR_ID);
    expect(parsed.head_sha).toBe(HEAD_SHA);
    expect(parsed.pr_head_sha).toBe(HEAD_SHA);
    expect(parsed.brief.what).toBe(DEFAULT_DRAFT.what);
    expect(parsed.model).toBe('gpt-4.1');
  });

  it('calls each input source exactly once (AC-02)', async () => {
    const { harness } = await generate({ docs: { 'specs/a.md': 'Spec A.' } });
    expect(harness.calls.getFiles).toBe(1);
    expect(harness.calls.getIntent).toBe(1);
    expect(harness.calls.blast).toBe(1);
    expect(harness.calls.smartDiff).toBe(1);
    expect(harness.calls.getSearchRoots).toBe(1);
    expect(harness.calls.docsList).toBe(1);
    expect(harness.calls.docsRead).toBe(1);
  });

  it('never puts a diff hunk body in the prompt (AC-03)', async () => {
    const { harness } = await generate();
    const prompt = harness.userPrompt() ?? '';
    expect(prompt).toContain('src/orders.ts');
    expect(prompt).not.toContain('PATCH_BODY_');
  });

  it('makes exactly one structured call, with the bounds the spec fixes (AC-04, AC-05, AC-NF-10)', async () => {
    const { harness } = await generate();
    expect(harness.structuredCalls()).toBe(1);

    const req = harness.llm.calls[0]?.req as StructuredRequest<unknown>;
    expect(req.schemaName).toBe(BRIEF_SCHEMA_NAME);
    expect(req.maxTokens).toBe(BRIEF_MAX_TOKENS);
    expect(BRIEF_MAX_TOKENS).toBe(1_500);
    expect(req.timeoutMs).toBe(BRIEF_TIMEOUT_MS);
    expect(BRIEF_TIMEOUT_MS).toBe(60_000);
  });

  it('persists exactly once, after the gate (AC-10)', async () => {
    const { harness, record } = await generate();
    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]?.headSha).toBe(HEAD_SHA);
    expect(harness.saved[0]?.brief).toEqual(record.brief);
  });
});

describe('BriefService.generate — grounding', () => {
  it('grounds against the PR’s full changed-path list, not Smart Diff’s (AC-06)', async () => {
    // Smart Diff classifies NOTHING here. A risk citing `src/retry.ts` — a real
    // changed file the classifier omitted — must still survive; grounding
    // against the classifier's output would drop it, and the reviewer would
    // never see that it happened.
    const { record } = await generate({
      draft: {
        ...DEFAULT_DRAFT,
        risks: [
          {
            ...DEFAULT_DRAFT.risks[0],
            file_refs: ['src/retry.ts', 'src/invented.ts'],
          },
        ],
      },
    });

    expect(record.brief.risks).toHaveLength(1);
    expect(record.brief.risks[0]?.file_refs).toEqual(['src/retry.ts']);
  });

  it('drops a review-focus item naming a file outside the inputs (AC-07)', async () => {
    const { record } = await generate({
      draft: {
        ...DEFAULT_DRAFT,
        review_focus: [
          { file: 'src/orders.ts', line: 12, reason: 'keep' },
          { file: 'src/ghost.ts', line: 1, reason: 'drop' },
        ],
      },
    });

    expect(record.brief.review_focus.map((f) => f.file)).toEqual(['src/orders.ts']);
  });

  it('drops a risk citing an endpoint the blast summary does not have (AC-08)', async () => {
    // `file_refs` are ALL valid and `endpoint_refs` is stubbed explicitly —
    // without the stub the filtering branch never runs and this proves nothing.
    const { harness, record } = await generate({
      draft: {
        ...DEFAULT_DRAFT,
        risks: [
          {
            ...DEFAULT_DRAFT.risks[0],
            file_refs: ['src/orders.ts'],
            endpoint_refs: ['POST /nonexistent'],
          },
        ],
      },
    });

    expect(record.brief.risks).toEqual([]);
    const logged = harness.logs.at(-1)?.obj as { dropped: { target: string; ref: string }[] };
    expect(logged.dropped).toContainEqual(
      expect.objectContaining({ target: 'endpoint_ref', ref: 'POST /nonexistent' }),
    );
    expect(logged.dropped.some((d) => d.target === 'risk')).toBe(true);
  });

  it('discards the model’s risk level and recomputes it from the survivors (AC-30)', async () => {
    // The stub contradicts the computed answer in the direction the model would
    // benefit from: it claims `none` while a `high` risk survives. A stub that
    // merely disagreed downward could not distinguish "recomputed" from
    // "coincidentally overridden".
    const { record } = await generate({
      draft: {
        ...DEFAULT_DRAFT,
        risks: [{ ...DEFAULT_DRAFT.risks[0], severity: 'high', file_refs: ['src/orders.ts'] }],
        risk_level: 'none',
      },
    });

    expect(record.brief.risks).toHaveLength(1);
    expect(record.brief.risk_level).toBe('high');
  });

  it('reports `none` when no risk survives grounding (AC-31)', async () => {
    const { record } = await generate({
      draft: {
        ...DEFAULT_DRAFT,
        risks: [{ ...DEFAULT_DRAFT.risks[0], file_refs: ['not/a/file.ts'] }],
        risk_level: 'high',
      },
    });

    expect(record.brief.risks).toEqual([]);
    expect(record.brief.risk_level).toBe('none');
  });
});

describe('BriefService.generate — caching and cost', () => {
  it('returns the stored brief at the same head SHA without a model call (AC-11)', async () => {
    const harness = buildBriefHarness({
      stored: { brief: STORED_BRIEF, headSha: HEAD_SHA, model: 'gpt-4.1' },
    });
    const record = await run(harness);

    expect(harness.structuredCalls()).toBe(0);
    expect(harness.saved).toHaveLength(0);
    expect(record.brief.what).toBe('stored what');
  });

  it('regenerates on force, adding exactly one model call (AC-12)', async () => {
    const harness = buildBriefHarness({
      stored: { brief: STORED_BRIEF, headSha: HEAD_SHA, model: 'gpt-4.1' },
    });
    await run(harness);
    expect(harness.structuredCalls()).toBe(0);

    const record = await run(harness, true);
    expect(harness.structuredCalls()).toBe(1);
    expect(harness.saved).toHaveLength(1);
    expect(record.brief.what).toBe(DEFAULT_DRAFT.what);
  });

  it('returns both head SHAs on a stale hit, and does NOT regenerate (AC-40)', async () => {
    const harness = buildBriefHarness({
      stored: { brief: STORED_BRIEF, headSha: 'oldersha', model: 'gpt-4.1' },
    });
    const stale = await harness.service.get(WORKSPACE_ID, PR_ID);

    expect(stale?.head_sha).toBe('oldersha');
    expect(stale?.pr_head_sha).toBe(HEAD_SHA);
    expect(harness.structuredCalls()).toBe(0);
  });

  it('costs nothing at all for a PR with no changed files (AC-14)', async () => {
    const harness = buildBriefHarness({ files: [] });
    const record = await run(harness);

    expect(harness.structuredCalls()).toBe(0);
    // The early return is a cost guard, so proving nothing was GATHERED is the
    // point — not merely that no model call happened.
    expect(harness.calls.blast).toBe(0);
    expect(harness.calls.smartDiff).toBe(0);
    expect(harness.calls.docsList).toBe(0);
    expect(harness.calls.getIntent).toBe(0);
    expect(PrBriefRecord.parse(record).brief.risks).toEqual([]);
  });

  it('leaves a persisted brief intact when the model call fails (AC-15)', async () => {
    const harness = buildBriefHarness({
      stored: { brief: STORED_BRIEF, headSha: 'oldersha', model: 'gpt-4.1' },
      llmError: new Error('provider exploded'),
    });

    await expect(run(harness)).rejects.toThrow('provider exploded');
    expect(harness.saved).toEqual([]);
    expect(harness.row()?.brief.what).toBe('stored what');
  });
});

describe('BriefService — tenancy and side effects', () => {
  it('404s an unknown PR and a PR in another workspace (AC-13, AC-NF-01)', async () => {
    const harness = buildBriefHarness();
    await expect(
      harness.service.generate(WORKSPACE_ID, 'ffffffff-0000-4000-8000-00000000000f', {
        force: false,
        logger: harness.logger,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(harness.service.get('another-workspace', PR_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(harness.structuredCalls()).toBe(0);
  });

  it('writes no review, findings or agent run (AC-26)', async () => {
    const { harness } = await generate();
    expect(harness.calls.insertReview).toBe(0);
    expect(harness.calls.insertFindings).toBe(0);
    expect(harness.calls.createAgentRun).toBe(0);
    expect(harness.calls.reviewRunner).toBe(0);
  });

  it('never triggers an intent classification (AC-29)', async () => {
    // No `pr_intent` row at all: the brief still makes exactly one model call.
    const { harness } = await generate();
    expect(harness.calls.intentGetOrClassify).toBe(0);
    expect(harness.structuredCalls()).toBe(1);
  });
});

describe('BriefService — degradation', () => {
  it('names an absent intent record and marks the brief degraded (AC-32)', async () => {
    const { record } = await generate();
    expect(record.brief.degraded).toBe(true);
    expect(record.brief.missing_inputs).toContainEqual({ kind: 'intent', status: 'absent' });
  });

  it('propagates a degraded blast panel (AC-32)', async () => {
    const { record } = await generate({
      intent: undefined,
      blast: { ...EMPTY_BLAST, degraded: true },
    });
    expect(record.brief.missing_inputs).toContainEqual({ kind: 'blast', status: 'degraded' });
  });

  it('records an unreachable Smart Diff rather than failing (AC-32)', async () => {
    const { record } = await generate({ smartDiff: new Error('no files persisted') });
    expect(record.brief.missing_inputs).toContainEqual({ kind: 'smart_diff', status: 'unreachable' });
  });

  it('survives a getSearchRoots that throws, and still returns a brief (AC-32)', async () => {
    // `getSearchRoots` sits INSIDE the document step's try — unwrapped, its
    // throw would fail the whole generate and break the best-effort contract.
    const { record, harness } = await generate({ searchRoots: new Error('db hiccup') });
    expect(record.brief.missing_inputs).toContainEqual({
      kind: 'project_context',
      status: 'unreachable',
    });
    expect(harness.calls.docsList).toBe(0);
    expect(harness.structuredCalls()).toBe(1);
  });

  it('is NOT degraded when the repository simply has no spec documents (AC-36)', async () => {
    const { record } = await generate({
      intent: {
        pr_id: PR_ID,
        intent: 'Make order creation idempotent.',
        in_scope: [],
        out_of_scope: [],
        risk_areas: [],
        confidence: 0.9,
        sources: [{ kind: 'linked_issue', ref: '#123', status: 'included', chars: 12 }],
        missing_context: false,
        model: 'gpt-4.1',
        head_sha: HEAD_SHA,
        classified_at: '2026-08-29T00:00:00.000Z',
      },
      docs: {},
    });

    expect(record.brief.missing_inputs).toEqual([]);
    expect(record.brief.degraded).toBe(false);
  });
});

describe('BriefService — document selection (AC-35)', () => {
  it('includes at most 6 spec documents, path-ordered, and no other type', async () => {
    const docs: Record<string, string> = { 'docs/architecture.md': 'ARCHITECTURE_DOC_BODY' };
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      docs[`specs/${name}.md`] = `SPEC_BODY_${name.toUpperCase()}`;
    }

    const { harness } = await generate({ docs });
    const prompt = harness.userPrompt() ?? '';

    expect(harness.calls.docsRead).toBe(6);
    expect(prompt).toContain('SPEC_BODY_A');
    expect(prompt).toContain('SPEC_BODY_F');
    expect(prompt).not.toContain('SPEC_BODY_G');
    expect(prompt).not.toContain('ARCHITECTURE_DOC_BODY');
  });

  it('truncates an over-cap set by whole documents', async () => {
    const big = 'x'.repeat(7_000);
    const { harness } = await generate({
      docs: { 'specs/a.md': `A_${big}`, 'specs/b.md': `B_${big}` },
    });

    // The second document would cross the combined 12,000-character cap, so it
    // is omitted whole rather than cut short.
    expect(harness.calls.docsRead).toBe(1);
    expect(harness.userPrompt()).toContain('specs/a.md');
    expect(harness.userPrompt()).not.toContain('specs/b.md');
  });
});

describe('BriefService — budget (AC-NF-04)', () => {
  it('drops the whole Project context block and truncates nothing', async () => {
    const body = 'B'.repeat(20_000);
    const { harness, record } = await generate({
      pull: { body },
      docs: { 'specs/a.md': `SPEC_SENTINEL_${'d'.repeat(10_000)}` },
    });

    const prompt = harness.userPrompt() ?? '';
    expect(prompt).not.toContain('## Project context');
    expect(prompt).not.toContain('SPEC_SENTINEL_');
    // The surviving sections are whole: the 20,000-character body is all there.
    expect(prompt).toContain(body);
    expect(record.brief.what).toBe(DEFAULT_DRAFT.what);
    // A budget drop is not a missing input — the document was available.
    expect(record.brief.missing_inputs).not.toContainEqual(
      expect.objectContaining({ kind: 'project_context' }),
    );
    const logged = harness.logs.at(-1)?.obj as { dropped_section_priorities: number[] };
    expect(logged.dropped_section_priorities).toContain(8);
  });
});

describe('BriefService — model resolution (AC-NF-03, AC-NF-11)', () => {
  it('falls back to the registered risk_brief default', async () => {
    const { harness } = await generate();
    const req = harness.llm.calls[0]?.req as StructuredRequest<unknown>;
    expect(harness.providerIds).toEqual(['openai']);
    expect(req.model).toBe('gpt-4.1');
  });

  it('honours a workspace override', async () => {
    const { harness } = await generate({
      settings: [
        { key: 'feature_models', value: { risk_brief: { provider: 'anthropic', model: 'claude-x' } } },
      ],
    });
    const req = harness.llm.calls[0]?.req as StructuredRequest<unknown>;
    expect(harness.providerIds).toEqual(['anthropic']);
    expect(req.model).toBe('claude-x');
  });

  it('pins the registry entry and the enum’s five members (AC-NF-11)', () => {
    expect(FeatureModelId.options).toEqual([
      'onboarding',
      'review_intent',
      'risk_brief',
      'conformance',
      'conventions',
    ]);
    const entry = FEATURE_MODELS.find((f) => f.id === 'risk_brief');
    expect(entry?.defaultProvider).toBe('openai');
    expect(entry?.defaultModel).toBe('gpt-4.1');
  });
});

describe('BriefService — the generation log line (AC-NF-05, AC-09, AC-NF-02)', () => {
  it('records the model, token counts, cost and every drop, with reasons', async () => {
    const { harness } = await generate({
      draft: {
        ...DEFAULT_DRAFT,
        risks: [
          { ...DEFAULT_DRAFT.risks[0], file_refs: ['src/orders.ts', 'src/invented.ts'] },
        ],
        review_focus: [{ file: 'src/ghost.ts', line: 1, reason: 'invented' }],
      },
    });

    const line = harness.logs.at(-1);
    expect(line?.msg).toBe('brief: generated');
    const obj = line?.obj as {
      feature: string;
      model: string;
      provider: string;
      tokens_in: number;
      tokens_out: number;
      cost_usd: number;
      dropped: { target: string; ref: string; reason: string }[];
      sections: { section: string; chars: number }[];
    };

    expect(obj.feature).toBe('risk_brief');
    expect(obj.model).toBe('gpt-4.1');
    expect(obj.provider).toBe('openai');
    expect(obj.tokens_in).toBeGreaterThan(0);
    expect(obj.tokens_out).toBeGreaterThan(0);
    expect(obj.cost_usd).toBeGreaterThan(0);

    // Full records, not counts: a count says something was caught but not what.
    expect(obj.dropped).toContainEqual({
      target: 'file_ref',
      ref: 'src/invented.ts',
      reason: expect.any(String),
    });
    expect(obj.dropped).toContainEqual({
      target: 'review_focus',
      ref: 'src/ghost.ts',
      reason: expect.any(String),
    });
    expect(obj.sections.map((s) => s.section)).toContain('system');
  });

  it('emits no section text, PR body, issue text or document content (AC-NF-02)', async () => {
    const { harness } = await generate({
      pull: { body: 'PR_BODY_SENTINEL' },
      docs: { 'specs/a.md': 'DOCUMENT_SENTINEL' },
      draft: { ...DEFAULT_DRAFT, what: 'MODEL_OUTPUT_SENTINEL' },
      intent: {
        pr_id: PR_ID,
        intent: 'INTENT_SENTINEL',
        in_scope: [],
        out_of_scope: [],
        risk_areas: [],
        confidence: 0.9,
        sources: [{ kind: 'linked_issue', ref: '#123', status: 'included', chars: 12 }],
        missing_context: false,
        model: 'gpt-4.1',
        head_sha: HEAD_SHA,
        classified_at: '2026-08-29T00:00:00.000Z',
      },
    });

    const serialized = JSON.stringify(harness.logs);
    expect(serialized).not.toContain('PR_BODY_SENTINEL');
    expect(serialized).not.toContain('DOCUMENT_SENTINEL');
    expect(serialized).not.toContain('MODEL_OUTPUT_SENTINEL');
    expect(serialized).not.toContain('INTENT_SENTINEL');
    expect(serialized).not.toContain('## Pull request');
  });
});
