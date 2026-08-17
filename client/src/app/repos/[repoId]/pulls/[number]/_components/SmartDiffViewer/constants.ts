/** Constants for SmartDiffViewer. */
import type { SmartDiffRole } from "@/lib/types";

/** Group render order — mirrors the server's `ROLE_ORDER`. */
export const ROLE_ORDER: SmartDiffRole[] = ["core", "wiring", "boilerplate"];

/** i18n key (relative to the `prReview` namespace) for each role's heading label. */
export const ROLE_LABEL_KEY: Record<SmartDiffRole, string> = {
  core: "smartDiff.coreLabel",
  wiring: "smartDiff.wiringLabel",
  boilerplate: "smartDiff.boilerplateLabel",
};

/** i18n key (relative to the `prReview` namespace) for each role's heading hint. */
export const ROLE_HINT_KEY: Record<SmartDiffRole, string> = {
  core: "smartDiff.coreHint",
  wiring: "smartDiff.wiringHint",
  boilerplate: "smartDiff.boilerplateHint",
};

/**
 * Color of the small dot rendered before each group heading — a fast visual
 * anchor for "which role am I looking at" that doesn't depend on reading the
 * label. Reuses existing theme tokens rather than inventing new colors:
 * core (the substance of the change) gets the accent color, wiring gets the
 * warn/amber color, boilerplate gets the neutral info/gray color.
 */
export const ROLE_DOT_COLOR: Record<SmartDiffRole, string> = {
  core: "var(--accent)",
  wiring: "var(--warn)",
  boilerplate: "var(--info)",
};

/**
 * `boilerplate` always starts collapsed, regardless of size or findings — it
 * is the group reviewers are told to skip. `core`/`wiring` files start open
 * when they carry a finding (surface the thing that matters) or are small
 * enough to read at a glance (mirrors `diff-viewer`'s own
 * `AUTO_EXPAND_MAX_LINES` default).
 */
export const AUTO_EXPAND_MAX_LINES = 200;
