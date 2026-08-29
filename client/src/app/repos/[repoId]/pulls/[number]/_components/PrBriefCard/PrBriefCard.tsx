/* PrBriefCard — the PR's Why + Risk brief, above the Intent and Blast cards.
   States (mutually exclusive, early-return branches): loading skeleton →
   error note → empty ("not generated yet" + an explicit Generate CTA; a 404
   is an empty state, never an error) → the brief: what/why, a risk-level
   badge, the risks, and the review-focus list whose items deep-link into the
   Files-changed tab. Nothing here generates a brief on render — the two
   controls are the only call sites, which is what AC-38 protects. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, EmptyState, Icon, Skeleton } from "@devdigest/ui";
import type { BriefFocusItem, BriefMissingInput, PrBriefRecord } from "@/lib/types";
import type { Risk } from "@devdigest/shared";
import { usePrBrief, useGenerateBrief } from "@/lib/hooks/brief";
import { RISK_LEVEL_META, RISK_SEVERITY_COLOR } from "./constants";
import { s } from "./styles";

interface PrBriefCardProps {
  prId: string | null;
  /** A review-focus item was activated — the page turns this into the
   *  Files-changed deep link. */
  onFocusFile: (file: string, line?: number | null) => void;
}

/** Shared card frame so every state renders under the same header. */
function CardShell({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={s.card}>
      <div style={s.header}>
        <span style={s.title}>
          <Icon.Sparkles size={14} style={{ color: "var(--accent)" }} />
          {title}
        </span>
        {right}
      </div>
      {children}
    </section>
  );
}

function RiskItem({ risk }: { risk: Risk }) {
  return (
    <li style={s.riskItem}>
      <Icon.AlertTriangle size={13} style={{ color: RISK_SEVERITY_COLOR[risk.severity], flexShrink: 0, marginTop: 3 }} />
      <div style={s.riskBody}>
        <div style={s.riskTitle}>{risk.title}</div>
        <div style={s.riskExplanation}>{risk.explanation}</div>
        {risk.file_refs.length > 0 && (
          <div className="mono" style={s.riskRefs}>
            {risk.file_refs.join(" · ")}
          </div>
        )}
      </div>
    </li>
  );
}

function FocusItem({
  item,
  label,
  onActivate,
}: {
  item: BriefFocusItem;
  label: string;
  onActivate: () => void;
}) {
  return (
    <button type="button" style={s.focusItem} aria-label={label} onClick={onActivate}>
      <Icon.ArrowRight size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
      <span style={s.focusReason}>{item.reason}</span>
      <span className="mono" style={s.focusFile}>
        {item.line != null ? `${item.file}:${item.line}` : item.file}
      </span>
    </button>
  );
}

/** `toLocaleString`, with the raw ISO kept when it is unparseable. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function PrBriefCard({ prId, onFocusFile }: PrBriefCardProps) {
  const t = useTranslations("brief");
  const { data: record, isLoading, isError } = usePrBrief(prId);
  const generate = useGenerateBrief(prId);
  const pending = generate.isPending;

  // The ONLY two call sites — no effect in this component fires a mutation.
  const handleGenerate = React.useCallback(() => {
    generate.mutate(undefined);
  }, [generate]);
  const handleRegenerate = React.useCallback(() => {
    generate.mutate({ force: true });
  }, [generate]);

  const describeMissing = (missing: BriefMissingInput[]) =>
    missing
      .map((m) =>
        t("missing.entry", {
          kind: t(`missing.kind.${m.kind}`),
          status: t(`missing.status.${m.status}`),
        })
      )
      .join(", ");

  if (isLoading) {
    return (
      <CardShell title={t("title")}>
        <div style={s.skeletonRows}>
          <Skeleton width="70%" />
          <Skeleton width="90%" />
          <Skeleton width="55%" />
        </div>
      </CardShell>
    );
  }

  if (isError) {
    return (
      <CardShell title={t("title")}>
        <span style={s.errorNote}>{t("error")}</span>
      </CardShell>
    );
  }

  // A 404 lands here as `null`, not as an error: never generated is an EMPTY
  // state with an explicit action, not a failure (AC-39, AC-NF-09).
  if (!record) {
    return (
      <CardShell title={t("title")}>
        <EmptyState icon="Sparkles" title={t("unavailable")} body={t("unavailableHint")} />
        <div style={s.emptyActions}>
          <Button
            kind="primary"
            icon="Sparkles"
            loading={pending}
            disabled={pending}
            onClick={handleGenerate}
          >
            {t("generate")}
          </Button>
        </div>
        {pending && (
          <div style={s.pendingNote}>
            <Icon.RefreshCw size={12} />
            {t("pending")}
          </div>
        )}
      </CardShell>
    );
  }

  const brief: PrBriefRecord["brief"] = record.brief;
  const level = RISK_LEVEL_META[brief.risk_level];
  const outdated = record.head_sha !== record.pr_head_sha;

  return (
    <CardShell
      title={t("title")}
      right={
        <>
          <Badge color={level.color} bg={level.bg} icon={level.icon}>
            {t("riskLevel.label")}: {t(level.labelKey)}
          </Badge>
          <Button
            kind={outdated ? "primary" : "ghost"}
            size="sm"
            icon="RefreshCw"
            loading={pending}
            disabled={pending}
            onClick={handleRegenerate}
          >
            {t("regenerate")}
          </Button>
        </>
      }
    >
      <div style={s.levelHint}>{t("riskLevel.hint")}</div>

      <div style={s.section}>
        <div style={s.sectionLabel}>{t("what")}</div>
        <div style={s.prose}>{brief.what}</div>
      </div>

      <div style={s.section}>
        <div style={s.sectionLabel}>{t("why")}</div>
        <div style={s.prose}>{brief.why}</div>
      </div>

      <div style={s.section}>
        <div style={s.sectionLabel}>{t("block.risks")}</div>
        {brief.risks.length === 0 ? (
          <span style={s.none}>{t("noRisks")}</span>
        ) : (
          <ul style={s.riskList}>
            {brief.risks.map((risk, i) => (
              <RiskItem key={i} risk={risk} />
            ))}
          </ul>
        )}
      </div>

      {brief.review_focus.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionLabel}>{t("reviewFocus.title")}</div>
          <div style={s.focusList}>
            {brief.review_focus.map((item, i) => (
              <FocusItem
                key={i}
                item={item}
                label={t("reviewFocus.open", { file: item.file })}
                onActivate={() => onFocusFile(item.file, item.line ?? null)}
              />
            ))}
          </div>
        </div>
      )}

      {brief.degraded && brief.missing_inputs.length > 0 && (
        <div style={s.degraded}>
          <Icon.EyeOff size={13} />
          {t("missing.note", { inputs: describeMissing(brief.missing_inputs) })}
        </div>
      )}

      {outdated && (
        <div style={s.stale}>
          <Icon.AlertTriangle size={14} />
          {t("outdated")}
        </div>
      )}

      {pending && (
        <div style={s.pendingNote}>
          <Icon.RefreshCw size={12} />
          {t("pending")}
        </div>
      )}

      <div style={s.provenance}>
        {t("generatedBy", {
          model: record.model ?? t("unknownModel"),
          when: formatWhen(record.generated_at),
        })}
      </div>
    </CardShell>
  );
}
