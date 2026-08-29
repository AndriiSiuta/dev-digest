import type { EvalExpectation, Finding } from '@devdigest/shared';
import type { EvalCaseOutcome } from './types.js';

/**
 * Mechanical scoring — the spec's normative match rule and metric formulas
 * (AC-18..24). Pure functions, no mocks needed, no LLM anywhere.
 */

/**
 * The normative match rule (AC-18): files equal AND the inclusive
 * [start_line, end_line] ranges overlap. Severity, category and title are
 * never read — the signature cannot see them.
 */
export function matches(
  finding: { file: string; start_line: number; end_line: number },
  exp: EvalExpectation,
): boolean {
  if (finding.file !== exp.file) return false;
  const fLo = Math.min(finding.start_line, finding.end_line);
  const fHi = Math.max(finding.start_line, finding.end_line);
  const eLo = Math.min(exp.start_line, exp.end_line);
  const eHi = Math.max(exp.start_line, exp.end_line);
  return fLo <= eHi && eLo <= fHi;
}

/**
 * The per-case verdict: `must_find` passes iff at least one surviving finding
 * matches (AC-19); `must_not_flag` passes iff none does (AC-20).
 */
export function caseVerdict(
  exp: EvalExpectation,
  surviving: Finding[],
): { pass: boolean; matched: number } {
  const matched = surviving.filter((f) => matches(f, exp)).length;
  return { pass: exp.kind === 'must_find' ? matched >= 1 : matched === 0, matched };
}

/** Per-case citation accuracy: surviving ÷ proposed, 1.0 when nothing proposed. */
export function caseCitation(surviving: number, proposed: number): number {
  return proposed === 0 ? 1 : surviving / proposed;
}

/** Whether an executed outcome passed its own expectation. */
function outcomePassed(o: EvalCaseOutcome): boolean {
  return o.expectation_kind === 'must_find' ? o.matched : !o.matched;
}

/**
 * Batch metrics from RAW COUNTS across the batch's rows — never a mean of
 * per-case values (AC-24). Errored outcomes are excluded from EVERY
 * denominator (AC-27); each vacuous denominator scores 1.0 (AC-21..23,
 * Decision-log 5/6/7).
 */
export function batchMetrics(outcomes: EvalCaseOutcome[]): {
  recall: number;
  precision: number;
  citation_accuracy: number;
  cases_total: number;
  cases_errored: number;
  cases_passed: number;
} {
  const executed = outcomes.filter((o) => o.error === null);
  const mustFind = executed.filter((o) => o.expectation_kind === 'must_find');
  const mustFindPassed = mustFind.filter(outcomePassed).length;
  const surviving = executed.reduce((n, o) => n + o.surviving, 0);
  const proposed = executed.reduce((n, o) => n + o.proposed, 0);
  const noise = executed.reduce((n, o) => n + o.noise, 0);
  return {
    recall: mustFind.length === 0 ? 1 : mustFindPassed / mustFind.length,
    precision: surviving === 0 ? 1 : 1 - noise / surviving,
    citation_accuracy: proposed === 0 ? 1 : surviving / proposed,
    cases_total: outcomes.length,
    cases_errored: outcomes.length - executed.length,
    cases_passed: executed.filter(outcomePassed).length,
  };
}
