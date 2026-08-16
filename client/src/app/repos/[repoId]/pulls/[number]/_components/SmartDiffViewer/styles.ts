import type { CSSProperties } from "react";

export const s = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 18,
  } satisfies CSSProperties,
  summary: {
    fontSize: 12,
    color: "var(--text-muted)",
    marginBottom: -6,
  } satisfies CSSProperties,
  splitBanner: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "12px 14px",
    borderRadius: 8,
    border: "1px solid var(--warn)",
    background: "var(--warn-bg, transparent)",
  } satisfies CSSProperties,
  splitTitle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    fontWeight: 700,
    color: "var(--warn)",
  } satisfies CSSProperties,
  splitBody: {
    fontSize: 13,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  splitList: {
    margin: 0,
    paddingLeft: 18,
    fontSize: 13,
    color: "var(--text-secondary)",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  } satisfies CSSProperties,
  group: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } satisfies CSSProperties,
  /** The group heading is a full-width reset `<button>` — clicking it
   *  collapses/expands the whole section's file list. */
  groupHeadingButton: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    width: "100%",
    padding: 0,
    border: "none",
    background: "none",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    color: "inherit",
  } satisfies CSSProperties,
  groupChevron: {
    color: "var(--text-muted)",
    flexShrink: 0,
  } satisfies CSSProperties,
  groupDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  } satisfies CSSProperties,
  groupLabel: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  groupCount: {
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  groupHint: {
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  groupFiles: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } satisfies CSSProperties,
} as const;

/** Rotates the group's chevron to point down when its section is expanded —
 *  mirrors `diff-viewer`'s own `chevronFor`, kept local since that helper
 *  isn't part of `diff-viewer`'s public surface (see its `index.ts`). */
export function groupChevronRotation(open: boolean): CSSProperties {
  return {
    transform: open ? "rotate(90deg)" : "none",
    transition: "transform .12s",
  };
}
