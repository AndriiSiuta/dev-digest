/* BlastCard — the PR's blast radius: what the diff touches and who is
   downstream of it. States (mutually exclusive, early-return branches):
   loading skeleton → error note → empty (no changed symbols) → populated:
   an inline header stat row (symbols / callers / endpoints / crons), a
   collapsible per-symbol tree (symbol → callers → endpoint/cron badges,
   SmartDiffViewer's aria-expanded + Set-based toggle pattern), and a
   collapsed "Prior PRs touching these files" footer. A degraded note rides
   WITH the populated content on the ripgrep fallback. Tree only — no Graph
   toggle (deferred). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, EmptyState, Icon, Skeleton } from "@devdigest/ui";
import type { BlastPanel } from "@devdigest/shared";
import { useBlastPanel } from "@/lib/hooks/blast";
import { s, chevronRotation, chevronFlip } from "./styles";

interface BlastCardProps {
  prId: string | null;
}

/** Shared card frame so every state renders under the same header. */
function CardShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={s.card}>
      <div style={s.header}>
        <span style={s.title}>
          <Icon.GitBranch size={14} style={{ color: "var(--accent)" }} />
          {title}
        </span>
      </div>
      {children}
    </section>
  );
}

/** Distinct unions + totals for the header stats — derived, never stored. */
function deriveCounts(blast: BlastPanel["blast"]) {
  const endpoints = new Set<string>();
  const crons = new Set<string>();
  let callers = 0;
  for (const entry of blast.downstream) {
    callers += entry.callers.length;
    for (const e of entry.endpoints_affected) endpoints.add(e);
    for (const c of entry.crons_affected) crons.add(c);
  }
  return { symbols: blast.changed_symbols.length, callers, endpoints: endpoints.size, crons: crons.size };
}

/** `name()` for callable kinds, bare name for classes/interfaces/etc. */
function displayName(name: string, kind: string): string {
  return kind === "function" || kind === "method" ? `${name}()` : name;
}

function Stat({
  icon,
  count,
  label,
}: {
  icon: keyof typeof Icon;
  count: number;
  label: string;
}) {
  const I = Icon[icon];
  return (
    <span style={s.stat}>
      <I size={14} style={s.statIcon} />
      <span className="tnum" style={s.statCount}>
        {count}
      </span>
      <span style={s.statLabel}>{label}</span>
    </span>
  );
}

