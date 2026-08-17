/* CodeLine — one rendered diff line: gutter number, +/- sign, text, plus the
   hover "+" affordance, any anchored comment threads, and an inline composer.
   A line carrying Smart Diff findings gets a severity-colored left accent bar
   and a right-aligned `SeverityBadge` per finding (the same badge used across
   the app's findings UI, for visual consistency). */
"use client";

import React from "react";
import type { SmartDiffFinding } from "@devdigest/shared";
import { SEV, SeverityBadge } from "@devdigest/ui";
import { commentTargetFor, type CommentThread, type DiffCommentApi, cs } from "../comments";
import { type Line } from "../helpers";
import { SEVERITY_RANK } from "../constants";
import { s, lineRowFor, lineSignFor } from "../styles";
import { CommentThreadView } from "../CommentThreadView";
import { InlineComposer } from "../InlineComposer";

/** The highest-priority severity among a line's findings — colors the row's
 *  left accent bar. `undefined` when the line carries no findings. */
function topSeverity(findings: SmartDiffFinding[] | undefined) {
  let top: SmartDiffFinding["severity"] | undefined;
  for (const f of findings ?? []) {
    const rank = SEVERITY_RANK[f.severity] ?? 0;
    const topRank = top === undefined ? -1 : (SEVERITY_RANK[top] ?? 0);
    if (rank > topRank) top = f.severity;
  }
  return top;
}

export function CodeLine({
  ln,
  path,
  threads,
  commenting,
  findings,
}: {
  ln: Line;
  path: string;
  threads: CommentThread[];
  commenting?: DiffCommentApi;
  /** Smart Diff findings anchored to this line's new-side number, if any. */
  findings?: SmartDiffFinding[];
}) {
  const [hover, setHover] = React.useState(false);
  const [composing, setComposing] = React.useState(false);

  if (ln.kind === "hunk") {
    return (
      <div className="mono" style={s.hunk}>
        {ln.text}
      </div>
    );
  }

  const sign = ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : "";
  const target = commenting?.canComment ? commentTargetFor(ln) : null;
  const showAdd = hover && !!target && !composing;
  const severity = topSeverity(findings);
  const accentColor = severity ? SEV[severity].c : undefined;

  return (
    <div
      style={cs.rowWrap}
      data-new-line={ln.newNo ?? undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={lineRowFor(ln.kind, accentColor)}>
        <span className="mono tnum" style={{ ...s.lineNo, position: "relative" }}>
          {showAdd && target && (
            <button
              type="button"
              title="Add a comment on this line"
              aria-label="Add a comment on this line"
              onClick={() => setComposing(true)}
              style={cs.addBtn}
            >
              +
            </button>
          )}
          {ln.newNo ?? ln.oldNo ?? ""}
        </span>
        <span className="mono" style={lineSignFor(ln.kind)}>
          {sign}
        </span>
        <span className="mono" style={s.lineText}>
          {ln.text || " "}
        </span>
        {findings && findings.length > 0 && (
          <span style={s.findingChips}>
            {findings.map((f) => (
              <span key={f.id} title={f.title}>
                <SeverityBadge severity={f.severity} />
              </span>
            ))}
          </span>
        )}
      </div>

      {commenting &&
        commenting.showComments &&
        threads.map((th) => (
          <CommentThreadView key={th.rootId} thread={th} commenting={commenting} path={path} />
        ))}

      {commenting && composing && target && (
        <InlineComposer
          commenting={commenting}
          path={path}
          line={target.line}
          side={target.side}
          onClose={() => setComposing(false)}
        />
      )}
    </div>
  );
}
