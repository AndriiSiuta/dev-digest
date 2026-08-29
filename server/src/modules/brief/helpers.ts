import type {
  BlastPanel,
  BriefMissingInput,
  BriefRiskLevel,
  ProjectContextDoc,
  Risk,
} from '@devdigest/shared';
import {
  BRIEF_MAX_INPUT_CHARS,
  BRIEF_MAX_SPEC_DOCS,
  BRIEF_MAX_SPEC_DOC_CHARS,
  BRIEF_SPEC_DOC_TYPE,
  SEVERITY_RANK,
} from './constants.js';

/**
 * brief — pure rules. No I/O, no container, no `process.env`: everything here
 * is a function over fixtures, which is what lets `test/brief-grounding.test.ts`
 * assert them with no mocks at all.
 */

/**
 * AC-30 — the whole-PR level is the maximum severity among the risks that
 * SURVIVED grounding, and `none` when none did (AC-31).
 *
 * The model's own `risk_level` is not a parameter of this function. That is
 * what makes "the system discards the model's level" structural rather than a
 * rule someone has to remember at the call site.
 */
export function computeRiskLevel(risks: Risk[]): BriefRiskLevel {
  let best: BriefRiskLevel = 'none';
  let bestRank = 0;
  for (const risk of risks) {
    const rank = SEVERITY_RANK[risk.severity] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = risk.severity;
    }
  }
  return best;
}

/**
 * AC-35 — the repository's discovered `spec` documents, path-ordered, capped at
 * 6 documents and 12,000 characters combined, by WHOLE documents.
 *
 * Sorting happens here rather than being inherited from the adapter: a cap that
 * depends on somebody else's iteration order is not a rule, it is a
 * coincidence. `bytes` is the pre-read size the discovery port carries
 * (`ProjectContextDoc` has no body), so it is the character proxy the cap is
 * applied against — counting real characters would mean reading every document
 * just to decide which ones to read.
 */
export function selectSpecDocs(docs: ProjectContextDoc[]): ProjectContextDoc[] {
  const specs = docs
    .filter((d) => d.type === BRIEF_SPEC_DOC_TYPE)
    .sort((a, b) => a.path.localeCompare(b.path));

  const kept: ProjectContextDoc[] = [];
  let chars = 0;
  for (const doc of specs) {
    if (kept.length >= BRIEF_MAX_SPEC_DOCS) break;
    // Stop BEFORE the document that would cross the cap — whole documents only,
    // never a part of one.
    if (chars + doc.bytes > BRIEF_MAX_SPEC_DOC_CHARS) break;
    kept.push(doc);
    chars += doc.bytes;
  }
  return kept;
}

/** One assembled prompt section, carrying the priority it is dropped at. */
export interface BudgetedSection {
  priority: number;
  text: string;
}

export interface BudgetResult<T extends BudgetedSection> {
  kept: T[];
  /** Priorities dropped to make the prompt fit, in the order they were dropped. */
  droppedPriorities: number[];
}

/** How the assembled sections are joined — the length the cap is applied to. */
export const SECTION_SEPARATOR = '\n\n';

/**
 * AC-NF-04 — drop WHOLE sections, lowest priority first, until the assembled
 * prompt fits `BRIEF_MAX_INPUT_CHARS`. Priority 1 is never dropped and nothing
 * is ever truncated part-way, so the request never fails for being too big.
 *
 * Note what this function does NOT do: it never reaches inside the
 * `## Project context` section. That block is ONE atomic input at the lowest
 * priority and is dropped whole; per-document culling is `selectSpecDocs`'s job
 * (AC-35) and has already happened by the time this runs. Two caps, two stages,
 * in that order — which is what makes "drop whole inputs, never truncate an
 * input part-way" literally true of both.
 */
export function fitToBudget<T extends BudgetedSection>(sections: T[]): BudgetResult<T> {
  const kept = [...sections];
  const droppedPriorities: number[] = [];

  const size = () => kept.reduce((n, s) => n + s.text.length, 0) +
    Math.max(0, kept.length - 1) * SECTION_SEPARATOR.length;

  while (size() > BRIEF_MAX_INPUT_CHARS) {
    let victim = -1;
    for (let i = 0; i < kept.length; i += 1) {
      const s = kept[i];
      if (s === undefined || s.priority <= 1) continue;
      const worst = victim === -1 ? undefined : kept[victim];
      if (worst === undefined || s.priority > worst.priority) victim = i;
    }
    // Only the never-dropped section is left: return it rather than failing.
    if (victim === -1) break;
    const [dropped] = kept.splice(victim, 1);
    if (dropped) droppedPriorities.push(dropped.priority);
  }

  return { kept, droppedPriorities };
}

/**
 * AC-32 — the availability ledger, de-duplicated by kind (first entry wins) and
 * left in gathering order.
 *
 * AVAILABILITY ONLY. A budget-driven drop (AC-NF-04) is not a missing input —
 * the input was there, it just did not fit — and a repository with no spec
 * documents produces no entry at all (AC-36).
 */
export function toMissingInputs(entries: BriefMissingInput[]): BriefMissingInput[] {
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.kind) ? false : (seen.add(e.kind), true)));
}

/** AC-32 — a brief is degraded exactly when something it wanted was unavailable. */
export function toDegraded(missing: BriefMissingInput[]): boolean {
  return missing.length > 0;
}

/** AC-08 — the endpoint universe the gate grounds `endpoint_refs` against. */
export function endpointsOf(blast: BlastPanel | undefined): Set<string> {
  const out = new Set<string>();
  for (const impact of blast?.blast.downstream ?? []) {
    for (const endpoint of impact.endpoints_affected) out.add(endpoint);
  }
  return out;
}
