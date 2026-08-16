import type {
  ProposedSplit,
  Severity,
  SmartDiff,
  SmartDiffFile,
  SmartDiffFinding,
  SmartDiffGroup,
  SmartDiffRole,
} from '@devdigest/shared';
import { classifyPath, isTestPath, normalizePath } from './classifier.js';
import {
  ROLE_ORDER,
  SEVERITY_RANK,
  SPLIT_KEY_DEPTH,
  SPLIT_MIN_KEYS,
  SPLIT_TOO_BIG_FILES,
  SPLIT_TOO_BIG_LINES,
} from './constants.js';
import type { SmartDiffFindingInput, SmartDiffPrFile, SmartDiffReviewInput } from './types.js';

/**
 * Pure Smart Diff builder. No DB, no IO, no `this` — unit-tests directly with
 * plain object fixtures (see `smart-diff-helpers.test.ts`).
 */

/**
 * "Latest review" = each agent's latest `kind:'review'`, findings unioned
 * across agents — the same rule `pulls/helpers.ts`'s `pickCountedReviews`
 * applies to the PR-list finding counts. Dismissed findings are included
 * (parity with those counts). Input must be newest-first (as
 * `reviewsForPull` returns).
 */
export function pickLatestFindings(reviews: SmartDiffReviewInput[]): SmartDiffFindingInput[] {
  const seenAgent = new Set<string>();
  const findings: SmartDiffFindingInput[] = [];
  for (const { review, findings: reviewFindings } of reviews) {
    if (review.kind !== 'review') continue;
    const agentKey = review.agentId ?? 'none';
    if (seenAgent.has(agentKey)) continue;
    seenAgent.add(agentKey);
    findings.push(...reviewFindings);
  }
  return findings;
}

/** Max SEVERITY_RANK across a file's findings, 0 when there are none. */
function maxSeverityRank(findings: SmartDiffFinding[]): number {
  return findings.reduce((max, f) => Math.max(max, SEVERITY_RANK[f.severity] ?? 0), 0);
}

/**
 * Sort files within one role group: files with findings first, then by their
 * highest-severity finding, then by finding count, then source before tests,
 * then churn (additions+deletions) descending, and finally path ascending —
 * the last key is a deterministic tiebreak since `pr_files` reads back in no
 * guaranteed order.
 */
function compareFiles(a: SmartDiffFile, b: SmartDiffFile): number {
  const aHas = a.findings.length > 0 ? 1 : 0;
  const bHas = b.findings.length > 0 ? 1 : 0;
  if (aHas !== bHas) return bHas - aHas;

  const aSeverity = maxSeverityRank(a.findings);
  const bSeverity = maxSeverityRank(b.findings);
  if (aSeverity !== bSeverity) return bSeverity - aSeverity;

  if (a.findings.length !== b.findings.length) return b.findings.length - a.findings.length;

  const aTest = isTestPath(a.path) ? 1 : 0;
  const bTest = isTestPath(b.path) ? 1 : 0;
  if (aTest !== bTest) return aTest - bTest; // source (0) before tests (1)

  const aChurn = a.additions + a.deletions;
  const bChurn = b.additions + b.deletions;
  if (aChurn !== bChurn) return bChurn - aChurn;

  return a.path.localeCompare(b.path);
}

/**
 * `core` + `wiring` files only, keyed by their top `SPLIT_KEY_DEPTH` path
 * segments — `[]` when the diff is under threshold, or when there are fewer
 * than `SPLIT_MIN_KEYS` distinct keys (no meaningful split to propose).
 */
function buildSplitSuggestion(
  files: { path: string; additions: number; deletions: number; role: SmartDiffRole }[],
): SmartDiff['split_suggestion'] {
  const candidates = files.filter((f) => f.role !== 'boilerplate');
  const totalLines = candidates.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const tooBig = totalLines > SPLIT_TOO_BIG_LINES || candidates.length > SPLIT_TOO_BIG_FILES;

  const byKey = new Map<string, string[]>();
  for (const f of candidates) {
    const segments = normalizePath(f.path).split('/');
    const key = segments.slice(0, SPLIT_KEY_DEPTH).join('/') || f.path;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(f.path);
    else byKey.set(key, [f.path]);
  }

  const proposedSplits: ProposedSplit[] =
    tooBig && byKey.size >= SPLIT_MIN_KEYS
      ? [...byKey.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, splitFiles]) => ({ name, files: splitFiles }))
      : [];

  return { too_big: tooBig, total_lines: totalLines, proposed_splits: proposedSplits };
}

/**
 * Build the full Smart Diff for a PR: classify every file, overlay the latest
 * findings per agent, sort within each role, and propose a split when the
 * reviewable (core+wiring) surface is too big. Always emits all three groups,
 * in `ROLE_ORDER`, empty groups included.
 */
export function buildSmartDiff(files: SmartDiffPrFile[], reviews: SmartDiffReviewInput[]): SmartDiff {
  const latestFindings = pickLatestFindings(reviews);

  // Index findings by normalized path; findings referencing a file that isn't
  // in this PR's file list are dropped (nothing to overlay them onto).
  const findingsByPath = new Map<string, SmartDiffFindingInput[]>();
  for (const f of latestFindings) {
    const key = normalizePath(f.file);
    const bucket = findingsByPath.get(key);
    if (bucket) bucket.push(f);
    else findingsByPath.set(key, [f]);
  }

  const byRole: Record<SmartDiffRole, SmartDiffFile[]> = { core: [], wiring: [], boilerplate: [] };
  const roleByPath = new Map<string, SmartDiffRole>();

  for (const file of files) {
    const role = classifyPath(file.path);
    roleByPath.set(file.path, role);

    const matched = (findingsByPath.get(normalizePath(file.path)) ?? [])
      .slice()
      .sort((a, b) => a.startLine - b.startLine);

    const findings: SmartDiffFinding[] = matched.map((f) => ({
      id: f.id,
      line: f.startLine,
      end_line: f.endLine,
      severity: f.severity as Severity,
      title: f.title,
    }));

    const findingLines = [...new Set(matched.map((f) => f.startLine))].sort((a, b) => a - b);

    byRole[role].push({
      path: file.path,
      pseudocode_summary: null, // stays null — out of scope
      additions: file.additions,
      deletions: file.deletions,
      finding_lines: findingLines,
      findings,
    });
  }

  const groups: SmartDiffGroup[] = ROLE_ORDER.map((role) => ({
    role,
    files: byRole[role].slice().sort(compareFiles),
  }));

  const split_suggestion = buildSplitSuggestion(
    files.map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      role: roleByPath.get(f.path)!,
    })),
  );

  return { groups, split_suggestion };
}
