import type { CSSProperties } from "react";

/** Co-located styles for the agent editor's Evals tab. */
export const s = {
  section: { marginBottom: 28 } satisfies CSSProperties,
  sectionHead: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 10,
  } satisfies CSSProperties,
  heading: { fontSize: 15, fontWeight: 700 } satisfies CSSProperties,
  list: { display: "flex", flexDirection: "column", gap: 8 } satisfies CSSProperties,
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "9px 14px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
  } satisfies CSSProperties,
  caseName: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  caseRange: { fontSize: 12, color: "var(--text-muted)" } satisfies CSSProperties,
  muted: { fontSize: 13, color: "var(--text-muted)" } satisfies CSSProperties,
  errorNote: { fontSize: 13, color: "var(--crit)" } satisfies CSSProperties,
  inFlightNote: { fontSize: 13, color: "var(--warn)" } satisfies CSSProperties,
  runRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  metricsRow: {
    display: "flex",
    gap: 24,
    flexWrap: "wrap",
    marginTop: 12,
  } satisfies CSSProperties,
  metric: { display: "flex", flexDirection: "column", gap: 2 } satisfies CSSProperties,
  metricLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  metricValue: { fontSize: 18, fontWeight: 700 } satisfies CSSProperties,
  historyMeta: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    fontSize: 12,
    color: "var(--text-secondary)",
    flexWrap: "wrap",
  } satisfies CSSProperties,
  compareGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(90px, 1fr) 1fr 1fr 1fr",
    gap: "6px 16px",
    alignItems: "center",
    fontSize: 13,
  } satisfies CSSProperties,
  compareHead: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  delta: { fontSize: 12, color: "var(--text-secondary)" } satisfies CSSProperties,
  perCaseOutcome: (tone: "pass" | "fail" | "error" | "missing"): CSSProperties => ({
    fontSize: 12,
    fontWeight: 600,
    color:
      tone === "pass"
        ? "var(--ok)"
        : tone === "fail"
          ? "var(--crit)"
          : tone === "error"
            ? "var(--warn)"
            : "var(--text-muted)",
  }),
} as const;
