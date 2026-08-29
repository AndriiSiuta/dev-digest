/* EvalsTab — the agent's frozen eval-case set, the single batch-run control,
   the batch history, and the two-batch comparison. Cases are born from decided
   findings on a PR (there is no editor here); a run executes the whole set
   synchronously and the response is rendered as the latest result. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Checkbox, EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import { EvalExpectation } from "@devdigest/shared";
import type { EvalBatchDetail, EvalBatchSummary, EvalCase, EvalRunRecord } from "@devdigest/shared";
import { ApiError } from "@/lib/api";
import { EMPTY, formatCostUsd } from "@/lib/format";
import {
  useAgentEvalCases,
  useDeleteEvalCase,
  useEvalBatch,
  useEvalBatches,
  useRunEvalBatch,
} from "@/lib/hooks/eval";
import { COMPARE_LIMIT, KIND_COLOR, SKELETON_ROWS } from "./constants";
import { s } from "./styles";

/** "0.545" → "54.5%", "1" → "100%". */
function fmtPct(v: number): string {
  return `${+(v * 100).toFixed(1)}%`;
}

/** Signed delta between two ratio metrics, e.g. "+12.5%" / "-20%". */
function fmtDelta(a: number, b: number): string {
  const d = +((b - a) * 100).toFixed(1);
  return `${d > 0 ? "+" : ""}${d}%`;
}

/** `toLocaleString`, with the raw ISO kept when it is unparseable. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** The per-case cell state a comparison side renders. */
function outcomeOf(r: EvalRunRecord | undefined): "pass" | "fail" | "error" | "missing" {
  if (!r) return "missing";
  if (r.error != null) return "error";
  if (r.pass === true) return "pass";
  if (r.pass === false) return "fail";
  return "missing";
}

/** Align two batches' rows by `case_id`; a case present on one side only keeps
    the other side's cell empty (AC-35). */
function alignCases(a: EvalRunRecord[], b: EvalRunRecord[]) {
  const byA = new Map(a.map((r) => [r.case_id, r]));
  const byB = new Map(b.map((r) => [r.case_id, r]));
  const ids = [
    ...a.map((r) => r.case_id),
    ...b.filter((r) => !byA.has(r.case_id)).map((r) => r.case_id),
  ];
  return ids.map((caseId) => ({
    caseId,
    name: byA.get(caseId)?.case_name ?? byB.get(caseId)?.case_name ?? caseId,
    a: byA.get(caseId),
    b: byB.get(caseId),
  }));
}

function MetricBlock({ label, value }: { label: string; value: string }) {
  return (
    <div style={s.metric}>
      <span style={s.metricLabel}>{label}</span>
      <span className="mono" style={s.metricValue}>
        {value}
      </span>
    </div>
  );
}

/** One frozen case: name, expectation-kind badge, target range, delete. */
function CaseRow({
  c,
  deleteLabel,
  kindLabel,
  kindColor,
  onDelete,
  disabled,
}: {
  c: EvalCase;
  deleteLabel: string;
  kindLabel: string;
  kindColor: string;
  onDelete: () => void;
  disabled: boolean;
}) {
  const exp = EvalExpectation.safeParse(c.expected_output);
  return (
    <div style={s.row} data-testid={`eval-case-row-${c.id}`}>
      <span style={s.caseName}>{c.name}</span>
      <Badge color={kindColor}>{kindLabel}</Badge>
      {exp.success && (
        <span className="mono" style={s.caseRange}>
          {exp.data.file}:{exp.data.start_line}–{exp.data.end_line}
        </span>
      )}
      <Button kind="ghost" size="sm" icon="Trash" disabled={disabled} onClick={onDelete}>
        {deleteLabel}
      </Button>
    </div>
  );
}

/** One history batch: select toggle, time, version, model, metrics, cost. */
function BatchRow({
  b,
  selected,
  onToggle,
  versionLabel,
  costLabel,
}: {
  b: EvalBatchSummary;
  selected: boolean;
  onToggle: () => void;
  versionLabel: string;
  costLabel: string;
}) {
  return (
    <div style={s.row} data-testid={`eval-batch-row-${b.batch_id}`}>
      <Checkbox checked={selected} onChange={onToggle} label={formatWhen(b.ran_at)} />
      <span style={{ flex: 1 }} />
      <div style={s.historyMeta}>
        <Badge color="var(--accent)">{versionLabel}</Badge>
        <span className="mono">{b.model}</span>
        <span className="mono">{fmtPct(b.recall)}</span>
        <span className="mono">{fmtPct(b.precision)}</span>
        <span className="mono">{fmtPct(b.citation_accuracy)}</span>
        <span className="mono">
          {costLabel}: {formatCostUsd(b.cost_usd)}
        </span>
      </div>
    </div>
  );
}

