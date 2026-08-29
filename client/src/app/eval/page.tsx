/* Route: /eval — the Eval Dashboard: workspace-wide case count and the most
   recent eval batches across all agents. Reachable from the sidebar (g e). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { AppShell } from "../../components/app-shell";
import { EvalDashboard } from "./_components/EvalDashboard";

export default function EvalDashboardPage() {
  const t = useTranslations("eval");
  return (
    <AppShell crumb={[{ label: t("page.crumbSkillsLab") }, { label: t("page.crumbEvalDashboard") }]}>
      <EvalDashboard />
    </AppShell>
  );
}
