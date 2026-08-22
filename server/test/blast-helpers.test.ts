/**
 * Blast mappers (`modules/blast/helpers.ts`) — caller grouping, facts
 * attribution, the degraded path, the summary string, and the history
 * mapping. Pure: no DB, no mocks.
 */
import { describe, it, expect } from 'vitest';
import { buildBlastRadius, buildHistory } from '../src/modules/blast/helpers.js';
import type { BlastResult } from '../src/modules/repo-intel/types.js';
import type { BlastHistoryPull } from '../src/modules/blast/types.js';

function result(over: Partial<BlastResult> = {}): BlastResult {
  return {
    changedSymbols: [],
    callers: [],
    impactedEndpoints: [],
    ...over,
  };
}

describe('buildBlastRadius — grouping', () => {
  it('lands every caller row under exactly one downstream entry keyed by viaSymbol, entry order = first appearance', () => {
    const out = buildBlastRadius(
      result({
        changedSymbols: [
          { name: 'parseDiff', file: 'src/diff.ts', kind: 'function' },
          { name: 'applyDiff', file: 'src/diff.ts', kind: 'function' },
        ],
        callers: [
          { file: 'src/a.ts', symbol: 'runA', viaSymbol: 'parseDiff', line: 10, rank: 1 },
          { file: 'src/b.ts', symbol: 'runB', viaSymbol: 'applyDiff', line: 20, rank: 2 },
          { file: 'src/c.ts', symbol: 'runC', viaSymbol: 'parseDiff', line: 30, rank: 3 },
        ],
        factsByFile: {},
      }),
    );

    expect(out.downstream.map((d) => d.symbol)).toEqual(['parseDiff', 'applyDiff']);
    expect(out.downstream[0]!.callers).toEqual([
      { name: 'runA', file: 'src/a.ts', line: 10 },
      { name: 'runC', file: 'src/c.ts', line: 30 },
    ]);
    expect(out.downstream[1]!.callers).toEqual([{ name: 'runB', file: 'src/b.ts', line: 20 }]);
    const total = out.downstream.reduce((n, d) => n + d.callers.length, 0);
    expect(total).toBe(3); // every row lands exactly once
    expect(out.changed_symbols).toEqual([
      { name: 'parseDiff', file: 'src/diff.ts', kind: 'function' },
      { name: 'applyDiff', file: 'src/diff.ts', kind: 'function' },
    ]);
  });
});

describe('buildBlastRadius — facts attribution', () => {
  it('unions endpoints/crons per entry from factsByFile keyed by caller file, de-duped', () => {
    const out = buildBlastRadius(
      result({
        changedSymbols: [{ name: 's', file: 'src/s.ts', kind: 'function' }],
        callers: [
          { file: 'src/routes-a.ts', symbol: 'a1', viaSymbol: 's', line: 1, rank: 1 },
          { file: 'src/routes-a.ts', symbol: 'a2', viaSymbol: 's', line: 2, rank: 2 },
          { file: 'src/jobs.ts', symbol: 'j', viaSymbol: 's', line: 3, rank: 3 },
          { file: 'src/other.ts', symbol: 'o', viaSymbol: 'other', line: 4, rank: 4 },
        ],
        factsByFile: {
          'src/routes-a.ts': { endpoints: ['GET /a', 'POST /a'], crons: [] },
          'src/jobs.ts': { endpoints: ['GET /a'], crons: ['nightly-sync'] },
        },
      }),
    );

    const first = out.downstream[0]!;
    // de-duped across the two caller rows sharing src/routes-a.ts + the jobs file
    expect(first.endpoints_affected).toEqual(['GET /a', 'POST /a']);
    expect(first.crons_affected).toEqual(['nightly-sync']);
    // caller file with no facts entry contributes nothing
    expect(out.downstream[1]!.endpoints_affected).toEqual([]);
    expect(out.downstream[1]!.crons_affected).toEqual([]);
  });
});

describe('buildBlastRadius — degraded path', () => {
  it('attaches the flat impactedEndpoints union to the FIRST entry only; all crons stay empty', () => {
    const out = buildBlastRadius(
      result({
        changedSymbols: [{ name: 's', file: 'src/s.ts', kind: 'function' }],
        callers: [
          { file: 'src/a.ts', symbol: 'a', viaSymbol: 's', line: 1, rank: 0 },
          { file: 'src/b.ts', symbol: 'b', viaSymbol: 't', line: 2, rank: 0 },
        ],
        impactedEndpoints: ['GET /x', 'GET /x', 'POST /y'],
        degraded: true,
      }),
    );

    expect(out.downstream[0]!.endpoints_affected).toEqual(['GET /x', 'POST /y']);
    expect(out.downstream[1]!.endpoints_affected).toEqual([]);
    expect(out.downstream.every((d) => d.crons_affected.length === 0)).toBe(true);
  });

  it('is a no-op when downstream is empty', () => {
    const out = buildBlastRadius(result({ impactedEndpoints: ['GET /x'], degraded: true }));
    expect(out.downstream).toEqual([]);
  });
});

describe('buildBlastRadius — summary', () => {
  it('joins four count segments with singular/plural', () => {
    const callers = Array.from({ length: 14 }, (_, i) => ({
      file: `src/f${i % 4}.ts`,
      symbol: `c${i}`,
      viaSymbol: i % 2 === 0 ? 'alpha' : 'beta',
      line: i + 1,
      rank: i,
    }));
    const out = buildBlastRadius(
      result({
        changedSymbols: [
          { name: 'alpha', file: 'src/x.ts', kind: 'function' },
          { name: 'beta', file: 'src/x.ts', kind: 'function' },
        ],
        callers,
        factsByFile: {
          'src/f0.ts': { endpoints: ['GET /1', 'GET /2'], crons: ['daily'] },
          'src/f1.ts': { endpoints: ['GET /3'], crons: ['daily'] },
        },
      }),
    );
    expect(out.summary).toBe('2 symbols · 14 callers · 3 endpoints · 1 cron');
  });

  it('pluralizes the empty result', () => {
    expect(buildBlastRadius(result()).summary).toBe(
      '0 symbols · 0 callers · 0 endpoints · 0 crons',
    );
  });
});

describe('buildHistory', () => {
  function pull(over: Partial<BlastHistoryPull> = {}): BlastHistoryPull {
    return {
      number: 7,
      title: 'Fix the widget',
      author: 'octocat',
      status: 'merged',
      updatedAt: new Date('2026-08-01T12:00:00.000Z'),
      ...over,
    };
  }

  it('derives merged_at from updatedAt for merged AND non-merged rows alike', () => {
    const { history } = buildHistory([
      { pull: pull(), overlap: ['src/a.ts', 'src/b.ts'] },
      {
        pull: pull({ number: 8, status: 'open', updatedAt: new Date('2026-08-02T00:00:00.000Z') }),
        overlap: ['src/a.ts'],
      },
    ]);

    expect(history).toEqual([
      {
        pr_number: 7,
        title: 'Fix the widget',
        author: 'octocat',
        merged_at: '2026-08-01T12:00:00.000Z',
        files_overlap: ['src/a.ts', 'src/b.ts'],
        notes: '',
      },
      {
        pr_number: 8,
        title: 'Fix the widget',
        author: 'octocat',
        merged_at: '2026-08-02T00:00:00.000Z',
        files_overlap: ['src/a.ts'],
        notes: '',
      },
    ]);
  });

  it("falls back to '' when updatedAt is null (non-nullable contract string)", () => {
    const { history } = buildHistory([{ pull: pull({ updatedAt: null }), overlap: [] }]);
    expect(history[0]!.merged_at).toBe('');
  });
});
