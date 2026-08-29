/**
 * The brief's pure core: the grounding gate and the module's rules. NO mocks —
 * `grounding.ts` and `helpers.ts` are functions over fixtures, which is the
 * property that makes "if a test here needs a mock, the code under test is not
 * core" checkable rather than aspirational.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectContextDoc, Risk } from '@devdigest/shared';
import { groundBrief, type BriefGroundingDraft } from '../src/modules/brief/grounding.js';
import {
  computeRiskLevel,
  fitToBudget,
  selectSpecDocs,
  toDegraded,
  toMissingInputs,
} from '../src/modules/brief/helpers.js';
import {
  BRIEF_MAX_INPUT_CHARS,
  BRIEF_MAX_SPEC_DOCS,
  BRIEF_MAX_SPEC_DOC_CHARS,
} from '../src/modules/brief/constants.js';

const FILES = new Set(['src/a.ts', 'src/b.ts']);
const ENDPOINTS = new Set(['POST /orders', 'GET /orders/:id']);

function draft(over: Partial<BriefGroundingDraft> = {}): BriefGroundingDraft {
  return { risks: [], review_focus: [], ...over };
}

function risk(over: Partial<BriefGroundingDraft['risks'][number]> = {}) {
  return {
    kind: 'regression',
    title: 'Order creation may double-charge',
    explanation: 'The retry path is not idempotent.',
    file_refs: ['src/a.ts'],
    endpoint_refs: [] as string[],
    severity: 'high' as const,
    ...over,
  };
}

describe('groundBrief', () => {
  it('strips an invented file_ref and records the drop (AC-06, AC-09)', () => {
    const result = groundBrief(
      draft({ risks: [risk({ file_refs: ['src/a.ts', 'src/invented.ts'] })] }),
      { files: FILES, endpoints: ENDPOINTS },
    );

    expect(result.risks).toHaveLength(1);
    expect(result.risks[0]?.file_refs).toEqual(['src/a.ts']);
    expect(result.dropped).toContainEqual({
      target: 'file_ref',
      ref: 'src/invented.ts',
      reason: expect.any(String),
    });
  });

  it('drops a risk citing only invented paths, and records both (AC-09, AC-31)', () => {
    const result = groundBrief(
      draft({ risks: [risk({ file_refs: ['nope/one.ts', 'nope/two.ts'] })] }),
      { files: FILES, endpoints: ENDPOINTS },
    );

    expect(result.risks).toEqual([]);
    expect(result.dropped.filter((d) => d.target === 'file_ref')).toHaveLength(2);
    // Identified by ordinal, never by title — the record reaches the log.
    expect(result.dropped).toContainEqual({
      target: 'risk',
      ref: 'risk#0',
      reason: expect.any(String),
    });
    expect(JSON.stringify(result.dropped)).not.toContain('double-charge');
  });

  it('drops a review-focus item naming a file outside the inputs (AC-07, AC-44)', () => {
    const result = groundBrief(
      draft({
        review_focus: [
          { file: 'src/b.ts', line: 12, reason: 'new retry loop' },
          { file: 'src/ghost.ts', line: 3, reason: 'invented' },
        ],
      }),
      { files: FILES, endpoints: ENDPOINTS },
    );

    expect(result.reviewFocus).toEqual([{ file: 'src/b.ts', line: 12, reason: 'new retry loop' }]);
    expect(result.dropped).toContainEqual({
      target: 'review_focus',
      ref: 'src/ghost.ts',
      reason: expect.any(String),
    });
  });

  // The draft schema types `reason` as a bare string while the wire shape is
  // `.min(1)`. An empty reason that survived the gate would be persisted and
  // then rejected by `Brief.parse` on read-back — a 500 and a row no `GET`
  // could parse. The gate has to drop it, not pass it through.
  it('drops a review-focus item whose reason is empty, even on a real file (AC-44)', () => {
    const result = groundBrief(
      draft({
        review_focus: [
          { file: 'src/a.ts', line: 1, reason: '   ' },
          { file: 'src/b.ts', line: 12, reason: 'new retry loop' },
        ],
      }),
      { files: FILES, endpoints: ENDPOINTS },
    );

    expect(result.reviewFocus).toEqual([{ file: 'src/b.ts', line: 12, reason: 'new retry loop' }]);
    expect(result.dropped).toContainEqual({
      target: 'review_focus',
      ref: 'src/a.ts',
      reason: expect.any(String),
    });
    // Everything that survives must satisfy the wire contract.
    for (const item of result.reviewFocus) expect(item.reason.length).toBeGreaterThan(0);
  });

  it('removes an endpoint_ref absent from the blast set and drops the risk with it (AC-08)', () => {
    // The file_refs here are ALL valid: without an explicitly stubbed
    // `endpoint_refs` the filtering branch never runs and this test would prove
    // nothing about AC-08.
    const result = groundBrief(
      draft({ risks: [risk({ file_refs: ['src/a.ts'], endpoint_refs: ['POST /nonexistent'] })] }),
      { files: FILES, endpoints: ENDPOINTS },
    );

    expect(result.dropped).toContainEqual({
      target: 'endpoint_ref',
      ref: 'POST /nonexistent',
      reason: expect.any(String),
    });
    expect(result.risks).toEqual([]);
    expect(result.dropped.some((d) => d.target === 'risk')).toBe(true);
  });

  it('keeps a risk whose endpoint_refs are all real', () => {
    const result = groundBrief(
      draft({ risks: [risk({ endpoint_refs: ['POST /orders'] })] }),
      { files: FILES, endpoints: ENDPOINTS },
    );

    expect(result.risks).toHaveLength(1);
    // `endpoint_refs` is draft-only evidence and never reaches the wire Risk.
    expect(result.risks[0]).not.toHaveProperty('endpoint_refs');
    expect(result.dropped).toEqual([]);
  });
});

describe('computeRiskLevel', () => {
  const at = (severity: Risk['severity']): Risk => ({
    kind: 'k',
    title: 't',
    explanation: 'e',
    severity,
    file_refs: ['src/a.ts'],
  });

  // The function takes no `risk_level` argument at all — the STRUCTURAL half of
  // AC-30. The "the model's value is discarded" half is asserted at the service
  // ring in brief-service.test.ts.
  it('is the maximum severity over the surviving risks (AC-30)', () => {
    expect(computeRiskLevel([at('high'), at('low')])).toBe('high');
    expect(computeRiskLevel([at('low'), at('medium')])).toBe('medium');
    expect(computeRiskLevel([at('low')])).toBe('low');
  });

  it('is none when nothing survives (AC-31)', () => {
    expect(computeRiskLevel([])).toBe('none');
  });
});

describe('selectSpecDocs', () => {
  const doc = (path: string, type: string, bytes = 100): ProjectContextDoc => ({
    path,
    type,
    bytes,
  });

  it('keeps only type=spec, path-ordered (AC-35)', () => {
    const kept = selectSpecDocs([
      doc('docs/architecture.md', 'doc'),
      doc('specs/b.md', 'spec'),
      doc('insights/x.md', 'insight'),
      doc('specs/a.md', 'spec'),
    ]);
    expect(kept.map((d) => d.path)).toEqual(['specs/a.md', 'specs/b.md']);
  });

  it('excludes the 7th spec document (AC-35)', () => {
    const docs = Array.from({ length: 7 }, (_, i) => doc(`specs/${i}.md`, 'spec'));
    const kept = selectSpecDocs(docs);
    expect(kept).toHaveLength(BRIEF_MAX_SPEC_DOCS);
    expect(kept.map((d) => d.path)).not.toContain('specs/6.md');
  });

  it('truncates an over-cap set by WHOLE documents (AC-35)', () => {
    const big = Math.floor(BRIEF_MAX_SPEC_DOC_CHARS / 2) + 1;
    const kept = selectSpecDocs([
      doc('specs/a.md', 'spec', big),
      doc('specs/b.md', 'spec', big),
      doc('specs/c.md', 'spec', 10),
    ]);
    // b would cross the combined cap, so it and everything after it is omitted;
    // no document is ever included in part.
    expect(kept.map((d) => d.path)).toEqual(['specs/a.md']);
    expect(kept[0]?.bytes).toBe(big);
  });

  it('returns nothing, and no error, for a repository with no specs (AC-36)', () => {
    expect(selectSpecDocs([doc('docs/only.md', 'doc')])).toEqual([]);
  });
});

describe('fitToBudget', () => {
  const section = (priority: number, chars: number) => ({
    priority,
    text: 'x'.repeat(chars),
  });

  it('drops whole sections lowest-priority-first until it fits (AC-NF-04)', () => {
    const sections = [
      section(1, 4_000),
      section(2, 6_000),
      section(3, 6_000),
      section(4, 6_000),
      section(5, 6_000),
      section(6, 6_000),
      section(7, 6_000),
      section(8, 6_000),
    ];

    const { kept, droppedPriorities } = fitToBudget(sections);

    // Project context (8) first, then history (7), then the downstream detail.
    expect(droppedPriorities).toEqual([8, 7, 6, 5]);
    expect(kept.map((s) => s.priority)).toEqual([1, 2, 3, 4]);
    // Nothing was truncated: every kept section is its original length.
    expect(kept.map((s) => s.text.length)).toEqual([4_000, 6_000, 6_000, 6_000]);
    expect(kept.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(BRIEF_MAX_INPUT_CHARS);
  });

  it('never drops priority 1, and never fails, even when it alone is oversized', () => {
    const { kept, droppedPriorities } = fitToBudget([
      section(1, BRIEF_MAX_INPUT_CHARS + 1_000),
      section(8, 5_000),
    ]);
    expect(kept.map((s) => s.priority)).toEqual([1]);
    expect(kept[0]?.text.length).toBe(BRIEF_MAX_INPUT_CHARS + 1_000);
    expect(droppedPriorities).toEqual([8]);
  });

  it('leaves an already-fitting set untouched', () => {
    const sections = [section(1, 10), section(8, 10)];
    expect(fitToBudget(sections).kept).toEqual(sections);
    expect(fitToBudget(sections).droppedPriorities).toEqual([]);
  });
});

describe('missing-input ledger', () => {
  it('de-duplicates by kind and drives `degraded` (AC-32)', () => {
    const missing = toMissingInputs([
      { kind: 'intent', status: 'absent' },
      { kind: 'intent', status: 'unreachable' },
      { kind: 'blast', status: 'degraded' },
    ]);
    expect(missing).toEqual([
      { kind: 'intent', status: 'absent' },
      { kind: 'blast', status: 'degraded' },
    ]);
    expect(toDegraded(missing)).toBe(true);
  });

  it('is empty — and not degraded — when every input was available (AC-36)', () => {
    expect(toMissingInputs([])).toEqual([]);
    expect(toDegraded([])).toBe(false);
  });
});
