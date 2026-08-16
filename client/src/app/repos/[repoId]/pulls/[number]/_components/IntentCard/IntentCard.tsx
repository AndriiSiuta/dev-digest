/* IntentCard — the PR's derived intent & scope, above the review results.
   States (mutually exclusive, early-return branches): loading skeleton →
   error note → empty ("No intent yet" + classify CTA) → the classification:
   quoted intent, IN/OUT-OF-SCOPE lists, risk-area chips, confidence /
   missing-context badges, and a stale warning when the head moved. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Chip, EmptyState, Icon, Skeleton } from "@devdigest/ui";
import { usePrIntent, useClassifyIntent } from "@/lib/hooks/intent";
import { s } from "./styles";

/** Below this (or with no reported confidence) the card flags the result. */
const LOW_CONFIDENCE_THRESHOLD = 0.6;

interface IntentCardProps {
  prId: string | null;
  /** The PR's current head — a mismatch with the record marks it stale. */
  headSha?: string | null;
}

/** Shared card frame so every state renders under the same header. */
function CardShell({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={s.card}>
      <div style={s.header}>
        <span style={s.title}>
          <Icon.Target size={14} style={{ color: "var(--accent)" }} />
          {title}
        </span>
        {right}
      </div>
      {children}
    </section>
  );
}

function ScopeList({ label, items, noneLabel }: { label: string; items: string[]; noneLabel: string }) {
  return (
    <div style={s.scopeColumn}>
      <div style={s.scopeLabel}>{label}</div>
      {items.length === 0 ? (
        <span style={s.scopeNone}>{noneLabel}</span>
      ) : (
        <ul style={s.scopeList}>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function IntentCard({ prId, headSha }: IntentCardProps) {
  const t = useTranslations("intent");
  const { data: record, isLoading, isError } = usePrIntent(prId);
  const classify = useClassifyIntent(prId);

  const handleClassify = React.useCallback(() => {
    classify.mutate();
  }, [classify]);

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

  if (isError) {
    return (
      <CardShell title={t("card.title")}>
        <span style={s.errorNote}>{t("card.error")}</span>
      </CardShell>
    );
  }

  if (!record) {
    return (
      <CardShell title={t("card.title")}>
        <EmptyState
          icon="Target"
          title={t("card.emptyTitle")}
          body={t("card.emptyBody")}
          cta={t("card.classify")}
          onCta={handleClassify}
          ctaLoading={classify.isPending}
        />
      </CardShell>
    );
  }

  const lowConfidence = record.confidence == null || record.confidence < LOW_CONFIDENCE_THRESHOLD;
  const missingRefs = record.sources
    .filter((src) => src.status === "unreachable" || src.status === "unsupported")
    .map((src) => src.ref);
  const stale = !!headSha && !!record.head_sha && record.head_sha !== headSha;

  return (
    <CardShell
      title={t("card.title")}
      right={
        <>
          {lowConfidence && (
            <Badge color="var(--warn)" bg="transparent" icon="AlertTriangle">
              {t("card.lowConfidence")}
            </Badge>
          )}
          {record.missing_context && (
            <Badge color="var(--warn)" bg="transparent" icon="EyeOff">
              {t("card.missingContext")}
            </Badge>
          )}
          <Button
            kind={stale ? "primary" : "ghost"}
            size="sm"
            icon="RefreshCw"
            loading={classify.isPending}
            disabled={classify.isPending}
            onClick={handleClassify}
          >
            {t("card.reclassify")}
          </Button>
        </>
      }
    >
      <blockquote style={s.intentQuote}>“{record.intent}”</blockquote>

      <div style={s.scopeColumns}>
        <ScopeList label={t("card.inScope")} items={record.in_scope} noneLabel={t("card.none")} />
        <ScopeList label={t("card.outOfScope")} items={record.out_of_scope} noneLabel={t("card.none")} />
      </div>

      {record.risk_areas.length > 0 && (
        <div style={s.riskSection}>
          <div style={s.scopeLabel}>{t("card.riskAreas")}</div>
          <div style={s.riskChips}>
            {record.risk_areas.map((area, i) => (
              <Chip key={i} icon="AlertTriangle">
                {area}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {record.missing_context && missingRefs.length > 0 && (
        <div style={s.missingRefs}>{t("card.missingContextRefs", { refs: missingRefs.join(", ") })}</div>
      )}

      {stale && (
        <div style={s.stale}>
          <Icon.AlertTriangle size={14} />
          {t("card.stale")}
        </div>
      )}
    </CardShell>
  );
}