/** Side-by-side metrics + per-case outcomes for the two selected batches. */
function ComparisonPanel({
  a,
  b,
  versionLabel,
  t,
}: {
  a: EvalBatchDetail;
  b: EvalBatchDetail;
  versionLabel: (v: number | null) => string;
  t: ReturnType<typeof useTranslations<"eval">>;
}) {
  const metrics = [
    { label: t("evalsTab.metrics.recall"), a: a.recall, b: b.recall },
    { label: t("evalsTab.metrics.precision"), a: a.precision, b: b.precision },
    { label: t("evalsTab.metrics.citation"), a: a.citation_accuracy, b: b.citation_accuracy },
  ];
  const rows = alignCases(a.results, b.results);
  const outcomeLabel = {
    pass: t("evalsTab.casePass"),
    fail: t("evalsTab.caseFail"),
    error: t("evalsTab.caseError"),
    missing: t("evalsTab.caseMissing"),
  } as const;
  return (
    <div>
      <div style={s.compareGrid}>
        <span />
        <span className="mono" style={s.compareHead}>
          {versionLabel(a.agent_version)} · {a.model}
        </span>
        <span className="mono" style={s.compareHead}>
          {versionLabel(b.agent_version)} · {b.model}
        </span>
        <span style={s.compareHead}>{t("evalsTab.delta", { value: "" }).trim()}</span>
        {metrics.map((m) => (
          <React.Fragment key={m.label}>
            <span>{m.label}</span>
            <span className="mono">{fmtPct(m.a)}</span>
            <span className="mono">{fmtPct(m.b)}</span>
            <span className="mono" style={s.delta}>
              {fmtDelta(m.a, m.b)}
            </span>
          </React.Fragment>
        ))}
      </div>
      <h4 style={{ ...s.heading, fontSize: 13, margin: "16px 0 8px" }}>
        {t("evalsTab.perCaseHeading")}
      </h4>
      <div style={s.compareGrid}>
        {rows.map((row) => (
          <React.Fragment key={row.caseId}>
            <span style={s.caseName}>{row.name}</span>
            <span style={s.perCaseOutcome(outcomeOf(row.a))}>{outcomeLabel[outcomeOf(row.a)]}</span>
            <span style={s.perCaseOutcome(outcomeOf(row.b))}>{outcomeLabel[outcomeOf(row.b)]}</span>
            <span />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export function EvalsTab({
  agentId,
  agentVersion,
  model,
}: {
  agentId: string;
  agentVersion: number;
  model: string;
}) {
  const t = useTranslations("eval");
  const cases = useAgentEvalCases(agentId);
  const deleteCase = useDeleteEvalCase(agentId);
  const run = useRunEvalBatch(agentId);
  const batches = useEvalBatches(agentId);

  /** Batch ids picked for comparison; a third pick replaces the older one. */
  const [selected, setSelected] = React.useState<string[]>([]);
  const toggleSelect = (id: string) =>
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length < COMPARE_LIMIT
          ? [...prev, id]
          : [...prev.slice(1), id],
    );
  const [aId, bId] = selected.length === COMPARE_LIMIT ? selected : [null, null];
  const batchA = useEvalBatch(agentId, aId);
  const batchB = useEvalBatch(agentId, bId);

  const versionLabel = (v: number | null) =>
    v != null ? t("evalsTab.version", { version: v }) : t("evalsTab.versionUnknown");

  if (cases.isError || batches.isError) {
    return <ErrorState body={t("evalsTab.loadError")} onRetry={() => void cases.refetch()} />;
  }
  if (cases.isLoading || batches.isLoading) {
    return (
      <div style={s.list}>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <Skeleton key={i} height={40} />
        ))}
      </div>
    );
  }

  const caseList = cases.data ?? [];
  const history = batches.data ?? [];
  const refusedInFlight =
    run.error instanceof ApiError && run.error.code === "eval_run_in_flight";
  const kindMeta = (c: EvalCase): { label: string; color: string } => {
    const exp = EvalExpectation.safeParse(c.expected_output);
    if (!exp.success) return { label: t("evalsTab.kind.unknown"), color: KIND_COLOR.unknown };
    return exp.data.kind === "must_find"
      ? { label: t("evalsTab.kind.mustFind"), color: KIND_COLOR.must_find }
      : { label: t("evalsTab.kind.mustNotFlag"), color: KIND_COLOR.must_not_flag };
  };

  return (
    <div>
      {/* ---- Cases (AC-10) ---- */}
      <div style={s.section}>
        <div style={s.sectionHead}>
          <h3 style={s.heading}>{t("evalsTab.casesHeading")}</h3>
        </div>
        {caseList.length === 0 ? (
          <EmptyState icon="FlaskConical" title={t("evalsTab.casesHeading")} body={t("evalsTab.emptyCases")} />
        ) : (
          <div style={s.list}>
            {caseList.map((c) => {
              const meta = kindMeta(c);
              return (
                <CaseRow
                  key={c.id}
                  c={c}
                  deleteLabel={t("evalsTab.delete")}
                  kindLabel={meta.label}
                  kindColor={meta.color}
                  disabled={deleteCase.isPending}
                  onDelete={() => deleteCase.mutate(c.id)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ---- Run (AC-32/AC-33) ---- */}
      <div style={s.section}>
        <div style={s.runRow}>
          <Button
            kind="primary"
            icon="Play"
            disabled={caseList.length === 0 || run.isPending}
            loading={run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending
              ? t("evalsTab.runningBatch")
              : t("evalsTab.runBatch", { count: caseList.length })}
          </Button>
          <span className="mono" style={s.muted}>
            {versionLabel(agentVersion)} · {model}
          </span>
          {refusedInFlight && <span style={s.inFlightNote}>{t("evalsTab.refusedInFlight")}</span>}
          {run.isError && !refusedInFlight && (
            <span style={s.errorNote}>{t("evalsTab.runError")}</span>
          )}
        </div>
        {run.data && (
          <div style={s.metricsRow}>
            <MetricBlock label={t("evalsTab.metrics.recall")} value={fmtPct(run.data.recall)} />
            <MetricBlock label={t("evalsTab.metrics.precision")} value={fmtPct(run.data.precision)} />
            <MetricBlock
              label={t("evalsTab.metrics.citation")}
              value={fmtPct(run.data.citation_accuracy)}
            />
            <MetricBlock
              label={t("evalsTab.latestHeading")}
              value={t("evalsTab.passedOfTotal", {
                passed: run.data.cases_passed,
                total: run.data.cases_total,
              })}
            />
            {run.data.cases_errored > 0 && (
              <span style={s.errorNote}>
                {t("evalsTab.erroredCount", { count: run.data.cases_errored })}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ---- History (AC-34, AC-26) ---- */}
      <div style={s.section}>
        <div style={s.sectionHead}>
          <h3 style={s.heading}>{t("evalsTab.historyHeading")}</h3>
        </div>
        {history.length === 0 ? (
          <span style={s.muted}>{t("evalsTab.noHistory")}</span>
        ) : (
          <div style={s.list}>
            {history.map((b) => (
              <BatchRow
                key={b.batch_id}
                b={b}
                selected={selected.includes(b.batch_id)}
                onToggle={() => toggleSelect(b.batch_id)}
                versionLabel={versionLabel(b.agent_version)}
                costLabel={t("evalsTab.cost")}
              />
            ))}
          </div>
        )}
      </div>

      {/* ---- Comparison (AC-35) ---- */}
      {history.length > 1 && (
        <div style={s.section}>
          <div style={s.sectionHead}>
            <h3 style={s.heading}>{t("evalsTab.compareHeading")}</h3>
          </div>
          {batchA.data && batchB.data ? (
            <ComparisonPanel a={batchA.data} b={batchB.data} versionLabel={versionLabel} t={t} />
          ) : (
            <span style={s.muted}>
              {selected.length === COMPARE_LIMIT ? EMPTY : t("evalsTab.selectTwo")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