export function BlastCard({ prId }: BlastCardProps) {
  const t = useTranslations("blast");
  const { data, isLoading, isError } = useBlastPanel(prId);
  // Per-symbol expand state (Set of downstream symbols) — every entry starts
  // collapsed; the header stats carry the overview.
  const [expandedSymbols, setExpandedSymbols] = React.useState<Set<string>>(() => new Set());
  const [historyOpen, setHistoryOpen] = React.useState(false); // collapsed by default

  function toggleSymbol(symbol: string) {
    setExpandedSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  }

  if (isLoading) {
    return (
      <CardShell title={t("card.title")}>
        <div style={s.skeletonRows}>
          <Skeleton width="60%" />
          <Skeleton width="90%" />
          <Skeleton width="75%" />
        </div>
      </CardShell>
    );
  }

  if (isError || !data) {
    return (
      <CardShell title={t("card.title")}>
        <span style={s.errorNote}>{t("card.error")}</span>
      </CardShell>
    );
  }

  if (data.blast.changed_symbols.length === 0) {
    return (
      <CardShell title={t("card.title")}>
        <EmptyState icon="GitBranch" title={t("card.emptyTitle")} body={t("card.emptyBody")} />
      </CardShell>
    );
  }

  const counts = deriveCounts(data.blast);
  const downstreamBySymbol = new Map(data.blast.downstream.map((d) => [d.symbol, d]));
  // Every changed symbol gets a row; the ones with callers sort first.
  const symbolRows = [...data.blast.changed_symbols].sort(
    (a, b) =>
      (downstreamBySymbol.get(b.name)?.callers.length ?? 0) -
      (downstreamBySymbol.get(a.name)?.callers.length ?? 0),
  );
  const history = data.history.history;

  return (
    <CardShell title={t("card.title")}>
      <div style={s.stats}>
        <Stat icon="Code" count={counts.symbols} label={t("stat.symbols", { count: counts.symbols })} />
        <Stat
          icon="CornerDownRight"
          count={counts.callers}
          label={t("stat.callers", { count: counts.callers })}
        />
        <Stat
          icon="Globe"
          count={counts.endpoints}
          label={t("stat.endpoints", { count: counts.endpoints })}
        />
        <Stat icon="Clock" count={counts.crons} label={t("stat.crons", { count: counts.crons })} />
      </div>

      {data.degraded && (
        <div style={s.degraded}>
          <Icon.AlertTriangle size={13} />
          {t("card.degraded")}
        </div>
      )}

      <div style={s.tree}>
        {symbolRows.map((sym) => {
          const entry = downstreamBySymbol.get(sym.name);
          const callerCount = entry?.callers.length ?? 0;
          const expandable = callerCount > 0;
          const expanded = expandable && expandedSymbols.has(sym.name);
          const rowInner = (
            <>
              {expandable ? (
                <Icon.ChevronRight size={13} style={{ ...s.chevron, ...chevronRotation(expanded) }} />
              ) : (
                <span style={s.chevronSpacer} />
              )}
              <Icon.Code size={14} style={s.symbolIcon} />
              <span style={s.symbolName}>{displayName(sym.name, sym.kind)}</span>
              <span style={s.symbolCount}>{t("callerCount", { count: callerCount })}</span>
            </>
          );
          return (
            <div key={`${sym.name}:${sym.file}`}>
              {expandable ? (
                <button
                  type="button"
                  onClick={() => toggleSymbol(sym.name)}
                  aria-expanded={expanded}
                  style={{
                    ...s.symbolRow,
                    ...s.symbolRowButton,
                    ...(expanded ? s.symbolRowExpanded : null),
                  }}
                >
                  {rowInner}
                </button>
              ) : (
                <div style={s.symbolRow}>{rowInner}</div>
              )}
              {expanded && entry && (
                <>
                  <ul style={s.callerList}>
                    {entry.callers.map((caller, i) => (
                      <li key={`${caller.file}:${caller.line}:${i}`} style={s.callerRow}>
                        <Icon.CornerDownRight size={13} style={s.callerArrow} />
                        <span className="mono" style={s.callerLoc}>
                          {caller.file}:{caller.line}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {(entry.endpoints_affected.length > 0 || entry.crons_affected.length > 0) && (
                    <div style={s.factBadges}>
                      {entry.endpoints_affected.map((endpoint) => (
                        <Badge
                          key={endpoint}
                          icon="Globe"
                          mono
                          color="var(--accent-text)"
                          bg="var(--accent-bg)"
                        >
                          {endpoint}
                        </Badge>
                      ))}
                      {entry.crons_affected.map((cron) => (
                        <Badge key={cron} icon="Clock" mono color="var(--warn)" bg="var(--warn-bg)">
                          {cron}
                        </Badge>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      <div style={s.historySection}>
        <div style={s.historyBox}>
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-expanded={historyOpen}
            style={s.historyButton}
          >
            <Icon.History size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
            {t("history.title")}
            <span className="tnum" style={s.historyCount}>
              {history.length}
            </span>
            <Icon.ChevronDown size={14} style={{ ...s.historyChevron, ...chevronFlip(historyOpen) }} />
          </button>
          {historyOpen &&
            (history.length === 0 ? (
              <div style={s.historyEmpty}>{t("history.empty")}</div>
            ) : (
              <ul style={s.historyList}>
                {history.map((item) => (
                  <li key={item.pr_number} style={s.historyRow}>
                    <span style={s.historyTitle}>
                      #{item.pr_number} {item.title} — {item.author}
                    </span>
                    <span style={s.historyMeta}>
                      {t("history.overlapCount", { count: item.files_overlap.length })}
                      {" · "}
                      {item.merged_at ? item.merged_at.slice(0, 10) : t("history.noDate")}
                    </span>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </div>
    </CardShell>
  );
}
