/**
 * Smart Diff builder (`modules/smart-diff/helpers.ts`) — group order, sort
 * rules, the findings overlay, and the split suggestion. Pure: no DB.
 */
import { describe, it, expect } from 'vitest';
import { buildSmartDiff, pickLatestFindings } from '../src/modules/smart-diff/helpers.js';
import type { SmartDiffFindingInput, SmartDiffPrFile, SmartDiffReviewInput } from '../src/modules/smart-diff/types.js';

function finding(over: Partial<SmartDiffFindingInput> = {}): SmartDiffFindingInput {
  return {
    id: 'f1',
    file: 'src/core.ts',
    startLine: 10,
    endLine: 10,
    severity: 'WARNING',
    title: 'Some finding',
    ...over,
  };
}

describe('pickLatestFindings', () => {
  it("keeps each agent's latest kind:'review', unions their findings (input newest-first)", () => {
    const reviews: SmartDiffReviewInput[] = [
      { review: { kind: 'review', agentId: 'agentB' }, findings: [finding({ id: 'b2' })] },
      { review: { kind: 'review', agentId: 'agentA' }, findings: [finding({ id: 'a2' })] },
      { review: { kind: 'review', agentId: 'agentA' }, findings: [finding({ id: 'a1' })] }, // superseded
      { review: { kind: 'review', agentId: null }, findings: [finding({ id: 'n1' })] },
    ];
    const ids = pickLatestFindings(reviews).map((f) => f.id);
    expect(ids.sort()).toEqual(['a2', 'b2', 'n1']);
  });

  it("drops kind:'summary' rows", () => {
    const reviews: SmartDiffReviewInput[] = [
      { review: { kind: 'summary', agentId: 'agentA' }, findings: [finding()] },
    ];
    expect(pickLatestFindings(reviews)).toEqual([]);
  });

  it('includes dismissed findings (they are not filtered by kind here)', () => {
    // Dismissal is a finding-row concern (acceptedAt/dismissedAt), not part of
    // this narrow input shape — the point is nothing here drops a finding for
    // any reason other than its review being superseded or not kind:review.
    const reviews: SmartDiffReviewInput[] = [
      { review: { kind: 'review', agentId: 'agentA' }, findings: [finding({ id: 'dismissed' })] },
    ];
    expect(pickLatestFindings(reviews).map((f) => f.id)).toEqual(['dismissed']);
  });
});

describe('buildSmartDiff — groups', () => {
  it('always emits all three groups, in core/wiring/boilerplate order, empty allowed', () => {
    const result = buildSmartDiff([], []);
    expect(result.groups.map((g) => g.role)).toEqual(['core', 'wiring', 'boilerplate']);
    expect(result.groups.every((g) => g.files.length === 0)).toBe(true);
  });

  it('classifies files into their groups', () => {
    const files: SmartDiffPrFile[] = [
      { path: 'src/core.ts', additions: 5, deletions: 0 },
      { path: 'package.json', additions: 1, deletions: 0 },
      { path: 'pnpm-lock.yaml', additions: 100, deletions: 0 },
    ];
    const result = buildSmartDiff(files, []);
    expect(result.groups.find((g) => g.role === 'core')!.files.map((f) => f.path)).toEqual([
      'src/core.ts',
    ]);
    expect(result.groups.find((g) => g.role === 'wiring')!.files.map((f) => f.path)).toEqual([
      'package.json',
    ]);
    expect(
      result.groups.find((g) => g.role === 'boilerplate')!.files.map((f) => f.path),
    ).toEqual(['pnpm-lock.yaml']);
  });
});

