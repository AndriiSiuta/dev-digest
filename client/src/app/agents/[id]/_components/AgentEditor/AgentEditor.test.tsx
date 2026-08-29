import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Agent, Repo } from "@devdigest/shared";
import messages from "../../../../../../messages/en/agents.json";
import contextMessages from "../../../../../../messages/en/context.json";
import { ToastProvider } from "../../../../../lib/toast";

// Mock the data hooks so the editor renders without a network/query client.
vi.mock("../../../../../lib/hooks/agents", () => ({
  useUpdateAgent: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, data: undefined }),
  useProviderModels: () => ({ data: [{ id: "gpt-4.1", provider: "openai" }] }),
}));

// The Context tab pulls repositories and their documents. Mocked here for the
// same reason as above — vitest keys mocks by RESOLVED module, so these cover
// `ContextTab` and the shared `ContextDocPicker` under it too.
const REPOS: Repo[] = [
  {
    id: "repo-a",
    workspace_id: "w1",
    owner: "acme",
    name: "payments-api",
    full_name: "acme/payments-api",
    default_branch: "main",
    clone_path: null,
    last_polled_at: null,
    created_by: null,
  },
];

vi.mock("../../../../../lib/hooks/core", () => ({
  useRepos: () => ({ data: REPOS, isLoading: false, isError: false }),
}));

vi.mock("../../../../../lib/hooks/project-context", () => ({
  useContextDocuments: () => ({
    data: [{ path: "specs/api.md", type: "spec", bytes: 2048 }],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useContextDocumentContent: () => ({ data: undefined, isLoading: false, isError: false }),
  useContextSearchRoots: () => ({
    data: { search_roots: ["specs", "docs", "insights"] },
    isLoading: false,
    isError: false,
  }),
  useAgentContextDocs: () => ({ data: [], isLoading: false, isError: false }),
  useSetAgentContextDocs: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AgentEditor } from "./AgentEditor";
import { TABS, VALID_TABS } from "./constants";

afterEach(cleanup);

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

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ agents: messages, context: contextMessages }}>
      <ToastProvider>{ui}</ToastProvider>
    </NextIntlClientProvider>,
  );
}

describe("A2 Agent Editor (smoke)", () => {
  it("renders the Config tab fields", () => {
    renderWithIntl(<AgentEditor agent={AGENT} tab="config" onTab={() => {}} />);
    expect(screen.getByText("Config")).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByText("Save agent")).toBeInTheDocument();
  });

  /* The Context tab shipped reachable in the tab strip but rejected by the
     route, which hardcoded its own ["config", "skills"] whitelist. These two
     assertions are the guard: the whitelist is derived from TABS, and
     tab="context" actually renders the Context tab, not Config. */
  it("accepts every tab in the strip as a ?tab= value", () => {
    expect(VALID_TABS).toEqual(TABS.map((tb) => tb.key));
    for (const tb of TABS) expect(VALID_TABS).toContain(tb.key);
  });

  it("renders the Context tab, not Config, for tab=context", () => {
    renderWithIntl(<AgentEditor agent={AGENT} tab="context" onTab={() => {}} />);
    expect(screen.getByText(contextMessages.title)).toBeInTheDocument();
    expect(screen.getByTestId("context-doc-specs/api.md")).toBeInTheDocument();
    expect(screen.queryByText("Configuration")).not.toBeInTheDocument();
    expect(screen.queryByText("Save agent")).not.toBeInTheDocument();
  });
});
