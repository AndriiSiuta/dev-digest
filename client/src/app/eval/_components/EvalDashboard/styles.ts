import type { CSSProperties } from "react";

/** Co-located styles for the Eval Dashboard. */
export const s = {
  page: { padding: "24px 32px", maxWidth: 1040 } satisfies CSSProperties,
  heading: { fontSize: 20, fontWeight: 700, marginBottom: 6 } satisfies CSSProperties,
  summary: {
    fontSize: 13,
    color: "var(--text-muted)",
    marginBottom: 20,
  } satisfies CSSProperties,
  sectionTitle: {
    fontSize: 15,
    fontWeight: 700,
    margin: "18px 0 10px",
  } satisfies CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 } satisfies CSSProperties,
  th: {
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
    padding: "6px 12px",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  td: {
    padding: "8px 12px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  agentCell: { fontWeight: 600, color: "var(--text-primary)" } satisfies CSSProperties,
  skeletonRows: { display: "flex", flexDirection: "column", gap: 8 } satisfies CSSProperties,
} as const;
