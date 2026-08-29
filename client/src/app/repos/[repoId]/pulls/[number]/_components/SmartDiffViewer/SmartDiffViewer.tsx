/* SmartDiffViewer — the reviewer-ordered "Files changed" view: files grouped
   core/wiring/boilerplate (server-classified, `GET /pulls/:id/smart-diff`),
   overlaid with the latest review's findings. States (mutually exclusive,
   early-return branches): loading skeleton → error → empty (no files) → the
   grouped list, a split-suggestion banner first when the diff is too big.
   Each group heading is a color-dotted, clickable toggle that collapses the
   whole section's file list independently of any single file's own
   open/closed state — useful for hiding a section you don't care about right
   now (e.g. Wiring) without losing per-file expand state elsewhere. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Skeleton, ErrorState, Icon } from "@devdigest/ui";
import { FileCard, type DiffCommentApi } from "@/components/diff-viewer";
import type { PrFile, SmartDiffFile, SmartDiffRole } from "@/lib/types";
import { useSmartDiff } from "@/lib/hooks";
import {
  AUTO_EXPAND_MAX_LINES,
  ROLE_DOT_COLOR,
  ROLE_HINT_KEY,
  ROLE_LABEL_KEY,
  ROLE_ORDER,
} from "./constants";
import { s, groupChevronRotation } from "./styles";

/**
 * `boilerplate` always starts collapsed, regardless of size or findings —
 * it's the group reviewers are told they can skip. `core`/`wiring` start
 * open when the file carries a finding (surface what matters) or is small
 * enough to read at a glance.
 */
function computeDefaultOpen(role: SmartDiffRole, entry: SmartDiffFile): boolean {
  if (role === "boilerplate") return false;
  return entry.findings.length > 0 || entry.additions + entry.deletions <= AUTO_EXPAND_MAX_LINES;
}

/** A file (and optionally a new-side line) to open on arrival — the PR
 *  brief's review-focus deep link, carried in the page's `?focus=`/`?line=`. */
export interface DiffFocus {
  file: string;
  line: number | null;
}

interface SmartDiffViewerProps {
  prId: string | null;
  /** The PR's persisted files (unified-diff patch text) — Smart Diff carries
   *  the grouping/findings, not the patch, so the two are joined by path. */
  files: PrFile[];
  commenting?: DiffCommentApi;
  focus?: DiffFocus | null;
}

export function SmartDiffViewer({ prId, files, commenting, focus }: SmartDiffViewerProps) {
  const t = useTranslations("prReview");
  const { data, isLoading, isError, refetch } = useSmartDiff(prId);
  // Whole-section collapse, independent of each file's own open/closed state
  // (Set of roles) — starts empty so every group renders expanded, same as
  // before this was added.
  const [collapsedRoles, setCollapsedRoles] = React.useState<Set<SmartDiffRole>>(() => new Set());

  const filesByPath = React.useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  // Arriving on a deep link: if the focused file sits in a group the reviewer
  // collapsed, re-open that group so the file can be seen at all. This
  // synchronizes UI state with a navigation event — it is not derived state,
  // because the collapse is the reviewer's own and only the link overrides it.
  const focusPath = focus?.file ?? null;
  React.useEffect(() => {
    if (!focusPath || !data) return;
    const group = data.groups.find((g) => g.files.some((f) => f.path === focusPath));
    if (!group) return;
    setCollapsedRoles((prev) => {
      if (!prev.has(group.role)) return prev;
      const next = new Set(prev);
      next.delete(group.role);
      return next;
    });
  }, [focusPath, data]);

  function toggleRole(role: SmartDiffRole) {
    setCollapsedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  if (isLoading) {
    return (
      <div style={s.root}>
        <Skeleton height={16} width={160} />
        <Skeleton height={64} />
        <Skeleton height={64} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <ErrorState
        title={t("smartDiff.errorTitle")}
        body={t("smartDiff.errorBody")}
        onRetry={() => refetch()}
      />
    );
  }

  const totalFiles = data.groups.reduce((sum, g) => sum + g.files.length, 0);
  if (totalFiles === 0) {
    return <div style={s.summary}>{t("smartDiff.noFiles")}</div>;
  }

  return (
    <div style={s.root}>
      <div style={s.summary}>{t("smartDiff.summary", { count: totalFiles })}</div>

      {data.split_suggestion.too_big && (
        <div style={s.splitBanner}>
          <div style={s.splitTitle}>
            <Icon.AlertTriangle size={14} />
            {t("smartDiff.largeTitle", { lines: data.split_suggestion.total_lines })}
          </div>
          {data.split_suggestion.proposed_splits.length > 0 && (
            <>
              <div style={s.splitBody}>{t("smartDiff.largeBody")}</div>
              <ul style={s.splitList}>
                {data.split_suggestion.proposed_splits.map((split) => (
                  <li key={split.name}>
                    <span className="mono">{split.name}</span> —{" "}
                    {t("smartDiff.filesCount", { count: split.files.length })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {ROLE_ORDER.map((role) => {
        const group = data.groups.find((g) => g.role === role);
        if (!group || group.files.length === 0) return null;
        const expanded = !collapsedRoles.has(role);
        return (
          <div key={role} style={s.group}>
            <button
              type="button"
              onClick={() => toggleRole(role)}
              aria-expanded={expanded}
              style={s.groupHeadingButton}
            >
              <Icon.ChevronRight
                size={13}
                style={{ ...s.groupChevron, ...groupChevronRotation(expanded) }}
              />
              <span style={{ ...s.groupDot, background: ROLE_DOT_COLOR[role] }} />
              <span style={s.groupLabel}>{t(ROLE_LABEL_KEY[role])}</span>
              <span style={s.groupCount}>
                {t("smartDiff.filesCount", { count: group.files.length })}
              </span>
              <span style={s.groupHint}>{t(ROLE_HINT_KEY[role])}</span>
            </button>
            {expanded && (
              <div style={s.groupFiles}>
                {group.files.map((entry) => {
                  const file = filesByPath.get(entry.path);
                  if (!file) return null; // shouldn't happen — same pr_files source
                  return (
                    <FileCard
                      key={entry.path}
                      file={file}
                      commenting={commenting}
                      defaultOpen={computeDefaultOpen(role, entry)}
                      findings={entry.findings}
                      focus={focus && focus.file === entry.path ? { line: focus.line } : undefined}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