describe('buildSmartDiff — findings overlay', () => {
  it('indexes findings by normalized path, matching a-/b--prefixed finding paths', () => {
    const files: SmartDiffPrFile[] = [{ path: 'src/core.ts', additions: 1, deletions: 0 }];
    const reviews: SmartDiffReviewInput[] = [
      {
        review: { kind: 'review', agentId: 'agentA' },
        findings: [finding({ id: 'f1', file: 'b/src/core.ts', startLine: 4, endLine: 4 })],
      },
    ];
    const result = buildSmartDiff(files, reviews);
    const file = result.groups.find((g) => g.role === 'core')!.files[0]!;
    expect(file.findings).toHaveLength(1);
    expect(file.findings[0]!.id).toBe('f1');
  });

  it('drops findings referencing a file not in the PR file list', () => {
    const files: SmartDiffPrFile[] = [{ path: 'src/core.ts', additions: 1, deletions: 0 }];
    const reviews: SmartDiffReviewInput[] = [
      {
        review: { kind: 'review', agentId: 'agentA' },
        findings: [finding({ file: 'src/other.ts' })],
      },
    ];
    const result = buildSmartDiff(files, reviews);
    expect(result.groups.flatMap((g) => g.files).flatMap((f) => f.findings)).toEqual([]);
  });

  it('finding_lines is sorted and de-duped', () => {
    const files: SmartDiffPrFile[] = [{ path: 'src/core.ts', additions: 1, deletions: 0 }];
    const reviews: SmartDiffReviewInput[] = [
      {
        review: { kind: 'review', agentId: 'agentA' },
        findings: [
          finding({ id: 'f1', startLine: 20, endLine: 20 }),
          finding({ id: 'f2', startLine: 5, endLine: 5 }),
          finding({ id: 'f3', startLine: 20, endLine: 21 }), // same start line as f1
        ],
      },
    ];
    const result = buildSmartDiff(files, reviews);
    const file = result.groups.find((g) => g.role === 'core')!.files[0]!;
    expect(file.finding_lines).toEqual([5, 20]);
    expect(file.findings).toHaveLength(3);
  });
});

