/**
 * Pure-core eval tests — no mocks, no DB, no network (the scoring functions and
 * helpers are pure by construction). Pins the spec's normative match rule and
 * the raw-count metric formulas (AC-18..24), plus the per-call bounds and the
 * concurrency clamp (AC-NF-05).
 */
import { describe, it, expect } from 'vitest';
import type { EvalExpectation, Finding } from '@devdigest/shared';
import { groundFindings } from '@devdigest/reviewer-core';
import {
  caseDiff,
  mapWithConcurrency,
  toSkillPromptBlock,
  withCallLimits,
} from '../src/modules/eval/helpers.js';
import {
  batchMetrics,
  caseCitation,
  caseVerdict,
  matches,
} from '../src/modules/eval/scoring.js';
import type { EvalCaseOutcome } from '../src/modules/eval/types.js';
import {
  EVAL_CASE_MAX_TOKENS,
  EVAL_CASE_TIMEOUT_MS,
  EVAL_CONCURRENCY,
} from '../src/modules/eval/constants.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import { z } from 'zod';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    severity: 'CRITICAL',
    category: 'security',
    title: 'Hardcoded key',
    file: 'src/config.ts',
    start_line: 10,
    end_line: 14,
    rationale: 'because',
    suggestion: null,
    confidence: 0.9,
    ...over,
  };
}

const EXP: EvalExpectation = {
  kind: 'must_find',
  file: 'src/config.ts',
  start_line: 12,
  end_line: 20,
};

function outcome(over: Partial<EvalCaseOutcome> = {}): EvalCaseOutcome {
  return {
    model: 'gpt-4.1',
    expectation_kind: 'must_find',
    proposed: 1,
    surviving: 1,
    noise: 0,
    matched: true,
    error: null,
    findings: [],
    ...over,
  };
}

describe('matches (AC-18)', () => {
  it('overlap at exactly one shared line matches', () => {
    // Finding ends at 12, expectation starts at 12 — one shared line.
    expect(matches(finding({ start_line: 10, end_line: 12 }), EXP)).toBe(true);
  });

  it('adjacency (end_line + 1) does not match', () => {
    // Finding ends at 11, expectation starts at 12.
    expect(matches(finding({ start_line: 10, end_line: 11 }), EXP)).toBe(false);
  });

  it('another file does not match even on an identical range', () => {
    expect(matches(finding({ file: 'src/other.ts', start_line: 12, end_line: 20 }), EXP)).toBe(
      false,
    );
  });

  it('a severity/category/title mismatch on an overlapping range still matches', () => {
    const f = finding({
      severity: 'SUGGESTION',
      category: 'style',
      title: 'Completely different title',
      start_line: 15,
      end_line: 16,
    });
    expect(matches(f, EXP)).toBe(true);
  });
});

describe('caseVerdict (AC-19, AC-20)', () => {
  it('must_find passes iff at least one surviving finding matches', () => {
    expect(caseVerdict(EXP, [finding()]).pass).toBe(true);
    expect(caseVerdict(EXP, [finding({ file: 'src/other.ts' })]).pass).toBe(false);
    // Empty surviving set → the agent found nothing → fail.
    expect(caseVerdict(EXP, []).pass).toBe(false);
  });

  it('must_not_flag passes iff zero surviving findings match', () => {
    const exp: EvalExpectation = { ...EXP, kind: 'must_not_flag' };
    expect(caseVerdict(exp, []).pass).toBe(true);
    expect(caseVerdict(exp, [finding({ file: 'src/other.ts' })]).pass).toBe(true);
    expect(caseVerdict(exp, [finding()]).pass).toBe(false);
    expect(caseVerdict(exp, [finding()]).matched).toBe(1);
  });
});

