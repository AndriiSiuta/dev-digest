import type { Finding, Intent } from '@devdigest/shared';

/**
 * Intent scope: render the derived-intent prompt block, and mechanically filter
 * out-of-scope findings after grounding.
 *
 * The model only *labels* findings (`in_scope: false`); the filtering itself is
 * code, like the grounding gate — a model instruction alone is not a guarantee.
 * Severity policy: an out-of-scope finding below CRITICAL is dropped; the
 * out-of-scope CRITICALs collapse into exactly ONE surviving signal so a severe
 * defect is never silenced but also never floods a scoped review.
 */

/** Title prefix marking the single surviving out-of-scope critical finding. */
export const OUT_OF_SCOPE_PREFIX = 'Out of scope — still critical: ';

/** Drop reasons merged into `ReviewOutcome.dropped` (alongside grounding's). */
export const SCOPE_DROP_REASONS = ['out_of_scope', 'out_of_scope_collapsed'] as const;

export interface ScopeFilterResult {
  kept: Finding[];
  dropped: { finding: Finding; reason: string }[];
}

/**
 * Deterministic markdown for the `## PR intent & scope (derived)` prompt
 * section. Pure string building — the caller wraps it as untrusted data.
 */
export function renderIntentBlock(intent: Intent): string {
  const list = (items: string[]): string =>
    items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '- (none declared)';
  return [
    `Intent: ${intent.intent}`,
    '',
    'In scope:',
    list(intent.in_scope),
    '',
    'Out of scope:',
    list(intent.out_of_scope),
  ].join('\n');
}

/**
 * Filter findings the model labelled out of scope (`in_scope === false`):
 *  - below CRITICAL → dropped with reason `out_of_scope`;
 *  - CRITICAL → exactly one survives (highest confidence), title-prefixed and
 *    annotated with the count of collapsed siblings; the siblings drop with
 *    reason `out_of_scope_collapsed`.
 * Findings with `in_scope` true/absent pass through untouched, in order.
 */
export function applyScopeFilter(findings: Finding[]): ScopeFilterResult {
  const outOfScopeCriticals = findings.filter(
    (f) => f.in_scope === false && f.severity === 'CRITICAL',
  );
  // The one surviving signal: the highest-confidence out-of-scope CRITICAL.
  const survivor = outOfScopeCriticals.reduce<Finding | undefined>(
    (best, f) => (best === undefined || f.confidence > best.confidence ? f : best),
    undefined,
  );

  const kept: Finding[] = [];
  const dropped: { finding: Finding; reason: string }[] = [];
  for (const f of findings) {
    if (f.in_scope !== false) {
      kept.push(f);
      continue;
    }
    if (f === survivor) {
      const collapsed = outOfScopeCriticals.length - 1;
      const note =
        collapsed > 0
          ? `\n\n_${collapsed} other out-of-scope critical finding(s) collapsed into this one._`
          : '';
      kept.push({
        ...f,
        title: `${OUT_OF_SCOPE_PREFIX}${f.title}`,
        rationale: `${f.rationale}${note}`,
      });
      continue;
    }
    dropped.push({
      finding: f,
      reason: f.severity === 'CRITICAL' ? 'out_of_scope_collapsed' : 'out_of_scope',
    });
  }
  return { kept, dropped };
}
