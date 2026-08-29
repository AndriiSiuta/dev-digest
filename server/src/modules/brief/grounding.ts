import type { BriefFocusItem, Risk, RiskSeverity } from '@devdigest/shared';

/**
 * The brief's grounding gate — pure, brief-local, no I/O and no container.
 *
 * `groundFindings` in `reviewer-core` cannot be reused: it needs a `Finding`
 * and a line-numbered unified diff (`reviewer-core/src/grounding.ts:23-37`),
 * while a `Risk` has `file_refs: string[]` and no lines, and this feature never
 * loads hunk bodies. `platform/grounding.ts` is a re-export shim and must not
 * be edited. What IS reused is the principle behind it
 * (`reviewer-core/INSIGHTS.md`, *Decisions*, 2026-07-31): cite something real,
 * or be dropped — mechanically, in code, never by asking the model nicely.
 *
 * The rules, and which AC each comes from:
 *
 *  - A `file_ref` that is not one of the PR's changed files is REMOVED from the
 *    risk and recorded (AC-06, AC-09).
 *  - An `endpoint_ref` that is not in the blast summary's endpoint set is
 *    REMOVED and recorded (AC-08, AC-09).
 *  - A risk survives only if it still cites evidence — at least one surviving
 *    `file_ref` or `endpoint_ref` — AND cited no endpoint that failed the gate.
 *    The asymmetry is deliberate: AC-06 asks only that an invented FILE
 *    reference be removed, while AC-08's stated outcome is that an invented
 *    ENDPOINT can neither survive into the stored brief nor keep a risk alive,
 *    so a risk built on an endpoint that does not exist is dropped even when
 *    its file references are real.
 *  - A `review_focus` item whose `file` is not a changed file is dropped and
 *    recorded (AC-07, AC-44).
 *
 * `endpoint_refs` never reaches the wire: it exists on the model's draft schema
 * only, as the evidence this gate filters, and is discarded when a surviving
 * draft risk is mapped to the contract's `Risk`.
 */

export type BriefDropTarget = 'risk' | 'file_ref' | 'endpoint_ref' | 'review_focus';

/**
 * One thing the gate removed. Mirrors `GroundingResult.dropped`
 * (`reviewer-core/src/grounding.ts:19-21`) and exists so nothing goes silent
 * (AC-09) — the service logs these records whole, not as a count.
 *
 * `ref` is always an IDENTIFIER: a file path, an endpoint string, or (for a
 * dropped risk) its ordinal in the model's list. Never the risk's title or
 * explanation — model prose must not reach the log (AC-NF-02).
 */
export interface BriefDrop {
  target: BriefDropTarget;
  ref: string;
  reason: string;
}

/** The universe a draft is grounded against. */
export interface BriefGroundingInputs {
  /** The PR's full changed-path list — NOT the Smart Diff path set. */
  files: ReadonlySet<string>;
  /** Union of `blast.downstream[].endpoints_affected`. */
  endpoints: ReadonlySet<string>;
}

/** A risk as the model drafts it — `endpoint_refs` is draft-only. */
export interface BriefDraftRisk {
  kind: string;
  title: string;
  explanation: string;
  file_refs: string[];
  endpoint_refs: string[];
  severity: RiskSeverity;
}

export interface BriefDraftFocusItem {
  file: string;
  line?: number | null;
  reason: string;
}

/** The parts of the draft this gate reads. */
export interface BriefGroundingDraft {
  risks: BriefDraftRisk[];
  review_focus: BriefDraftFocusItem[];
}

export interface BriefGroundingResult {
  /** Survivors, mapped to the wire `Risk` (no `endpoint_refs`). */
  risks: Risk[];
  reviewFocus: BriefFocusItem[];
  dropped: BriefDrop[];
}

const REASON = {
  fileRef: 'file is not among the pull request’s changed files',
  endpointRef: 'endpoint does not appear in the blast summary',
  riskUngrounded: 'risk cites no changed file and no known endpoint',
  riskInventedEndpoint: 'risk cites an endpoint that does not exist',
  focusFile: 'review-focus file is not among the pull request’s changed files',
} as const;

export function groundBrief(
  draft: BriefGroundingDraft,
  inputs: BriefGroundingInputs,
): BriefGroundingResult {
  const dropped: BriefDrop[] = [];
  const risks: Risk[] = [];

  draft.risks.forEach((risk, index) => {
    const fileRefs: string[] = [];
    for (const ref of risk.file_refs) {
      if (inputs.files.has(ref)) fileRefs.push(ref);
      else dropped.push({ target: 'file_ref', ref, reason: REASON.fileRef });
    }

    let inventedEndpoint = false;
    const endpointRefs: string[] = [];
    for (const ref of risk.endpoint_refs) {
      if (inputs.endpoints.has(ref)) endpointRefs.push(ref);
      else {
        inventedEndpoint = true;
        dropped.push({ target: 'endpoint_ref', ref, reason: REASON.endpointRef });
      }
    }

    const grounded = fileRefs.length > 0 || endpointRefs.length > 0;
    if (!grounded || inventedEndpoint) {
      dropped.push({
        target: 'risk',
        // Positional, never the title: the drop records reach the log (AC-09)
        // and model prose must not (AC-NF-02).
        ref: `risk#${index}`,
        reason: grounded ? REASON.riskInventedEndpoint : REASON.riskUngrounded,
      });
      return;
    }

    // `endpoint_refs` is discarded here — it is draft-only evidence and has no
    // home on the wire `Risk`.
    risks.push({
      kind: risk.kind,
      title: risk.title,
      explanation: risk.explanation,
      severity: risk.severity,
      file_refs: fileRefs,
    });
  });

  const reviewFocus: BriefFocusItem[] = [];
  for (const item of draft.review_focus) {
    if (!inputs.files.has(item.file)) {
      dropped.push({ target: 'review_focus', ref: item.file, reason: REASON.focusFile });
      continue;
    }
    reviewFocus.push({
      file: item.file,
      ...(item.line === undefined ? {} : { line: item.line }),
      reason: item.reason,
    });
  }

  return { risks, reviewFocus, dropped };
}
