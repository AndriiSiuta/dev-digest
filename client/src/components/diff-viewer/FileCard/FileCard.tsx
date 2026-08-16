/* FileCard — one collapsible file in the diff: header (path, +/- stat, comment
   count) and, when open, its parsed lines plus any outdated comments. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { PrFile } from "@/lib/types";
import type { SmartDiffFinding } from "@devdigest/shared";
import { AUTO_EXPAND_MAX_LINES } from "../constants";
import { parsePatch, type Line } from "../helpers";
import {
  buildThreads,
  keysForLine,
  partitionThreads,
  type CommentThread,
  type DiffCommentApi,
} from "../comments";
import { s, chevronFor } from "../styles";
import { CodeLine } from "../CodeLine";
import { OutdatedComments } from "../OutdatedComments";

/** Threads anchored to a given parsed line (RIGHT=new, LEFT=old). */
function threadsForLine(ln: Line, matched: Map<string, CommentThread[]>): CommentThread[] {
  if (matched.size === 0) return [];
  const out: CommentThread[] = [];
  for (const key of keysForLine(ln)) {
    const list = matched.get(key);
    if (list) out.push(...list);
  }
  return out;
}

export function FileCard({
  file,
  commenting,
  defaultOpen,
  findings,
}: {
  file: PrFile;
  commenting?: DiffCommentApi;
  /** Overrides the size-based auto-expand default when provided (Smart Diff). */
  defaultOpen?: boolean;
  /** Smart Diff findings overlaid on this file, if any. */
  findings?: SmartDiffFinding[];
}) {
  const t = useTranslations("shell");
  const [open, setOpen] = React.useState(
    defaultOpen ?? (file.additions ?? 0) + (file.deletions ?? 0) <= AUTO_EXPAND_MAX_LINES
  );
  // Set by the findings badge: the lowest finding line to scroll to once the
  // file is open and its lines are rendered.
  const [jumpLine, setJumpLine] = React.useState<number | null>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const lines = React.useMemo(() => parsePatch(file.patch), [file.patch]);

  const findingsByLine = React.useMemo(() => {
    const map = new Map<number, SmartDiffFinding[]>();
    for (const f of findings ?? []) {
      const bucket = map.get(f.line);
      if (bucket) bucket.push(f);
      else map.set(f.line, [f]);
    }
    return map;
  }, [findings]);

  React.useEffect(() => {
    if (jumpLine == null || !open) return;
    const el = bodyRef.current?.querySelector(`[data-new-line="${jumpLine}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    setJumpLine(null);
  }, [jumpLine, open]);

  // Group this file's comments into threads, then split into ones we can anchor
  // to a rendered line vs. "outdated" (GitHub dropped the line / it's not here).
  const comments = commenting?.comments;
  const { matched, outdated } = React.useMemo(() => {
    if (!comments) return { matched: new Map<string, CommentThread[]>(), outdated: [] };
    const fileThreads = buildThreads(comments.filter((c) => c.path === file.path));
    const renderedKeys = new Set<string>();
    for (const ln of lines) for (const k of keysForLine(ln)) renderedKeys.add(k);
    return partitionThreads(fileThreads, renderedKeys);
  }, [comments, file.path, lines]);

  const commentCount = commenting
    ? commenting.comments.filter((c) => c.path === file.path).length
    : 0;

  function handleFindingsBadgeClick(e: React.MouseEvent) {
    e.stopPropagation();
    setOpen(true);
    if (findings && findings.length > 0) {
      setJumpLine(Math.min(...findings.map((f) => f.line)));
    }
  }

  return (
    <div style={s.fileCard}>
      <div onClick={() => setOpen((o) => !o)} style={s.fileHeader}>
        <Icon.ChevronRight size={13} style={chevronFor(open)} />
        <Icon.FileText size={14} style={s.fileIcon} />
        <span className="mono" style={s.filePath}>
          {file.path}
        </span>
        <span className="mono tnum" style={s.fileStat}>
          <span style={s.addText}>+{file.additions}</span>{" "}
          <span style={s.delText}>−{file.deletions}</span>
        </span>
        {findings && findings.length > 0 && (
          <button
            type="button"
            onClick={handleFindingsBadgeClick}
            style={s.findingsBadge}
            aria-label={t("diffViewer.jumpToFindings", { count: findings.length })}
          >
            <Icon.AlertTriangle size={12} />
            {t("diffViewer.findingsBadge", { count: findings.length })}
          </button>
        )}
        {commentCount > 0 && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)" }}
          >
            <Icon.MessageSquare size={12} />
            {commentCount}
          </span>
        )}
      </div>
      {open && (
        <div style={s.fileBody} ref={bodyRef}>
          {lines.length === 0 ? (
            <div style={s.noDiff}>{t("diffViewer.noDiffText")}</div>
          ) : (
            lines.map((ln, i) => (
              <CodeLine
                key={i}
                ln={ln}
                path={file.path}
                threads={threadsForLine(ln, matched)}
                commenting={commenting}
                findings={ln.newNo != null ? findingsByLine.get(ln.newNo) : undefined}
              />
            ))
          )}
          {commenting && commenting.showComments && <OutdatedComments threads={outdated} />}
        </div>
      )}
    </div>
  );
}
