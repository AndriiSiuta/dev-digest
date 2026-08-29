import type { IconName } from "@devdigest/ui";

/** Editor tab descriptor. `labelKey` resolves under the `agents` namespace. */
export interface EditorTab {
  key: string;
  labelKey: string;
  icon: IconName;
}

/** Editor tabs. Evals / Stats / CI arrive with their own lessons. */
export const TABS: readonly EditorTab[] = [
  { key: "config", labelKey: "editor.tabs.config", icon: "Settings" },
  { key: "skills", labelKey: "editor.tabs.skills", icon: "Sparkles" },
  { key: "context", labelKey: "editor.tabs.context", icon: "FileText" },
];

/** Tab keys accepted in `?tab=`. Derived from `TABS` so the tab strip and the
    route's whitelist cannot drift apart. Mirrors `skills/constants.ts`. */
export const VALID_TABS: readonly string[] = TABS.map((t) => t.key);
