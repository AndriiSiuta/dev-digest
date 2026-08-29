import { z } from 'zod';
import { Severity } from './findings.js';

/**
 * PR Brief building blocks: Intent, Blast radius, Risks, PR History,
 * Smart Diff. Composed into PrBrief.
 */

// ---- Intent ----
export const Intent = z.object({
  intent: z.string(),
  in_scope: z.array(z.string()),
  out_of_scope: z.array(z.string()),
});
export type Intent = z.infer<typeof Intent>;

/** Where one input to the intent classification came from. */
export const IntentSourceKind = z.enum([
  'pr_title',
  'pr_description',
  'linked_issue',
  'doc_link',
  'file_list',
]);
export type IntentSourceKind = z.infer<typeof IntentSourceKind>;

/**
 * What happened to that input: `included` reached the prompt; `unreachable`
 * was referenced but could not be fetched; `unsupported` is a link kind v1
 * does not follow (arbitrary external URLs); `empty` existed but had no
 * content. Anything not `included` flags the classification as missing context.
 */
export const IntentSourceStatus = z.enum(['included', 'unreachable', 'unsupported', 'empty']);
export type IntentSourceStatus = z.infer<typeof IntentSourceStatus>;

export const IntentSource = z.object({
  kind: IntentSourceKind,
  /** Human-readable reference (issue number, doc path, URL) — never content. */
  ref: z.string(),
  status: IntentSourceStatus,
  /** Characters of this source that reached the prompt (null when none). */
  chars: z.number().int().nullish(),
});
export type IntentSource = z.infer<typeof IntentSource>;

// ---- Blast radius ----
export const ChangedSymbol = z.object({
  name: z.string(),
  file: z.string(),
  kind: z.string(),
});
export type ChangedSymbol = z.infer<typeof ChangedSymbol>;

export const BlastCaller = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number().int(),
});
export type BlastCaller = z.infer<typeof BlastCaller>;

export const DownstreamImpact = z.object({
  symbol: z.string(),
  callers: z.array(BlastCaller),
  endpoints_affected: z.array(z.string()),
  crons_affected: z.array(z.string()),
});
export type DownstreamImpact = z.infer<typeof DownstreamImpact>;

export const BlastRadius = z.object({
  changed_symbols: z.array(ChangedSymbol),
  downstream: z.array(DownstreamImpact),
  summary: z.string(),
});
export type BlastRadius = z.infer<typeof BlastRadius>;

// ---- Risks ----
export const RiskSeverity = z.enum(['high', 'medium', 'low']);
export type RiskSeverity = z.infer<typeof RiskSeverity>;

export const Risk = z.object({
  kind: z.string(),
  title: z.string(),
  explanation: z.string(),
  severity: RiskSeverity,
  file_refs: z.array(z.string()),
});
export type Risk = z.infer<typeof Risk>;

export const Risks = z.object({
  risks: z.array(Risk),
});
export type Risks = z.infer<typeof Risks>;

// ---- PR History ----
export const PrHistoryItem = z.object({
  pr_number: z.number().int(),
  title: z.string(),
  merged_at: z.string(),
  author: z.string(),
  files_overlap: z.array(z.string()),
  notes: z.string(),
});
export type PrHistoryItem = z.infer<typeof PrHistoryItem>;

export const PrHistory = z.object({
  history: z.array(PrHistoryItem),
});
export type PrHistory = z.infer<typeof PrHistory>;

/** Route-level composition for `GET /pulls/:id/blast`. */
export const BlastPanel = z.object({
  blast: BlastRadius,
  history: PrHistory,
  /** true on the ripgrep fallback — no crons, no caller ranks. */
  degraded: z.boolean(),
  head_sha: z.string(),
});
export type BlastPanel = z.infer<typeof BlastPanel>;

// ---- Smart Diff ----
export const SmartDiffRole = z.enum(['core', 'wiring', 'boilerplate']);
export type SmartDiffRole = z.infer<typeof SmartDiffRole>;

export const SmartDiffFinding = z.object({
  id: z.string(),
  line: z.number().int(), // new-side start line — the scroll anchor
  end_line: z.number().int(),
  severity: Severity,
  title: z.string(),
});
export type SmartDiffFinding = z.infer<typeof SmartDiffFinding>;