describe('batchMetrics (AC-21..24, AC-27)', () => {
  it('computes recall / precision / citation from hand-computed raw counts', () => {
    const outcomes: EvalCaseOutcome[] = [
      // must_find, passed: 3 proposed, 2 survived, 0 noise.
      outcome({ proposed: 3, surviving: 2, matched: true }),
      // must_find, failed: 2 proposed, 1 survived, 0 noise.
      outcome({ proposed: 2, surviving: 1, matched: false }),
      // must_not_flag, failed (1 noise): 2 proposed, 2 survived.
      outcome({
        expectation_kind: 'must_not_flag',
        proposed: 2,
        surviving: 2,
        noise: 1,
        matched: true,
      }),
    ];
    const m = batchMetrics(outcomes);
    expect(m.recall).toBe(1 / 2); // 1 of 2 must_find passed
    expect(m.precision).toBe(1 - 1 / 5); // 1 noise over 5 surviving
    expect(m.citation_accuracy).toBe(5 / 7); // 5 surviving over 7 proposed
    expect(m.cases_total).toBe(3);
    expect(m.cases_errored).toBe(0);
    expect(m.cases_passed).toBe(1);
  });

  it('every vacuous denominator scores 1.0', () => {
    // No must_find cases → recall 1; nothing proposed → citation 1; nothing
    // survived → precision 1.
    const m = batchMetrics([
      outcome({
        expectation_kind: 'must_not_flag',
        proposed: 0,
        surviving: 0,
        noise: 0,
        matched: false,
      }),
    ]);
    expect(m.recall).toBe(1);
    expect(m.precision).toBe(1);
    expect(m.citation_accuracy).toBe(1);
    expect(m.cases_passed).toBe(1);

    // The empty batch is fully vacuous too.
    const empty = batchMetrics([]);
    expect(empty).toEqual({
      recall: 1,
      precision: 1,
      citation_accuracy: 1,
      cases_total: 0,
      cases_errored: 0,
      cases_passed: 0,
    });
  });

  it('citation accuracy is the raw-count ratio, never a mean of per-case values (AC-24)', () => {
    // Case A: 1/1 = 1.0. Case B: 5/10 = 0.5. Mean would be 0.75; the raw-count
    // answer is 6/11 ≈ 0.545.
    const outcomes = [
      outcome({ proposed: 1, surviving: 1 }),
      outcome({ proposed: 10, surviving: 5 }),
    ];
    const m = batchMetrics(outcomes);
    expect(m.citation_accuracy).toBeCloseTo(6 / 11, 10);
    expect(m.citation_accuracy).not.toBeCloseTo(0.75, 2);
    // The per-case helper agrees with each side's own number.
    expect(caseCitation(1, 1)).toBe(1);
    expect(caseCitation(5, 10)).toBe(0.5);
    expect(caseCitation(0, 0)).toBe(1);
  });

  it('an errored outcome changes no metric but increments cases_errored (AC-27)', () => {
    const executed = [
      outcome({ proposed: 3, surviving: 2, matched: true }),
      outcome({ proposed: 2, surviving: 1, matched: false }),
    ];
    const base = batchMetrics(executed);
    const withError = batchMetrics([
      ...executed,
      outcome({
        proposed: 0,
        surviving: 0,
        matched: false,
        error: 'provider timed out',
      }),
    ]);
    expect(withError.recall).toBe(base.recall);
    expect(withError.precision).toBe(base.precision);
    expect(withError.citation_accuracy).toBe(base.citation_accuracy);
    expect(withError.cases_passed).toBe(base.cases_passed);
    expect(withError.cases_errored).toBe(1);
    expect(withError.cases_total).toBe(3);
  });
});

describe('withCallLimits (AC-NF-05)', () => {
  it('injects maxTokens: 2000 and timeoutMs: 60000 into every request', async () => {
    const inner = new MockLLMProvider('openai', { structured: { ok: true } });
    const llm = withCallLimits(inner, {
      maxTokens: EVAL_CASE_MAX_TOKENS,
      timeoutMs: EVAL_CASE_TIMEOUT_MS,
    });
    await llm.completeStructured({
      model: 'gpt-4.1',
      schema: z.object({ ok: z.boolean() }),
      schemaName: 'Probe',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await llm.complete({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }] });

    const structured = inner.calls.find((c) => c.method === 'completeStructured')!
      .req as Record<string, unknown>;
    const completion = inner.calls.find((c) => c.method === 'complete')!.req as Record<
      string,
      unknown
    >;
    expect(structured.maxTokens).toBe(2000);
    expect(structured.timeoutMs).toBe(60000);
    expect(completion.maxTokens).toBe(2000);
    expect(completion.timeoutMs).toBe(60000);
    expect(llm.id).toBe(inner.id);
  });
});

describe('mapWithConcurrency (AC-NF-05)', () => {
  it('never exceeds the limit in flight and preserves order', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);
    const results = await mapWithConcurrency(items, EVAL_CONCURRENCY, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // it actually ran concurrently
    expect(results).toEqual(items.map((n) => n * 2));
  });

  it('propagates the first rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('caseDiff (AC-04, groundability)', () => {
  const PATCH = '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,';

  it('produces a UnifiedDiff the grounding gate can index', () => {
    const diff = caseDiff('src/config.ts', PATCH);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]!.path).toBe('src/config.ts');
    expect(diff.files[0]!.hunks.length).toBeGreaterThanOrEqual(1);

    const inside = finding({ start_line: 11, end_line: 11 });
    const outside = finding({ id: 'f2', start_line: 99, end_line: 99 });
    const result = groundFindings([inside, outside], diff);
    expect(result.kept.map((f) => f.id)).toEqual(['f1']);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.finding.id).toBe('f2');
  });

  it('is deterministic: same fragment → same parsed diff', () => {
    expect(caseDiff('src/config.ts', PATCH)).toEqual(caseDiff('src/config.ts', PATCH));
  });
});

describe('toSkillPromptBlock (sanctioned duplication)', () => {
  it('renders the same block shape the reviews module renders', () => {
    expect(toSkillPromptBlock({ name: 'No secrets', body: '  Never commit keys.\n' })).toBe(
      '### No secrets\nNever commit keys.',
    );
  });
});