describe('buildSmartDiff — sort within a group', () => {
  it('files with findings sort before files without', () => {
    const files: SmartDiffPrFile[] = [
      { path: 'src/no-findings.ts', additions: 50, deletions: 0 },
      { path: 'src/has-findings.ts', additions: 1, deletions: 0 },
    ];
    const reviews: SmartDiffReviewInput[] = [
      {
        review: { kind: 'review', agentId: 'agentA' },
        findings: [finding({ file: 'src/has-findings.ts' })],
      },
    ];
    const result = buildSmartDiff(files, reviews);
    expect(result.groups.find((g) => g.role === 'core')!.files.map((f) => f.path)).toEqual([
      'src/has-findings.ts',
      'src/no-findings.ts',
    ]);
  });

  it('among files with findings, higher max severity sorts first', () => {
    const files: SmartDiffPrFile[] = [
      { path: 'src/warning.ts', additions: 1, deletions: 0 },
      { path: 'src/critical.ts', additions: 1, deletions: 0 },
    ];
    const reviews: SmartDiffReviewInput[] = [
      {
        review: { kind: 'review', agentId: 'agentA' },
        findings: [
          finding({ id: 'w', file: 'src/warning.ts', severity: 'WARNING' }),
          finding({ id: 'c', file: 'src/critical.ts', severity: 'CRITICAL' }),
        ],
      },
    ];
    const result = buildSmartDiff(files, reviews);
    expect(result.groups.find((g) => g.role === 'core')!.files.map((f) => f.path)).toEqual([
      'src/critical.ts',
      'src/warning.ts',
    ]);
  });

  it('at equal severity, more findings sorts first', () => {
    const files: SmartDiffPrFile[] = [
      { path: 'src/one.ts', additions: 1, deletions: 0 },
      { path: 'src/two.ts', additions: 1, deletions: 0 },
    ];
    const reviews: SmartDiffReviewInput[] = [
      {
        review: { kind: 'review', agentId: 'agentA' },
        findings: [
          finding({ id: 'a', file: 'src/one.ts' }),
          finding({ id: 'b', file: 'src/two.ts' }),
          finding({ id: 'c', file: 'src/two.ts', startLine: 20, endLine: 20 }),
        ],
      },
    ];
    const result = buildSmartDiff(files, reviews);
    expect(result.groups.find((g) => g.role === 'core')!.files.map((f) => f.path)).toEqual([
      'src/two.ts',
      'src/one.ts',
    ]);
  });

  it('source sorts before tests, then higher churn first, then path ascending', () => {
    const files: SmartDiffPrFile[] = [
      { path: 'src/z.ts', additions: 1, deletions: 0 },
      { path: 'src/a.ts', additions: 1, deletions: 0 },
      { path: 'src/b.test.ts', additions: 999, deletions: 0 },
      { path: 'src/big.ts', additions: 10, deletions: 0 },
    ];
    const result = buildSmartDiff(files, []);
    expect(result.groups.find((g) => g.role === 'core')!.files.map((f) => f.path)).toEqual([
      'src/big.ts', // highest churn among non-test source files
      'src/a.ts',
      'src/z.ts',
      'src/b.test.ts', // test file, sorts last despite the largest churn
    ]);
  });

  it('is deterministic on shuffled input (path is the final tiebreak)', () => {
    const files: SmartDiffPrFile[] = [
      { path: 'src/c.ts', additions: 1, deletions: 0 },
      { path: 'src/a.ts', additions: 1, deletions: 0 },
      { path: 'src/b.ts', additions: 1, deletions: 0 },
    ];
    const shuffled = [files[2]!, files[0]!, files[1]!];
    const a = buildSmartDiff(files, []);
    const b = buildSmartDiff(shuffled, []);
    expect(a.groups.find((g) => g.role === 'core')!.files.map((f) => f.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
    expect(b.groups.find((g) => g.role === 'core')!.files.map((f) => f.path)).toEqual(
      a.groups.find((g) => g.role === 'core')!.files.map((f) => f.path),
    );
  });
});

describe('buildSmartDiff — split suggestion', () => {
  it('proposes no split under threshold', () => {
    const files: SmartDiffPrFile[] = [{ path: 'src/core.ts', additions: 10, deletions: 0 }];
    const result = buildSmartDiff(files, []);
    expect(result.split_suggestion.too_big).toBe(false);
    expect(result.split_suggestion.proposed_splits).toEqual([]);
  });

  it('flags too_big past the line threshold but proposes nothing with under SPLIT_MIN_KEYS groups', () => {
    const files: SmartDiffPrFile[] = [{ path: 'src/core.ts', additions: 500, deletions: 0 }];
    const result = buildSmartDiff(files, []);
    expect(result.split_suggestion.too_big).toBe(true);
    expect(result.split_suggestion.total_lines).toBe(500);
    expect(result.split_suggestion.proposed_splits).toEqual([]); // only 1 distinct key
  });

  it('proposes splits keyed by top path segments once over threshold with 2+ groups', () => {
    const files: SmartDiffPrFile[] = [
      { path: 'src/moduleA/one.ts', additions: 200, deletions: 0 },
      { path: 'src/moduleB/two.ts', additions: 250, deletions: 0 },
    ];
    const result = buildSmartDiff(files, []);
    expect(result.split_suggestion.too_big).toBe(true);
    expect(result.split_suggestion.proposed_splits).toEqual([
      { name: 'src/moduleA', files: ['src/moduleA/one.ts'] },
      { name: 'src/moduleB', files: ['src/moduleB/two.ts'] },
    ]);
  });

  it('excludes boilerplate files from the split calculation', () => {
    const files: SmartDiffPrFile[] = [
      { path: 'src/core.ts', additions: 10, deletions: 0 },
      { path: 'pnpm-lock.yaml', additions: 5000, deletions: 0 },
    ];
    const result = buildSmartDiff(files, []);
    expect(result.split_suggestion.too_big).toBe(false);
    expect(result.split_suggestion.total_lines).toBe(10);
  });
});
