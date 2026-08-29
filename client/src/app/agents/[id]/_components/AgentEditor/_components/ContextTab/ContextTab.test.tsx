import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Agent, AgentContextDocLink, ProjectContextDoc, Repo } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/context.json";
import { ToastProvider } from "../../../../../../../lib/toast";

/**
 * The agent editor's Context tab — filter, preview and attachment (AC-04,
 * AC-05, AC-06, AC-26).
 *
 * `fireEvent`, not `userEvent`: `@testing-library/user-event` is NOT a
 * dependency of this package and must not be added for a test
 * (`client/INSIGHTS.md`, 2026-08-20).
 */

const setDocs = vi.fn();
let currentRepoId: string | null = null;

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
  {
    id: "repo-b",
    workspace_id: "w1",
    owner: "acme",
    name: "billing",
    full_name: "acme/billing",
    default_branch: "main",
    clone_path: null,
    last_polled_at: null,
    created_by: null,
  },
];

const DOCS: Record<string, ProjectContextDoc[]> = {
  "repo-a": [
    { path: "specs/api.md", type: "spec", bytes: 2048 },
    { path: "docs/db.md", type: "doc", bytes: 1024 },
    { path: "insights/notes.md", type: "insight", bytes: 512 },
  ],
  "repo-b": [{ path: "docs/billing.md", type: "doc", bytes: 700 }],
};

const ATTACHED: AgentContextDocLink[] = [
  { agent_id: "ag1", repo_id: "repo-b", path: "docs/billing.md", order: 0, enabled: true },
];

vi.mock("../../../../../../../lib/hooks/core", () => ({
  useRepos: () => ({ data: REPOS, isLoading: false, isError: false }),
}));

vi.mock("../../../../../../../lib/hooks/project-context", () => ({
  useContextDocuments: (repoId: string | null) => {
    currentRepoId = repoId;
    return { data: DOCS[repoId ?? ""] ?? [], isLoading: false, isError: false, refetch: vi.fn() };
  },
  useContextDocumentContent: (_repoId: string | null, path: string | null) => ({
    data: path ? { path, content: `CONTENT OF ${path}` } : undefined,
    isLoading: false,
    isError: false,
  }),
  useContextSearchRoots: () => ({
    data: { search_roots: ["specs", "docs", "insights"] },
    isLoading: false,
    isError: false,
  }),
  useAgentContextDocs: () => ({ data: ATTACHED, isLoading: false, isError: false }),
  useSetAgentContextDocs: () => ({ mutate: setDocs, isPending: false }),
}));

// Both mocks above cover the shared `ContextDocPicker` too: vitest keys mocks
// by RESOLVED module, and the picker imports the same two modules.

import { ContextTab } from "./ContextTab";

const AGENT: Agent = {
  id: "ag1",
  name: "Test Quality Reviewer",
  description: "Reviews tests",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "Review the tests.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled: true,
  version: 3,
};

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ context: messages }}>
      <ToastProvider>
        <ContextTab agent={AGENT} />
      </ToastProvider>
    </NextIntlClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  setDocs.mockClear();
  currentRepoId = null;
});

describe("ContextTab", () => {
  it("lists the repo's documents, filters by path, and ticking saves that repo's set (AC-04, AC-07, AC-26)", () => {
    renderTab();
    // The first repository is selected by default and its documents are listed.
    expect(screen.getByTestId("context-doc-specs/api.md")).toBeInTheDocument();
    expect(screen.getByTestId("context-doc-docs/db.md")).toBeInTheDocument();
    expect(screen.getByTestId("context-doc-insights/notes.md")).toBeInTheDocument();

    // Filter (AC-04): only matching paths survive.
    fireEvent.change(screen.getByLabelText("Filter by path"), { target: { value: "specs/" } });
    expect(screen.getByTestId("context-doc-specs/api.md")).toBeInTheDocument();
    expect(screen.queryByTestId("context-doc-docs/db.md")).not.toBeInTheDocument();
    expect(screen.queryByTestId("context-doc-insights/notes.md")).not.toBeInTheDocument();

    // Tick it: the mutation carries THIS repo's id and the path.
    const row = screen.getByTestId("context-doc-specs/api.md");
    fireEvent.click(within(row).getByRole("checkbox"));
    expect(setDocs).toHaveBeenCalledTimes(1);
    expect(setDocs.mock.calls[0]![0]).toEqual({
      agentId: "ag1",
      repoId: "repo-a",
      docs: [{ path: "specs/api.md" }],
    });
  });

  it("previewing a document renders it read-only and does NOT attach it (AC-05, AC-06)", () => {
    renderTab();
    fireEvent.click(screen.getByLabelText("Preview: docs/db.md"));

    const preview = screen.getByTestId("context-preview");
    expect(within(preview).getByText("CONTENT OF docs/db.md")).toBeInTheDocument();
    expect(within(preview).getByText("Read-only. Opening a document here does not attach it.")).toBeInTheDocument();
    // The whole point of AC-06: selecting is not ticking.
    expect(setDocs).not.toHaveBeenCalled();
    const row = screen.getByTestId("context-doc-docs/db.md");
    expect(within(row).getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
  });

  it("switching repository re-lists and scopes the next tick to the new repo (AC-26)", () => {
    renderTab();
    expect(currentRepoId).toBe("repo-a");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "repo-b" } });
    expect(currentRepoId).toBe("repo-b");
    expect(screen.getByTestId("context-doc-docs/billing.md")).toBeInTheDocument();
    expect(screen.queryByTestId("context-doc-specs/api.md")).not.toBeInTheDocument();

    // repo-b's existing attachment shows as ticked, and untick sends repo-b's
    // (now empty) set — repo-a's attachments are not in the body at all.
    const row = screen.getByTestId("context-doc-docs/billing.md");
    expect(within(row).getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(row).getByRole("checkbox"));
    expect(setDocs.mock.calls[0]![0]).toEqual({
      agentId: "ag1",
      repoId: "repo-b",
      docs: [],
    });
  });
});
