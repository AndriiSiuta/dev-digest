/* EvalDashboard — workspace-wide eval health: total case count plus the most
   recent batches across all agents, newest first (AC-36). States are mutually
   exclusive early-return branches; zero batches is an explicit empty state,
   never an error (AC-37). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import { useEvalDashboard } from "@/lib/hooks/eval";
import { s } from "./styles";

/** "0.545" → "54.5%", "1" → "100%". */
function fmtPct(v: number): string {
  return `${+(v * 100).toFixed(1)}%`;
}

/** `toLocaleString`, with the raw ISO kept when it is unparseable. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function EvalDashboard() {
  const t = useTranslations("eval");
  const { data, isLoading, isError, refetch } = useEvalDashboard();

  if (isLoading) {
    return (
      <div style={s.page}>
        <h1 style={s.heading}>{t("dashboard.defaultTitle")}</h1>
        <p style={s.summary}>{t("dashboard.loading")}</p>
        <div style={s.skeletonRows}>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div style={s.page}>
        <h1 style={s.heading}>{t("dashboard.defaultTitle")}</h1>
        <ErrorState body={t("dashboard.loadError")} onRetry={() => void refetch()} />
      </div>
    );
  }

  if (data.recent.length === 0) {
    return (
      <div style={s.page}>
        <h1 style={s.heading}>{t("dashboard.defaultTitle")}</h1>
        <p style={s.summary}>{t("dashboard.casesTotal", { count: data.cases_total })}</p>
        <EmptyState icon="BarChart" title={t("dashboard.recentRuns")} body={t("dashboard.noRuns")} />
      </div>
    );
  }

  return (
    <div style={s.page}>
      <h1 style={s.heading}>{t("dashboard.defaultTitle")}</h1>
      <p style={s.summary}>{t("dashboard.casesTotal", { count: data.cases_total })}</p>
      <h2 style={s.sectionTitle}>{t("dashboard.recentRuns")}</h2>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>{t("dashboard.table.agent")}</th>
            <th style={s.th}>{t("dashboard.table.ranAt")}</th>
            <th style={s.th}>{t("dashboard.table.recall")}</th>
            <th style={s.th}>{t("dashboard.table.precision")}</th>
            <th style={s.th}>{t("dashboard.table.citation")}</th>
          </tr>
        </thead>
        <tbody>
          {data.recent.map((b) => (
            <tr key={b.batch_id}>
              <td style={{ ...s.td, ...s.agentCell }}>{b.agent_name}</td>
              <td style={s.td}>{formatWhen(b.ran_at)}</td>
              <td className="mono" style={s.td}>
                {fmtPct(b.recall)}
              </td>
              <td className="mono" style={s.td}>
                {fmtPct(b.precision)}
              </td>
              <td className="mono" style={s.td}>
                {fmtPct(b.citation_accuracy)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
