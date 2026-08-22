import type { BlastRadius, DownstreamImpact, PrHistory } from '@devdigest/shared';
import type { BlastResult } from '../repo-intel/types.js';
import type { BlastHistoryPull } from './types.js';

/**
 * blast — pure mappers from the repo-intel read model (`BlastResult`) to the
 * shared wire contract (`BlastRadius` / `PrHistory`). No I/O, no model call:
 * everything here is a deterministic recombination of already-computed data,
 * which is what lets `blast-helpers.test.ts` run on plain fixtures.
 */

/** Push `value` iff not already present — de-duped union, insertion order. */
function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * `BlastResult` → the shared `BlastRadius`.
 *
 * - `downstream` groups `callers[]` by `viaSymbol`; entry order is the first
 *   appearance of each `viaSymbol` (the facade returns callers rank-ordered),
 *   caller order inside an entry is preserved. Every caller row lands under
 *   exactly one entry.
 * - Non-degraded (`factsByFile` present): each entry's `endpoints_affected` /
 *   `crons_affected` is the de-duped union of the facts keyed by that entry's
 *   caller files.
 * - Degraded (`factsByFile` absent): the flat `impactedEndpoints` union
 *   attaches to the FIRST entry (file-level attribution is all the ripgrep
 *   fallback knows); every `crons_affected` stays empty.
 * - `summary` is deterministic — four ` · `-joined counts, no model call.
 */
export function buildBlastRadius(result: BlastResult): BlastRadius {
  const bySymbol = new Map<string, DownstreamImpact>();
  const downstream: DownstreamImpact[] = [];

  for (const caller of result.callers) {
    let entry = bySymbol.get(caller.viaSymbol);
    if (!entry) {
      entry = { symbol: caller.viaSymbol, callers: [], endpoints_affected: [], crons_affected: [] };
      bySymbol.set(caller.viaSymbol, entry);
      downstream.push(entry);
    }
    entry.callers.push({ name: caller.symbol, file: caller.file, line: caller.line });

    const facts = result.factsByFile?.[caller.file];
    if (facts) {
      for (const e of facts.endpoints) addUnique(entry.endpoints_affected, e);
      for (const c of facts.crons) addUnique(entry.crons_affected, c);
    }
  }

  const first = downstream[0];
  if (!result.factsByFile && first) {
    for (const e of result.impactedEndpoints) addUnique(first.endpoints_affected, e);
  }

  const endpoints = new Set<string>();
  const crons = new Set<string>();
  let callerCount = 0;
  for (const entry of downstream) {
    callerCount += entry.callers.length;
    for (const e of entry.endpoints_affected) endpoints.add(e);
    for (const c of entry.crons_affected) crons.add(c);
  }

  const summary = [
    plural(result.changedSymbols.length, 'symbol'),
    plural(callerCount, 'caller'),
    plural(endpoints.size, 'endpoint'),
    plural(crons.size, 'cron'),
  ].join(' · ');

  return {
    changed_symbols: result.changedSymbols.map((s) => ({
      name: s.name,
      file: s.file,
      kind: s.kind,
    })),
    downstream,
    summary,
  };
}

/**
 * Overlap rows → the shared `PrHistory`. `merged_at` is the documented
 * approximation: derived from `updatedAt` for merged AND open/closed PRs
 * alike (no real `merged_at` column — spec, Schema changes); `?? ''` because
 * the contract string is non-nullable while Drizzle's `updatedAt` is.
 */
export function buildHistory(
  rows: Array<{ pull: BlastHistoryPull; overlap: string[] }>,
): PrHistory {
  return {
    history: rows.map(({ pull, overlap }) => ({
      pr_number: pull.number,
      title: pull.title,
      author: pull.author,
      merged_at: pull.updatedAt?.toISOString() ?? '',
      files_overlap: overlap,
      notes: '',
    })),
  };
}
