import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Agent } from "@devdigest/shared";

/**
 * The route's `?tab=` whitelist. The Context tab shipped visible in the tab
 * strip but unreachable, because the page carried its own hardcoded
 * `["config", "skills"]` list and silently fell back to Config. The whitelist
 * is now derived from `TABS`, so this asserts every tab in the strip survives
 * the round trip through the URL.
 */

let currentSearch = "";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "ag1" }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("../../../components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const AGENT: Agent = {
  id: "ag1",
  name: "Security Reviewer",
  description: "Flags secrets and injection",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "You are a security reviewer.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled: true,
  version: 1,
};

vi.mock("../../../lib/hooks/agents", () => ({
  useAgents: () => ({ data: [] }),
  useAgent: () => ({ data: AGENT, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useUpdateAgent: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The editor has its own hook graph; this page test only asserts which tab it
// is asked to render.
vi.mock("./_components/AgentEditor", () => ({
  AgentEditor: ({ tab }: { tab: string }) => <div data-testid="editor">tab: {tab}</div>,
}));

import AgentEditorPage from "./page";
import { TABS } from "./_components/AgentEditor/constants";

afterEach(cleanup);

describe("/agents/:id — ?tab= routing", () => {
  it.each(TABS.map((tb) => tb.key))("passes ?tab=%s through to the editor", (key) => {
    currentSearch = `tab=${key}`;
    render(<AgentEditorPage />);
    expect(screen.getByTestId("editor")).toHaveTextContent(`tab: ${key}`);
  });

  it("falls back to config for an unknown tab", () => {
    currentSearch = "tab=nope";
    render(<AgentEditorPage />);
    expect(screen.getByTestId("editor")).toHaveTextContent("tab: config");
  });
});
