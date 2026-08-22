import type { CSSProperties } from "react";

export const s = {
  card: {
    padding: "14px 16px",
    borderRadius: 8,
    border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)",
  } satisfies CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  } satisfies CSSProperties,
  title: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--text-primary)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 8,
  } satisfies CSSProperties,
  // Header stats — inline icon + bold count + muted label (no chip boxes).
  stats: {
    display: "flex",
    alignItems: "center",
    gap: 18,
    flexWrap: "wrap",
    marginBottom: 12,
  } satisfies CSSProperties,
  stat: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
  } satisfies CSSProperties,
  statIcon: {
    color: "var(--text-muted)",
    flexShrink: 0,
  } satisfies CSSProperties,
  statCount: {
    fontWeight: 700,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  statLabel: {
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  degraded: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
    fontSize: 12,
    color: "var(--warn)",
  } satisfies CSSProperties,
  tree: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  } satisfies CSSProperties,
  symbolRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 10px",
    border: "none",
    borderRadius: 8,
    background: "transparent",
    textAlign: "left",
    fontSize: 13,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  symbolRowButton: {
    cursor: "pointer",
  } satisfies CSSProperties,
  symbolRowExpanded: {
    background: "var(--bg-hover)",
  } satisfies CSSProperties,
  symbolIcon: {
    color: "var(--accent)",
    flexShrink: 0,
  } satisfies CSSProperties,
  symbolName: {
    fontWeight: 600,
    fontFamily: "var(--mono, monospace)",
  } satisfies CSSProperties,
  symbolCount: {
    marginLeft: "auto",
    fontSize: 12,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  chevron: {
    transition: "transform .12s",
    color: "var(--text-muted)",
    flexShrink: 0,
  } satisfies CSSProperties,
  // Placeholder keeping 0-caller rows column-aligned with expandable ones.
  chevronSpacer: {
    width: 13,
    flexShrink: 0,
  } satisfies CSSProperties,
  // Caller rows hang off a vertical guide line under the chevron column.
  callerList: {
    margin: "2px 0 4px 16px",
    padding: "2px 0 4px 6px",
    borderLeft: "1px solid var(--border)",
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } satisfies CSSProperties,
  callerRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
  } satisfies CSSProperties,
  callerArrow: {
    color: "var(--text-muted)",
    flexShrink: 0,
  } satisfies CSSProperties,
  callerLoc: {
    fontFamily: "var(--mono, monospace)",
    fontSize: 12.5,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  factBadges: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    padding: "2px 0 10px 22px",
  } satisfies CSSProperties,
  historySection: {
    marginTop: 14,
    borderTop: "1px solid var(--border)",
    paddingTop: 12,
  } satisfies CSSProperties,
  historyBox: {
    border: "1px solid var(--border)",
    borderRadius: 8,
  } satisfies CSSProperties,
  historyButton: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "10px 12px",
    border: "none",
    borderRadius: 8,
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  historyCount: {
    padding: "1px 8px",
    borderRadius: 6,
    background: "var(--bg-hover)",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  historyChevron: {
    marginLeft: "auto",
    transition: "transform .12s",
    color: "var(--text-muted)",
    flexShrink: 0,
  } satisfies CSSProperties,
  historyList: {
    margin: 0,
    padding: "0 12px 10px 34px",
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } satisfies CSSProperties,
  historyRow: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    flexWrap: "wrap",
    fontSize: 13,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  historyTitle: {
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  historyMeta: {
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  historyEmpty: {
    fontSize: 13,
    color: "var(--text-muted)",
    padding: "0 12px 10px 34px",
  } satisfies CSSProperties,
  errorNote: {
    fontSize: 13,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  skeletonRows: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } satisfies CSSProperties,
} as const;

export function chevronRotation(expanded: boolean): CSSProperties {
  return { transform: expanded ? "rotate(90deg)" : "none" };
}

/** For the footer's down-chevron: points up while the section is open. */
export function chevronFlip(open: boolean): CSSProperties {
  return { transform: open ? "rotate(180deg)" : "none" };
}
