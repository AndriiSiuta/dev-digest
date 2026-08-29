import type { IconName } from "@devdigest/ui";
import type { BriefRiskLevel } from "@/lib/types";
import type { RiskSeverity } from "@devdigest/shared";

interface LevelStyle {
  labelKey: string;
  color: string;
  bg: string;
  icon: IconName;
}

/**
 * The whole-PR risk level → its label key and colors. Four entries, `none`
 * included: the level says how much attention the PR needs and is NOT a
 * review verdict, so nothing here reads as approve / request-changes.
 */
export const RISK_LEVEL_META = {
  high: { labelKey: "riskLevel.high", color: "var(--crit)", bg: "var(--crit-bg)", icon: "AlertOctagon" },
  medium: { labelKey: "riskLevel.medium", color: "var(--warn)", bg: "var(--warn-bg)", icon: "AlertTriangle" },
  low: { labelKey: "riskLevel.low", color: "var(--sugg)", bg: "var(--sugg-bg)", icon: "Info" },
  none: { labelKey: "riskLevel.none", color: "var(--ok)", bg: "var(--ok-bg)", icon: "CheckCircle" },
} as const satisfies Record<BriefRiskLevel, LevelStyle>;

/** Per-risk severity (three-valued, unlike the level above). */
export const RISK_SEVERITY_COLOR = {
  high: "var(--crit)",
  medium: "var(--warn)",
  low: "var(--sugg)",
} as const satisfies Record<RiskSeverity, string>;