export const SmartDiffFile = z.object({
  path: z.string(),
  pseudocode_summary: z.string().nullish(), // stays null — out of scope
  additions: z.number().int(),
  deletions: z.number().int(),
  finding_lines: z.array(z.number().int()), // sorted, de-duped — kept for CI/brief consumers
  findings: z.array(SmartDiffFinding),
});
export type SmartDiffFile = z.infer<typeof SmartDiffFile>;

export const SmartDiffGroup = z.object({
  role: SmartDiffRole,
  files: z.array(SmartDiffFile),
});
export type SmartDiffGroup = z.infer<typeof SmartDiffGroup>;

export const ProposedSplit = z.object({
  name: z.string(),
  files: z.array(z.string()),
});
export type ProposedSplit = z.infer<typeof ProposedSplit>;

export const SmartDiff = z.object({
  groups: z.array(SmartDiffGroup),
  split_suggestion: z.object({
    too_big: z.boolean(),
    total_lines: z.number().int(),
    proposed_splits: z.array(ProposedSplit),
  }),
});
export type SmartDiff = z.infer<typeof SmartDiff>;

// ---- Composed PR Brief (pr_brief.json) ----
export const PrBrief = z.object({
  intent: Intent,
  blast: BlastRadius,
  risks: Risks,
  history: PrHistory,
});
export type PrBrief = z.infer<typeof PrBrief>;

// ---- PR Brief v2 (the Why + Risk card) ----

/**
 * Whole-PR risk level, server-computed from the surviving risks. Distinct from
 * `RiskSeverity`, which stays the three-valued per-risk vocabulary: this one
 * needs a fourth value, `none`, for a brief with zero surviving risks. It is a
 * measure of how much attention the PR needs — never a review verdict.
 */
export const BriefRiskLevel = z.enum(['high', 'medium', 'low', 'none']);
export type BriefRiskLevel = z.infer<typeof BriefRiskLevel>;

/** One "check this first" pointer. `line` is the new-side scroll anchor. */
export const BriefFocusItem = z.object({
  file: z.string().min(1),
  line: z.number().int().nullish(),
  reason: z.string().min(1),
});
export type BriefFocusItem = z.infer<typeof BriefFocusItem>;

/** Which of the brief's inputs an entry in `missing_inputs` refers to. */
export const BriefInputKind = z.enum(['intent', 'blast', 'smart_diff', 'project_context']);
export type BriefInputKind = z.infer<typeof BriefInputKind>;

/**
 * What happened to that input: `absent` was never there; `degraded` was there
 * but computed on a fallback; `unreachable` exists but could not be read.
 * Follows `IntentSourceStatus` above and `SpecRead.status` in `trace.ts`, both
 * of which distinguish "not there" from "referenced but unreachable".
 */
export const BriefInputStatus = z.enum(['absent', 'degraded', 'unreachable']);
export type BriefInputStatus = z.infer<typeof BriefInputStatus>;

export const BriefMissingInput = z.object({
  kind: BriefInputKind,
  status: BriefInputStatus,
});
export type BriefMissingInput = z.infer<typeof BriefMissingInput>;

/** The brief payload itself (stored in `pr_brief.json`). */
export const Brief = z.object({
  what: z.string(),
  why: z.string(),
  risk_level: BriefRiskLevel,
  risks: z.array(Risk),
  review_focus: z.array(BriefFocusItem),
  degraded: z.boolean(),
  missing_inputs: z.array(BriefMissingInput),
});
export type Brief = z.infer<typeof Brief>;

/**
 * Route-level envelope for `GET`/`POST /pulls/:id/brief`. `head_sha` is what
 * the brief was generated against; `pr_head_sha` is the PR's current head, so
 * the card renders the outdated state without a second fetch (the
 * `BlastPanel.head_sha` precedent above).
 */
export const PrBriefRecord = z.object({
  pr_id: z.string(),
  brief: Brief,
  head_sha: z.string(),
  pr_head_sha: z.string(),
  model: z.string().nullable(),
  generated_at: z.string(),
});
export type PrBriefRecord = z.infer<typeof PrBriefRecord>;
