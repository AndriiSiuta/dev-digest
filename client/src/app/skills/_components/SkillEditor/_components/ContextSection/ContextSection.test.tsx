import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ProjectContextDoc, Repo, Skill, SkillContextDocLink } from "@devdigest/shared";
import messages from "../../../../../../../messages/en/context.json";
import { ToastProvider } from "../../../../../../lib/toast";

/**
 * The skill editor's "Project context to use" section (AC-08).
 *
 * `fireEvent`, not `userEvent` — `@testing-library/user-event` is not a
 * dependency here (`client/INSIGHTS.md`, 2026-08-20).
 */

const setDocs = vi.fn();

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

const DOCS: ProjectContextDoc[] = [
  { path: "specs/api.md", type: "spec", bytes: 2048 },
  { path: "docs/db.md", type: "doc", bytes: 1024 },
];

const ATTACHED: SkillContextDocLink[] = [];

vi.mock("../../../../../../lib/hooks/core", () => ({
  useRepos: () => ({ data: REPOS, isLoading: false, isError: false }),
}));

vi.mock("../../../../../../lib/hooks/project-context", () => ({
  useContextDocuments: () => ({ data: DOCS, isLoading: false, isError: false, refetch: vi.fn() }),
  useContextDocumentContent: () => ({ data: undefined, isLoading: false, isError: false }),
  useContextSearchRoots: () => ({
    data: { search_roots: ["specs", "docs", "insights"] },
    isLoading: false,
    isError: false,
  }),
  useSkillContextDocs: () => ({ data: ATTACHED, isLoading: false, isError: false }),
  useSetSkillContextDocs: () => ({ mutate: setDocs, isPending: false }),
}));

import { ContextSection } from "./ContextSection";

const SKILL: Skill = {
  id: "s1",
  name: "PR Quality Rubric",
  description: "Evaluate the pull request.",
  type: "rubric",
  source: "manual",
  body: "# rubric",
  enabled: true,
  version: 3,
  evidence_files: null,
};

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ context: messages }}>
      <ToastProvider>
        <ContextSection skill={SKILL} />
      </ToastProvider>
    </NextIntlClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => setDocs.mockClear());

describe("ContextSection", () => {
  it("renders under the 'Project context to use' heading and attaches with repo_id + path (AC-08)", () => {
    renderSection();
    // The exact wording AC-08 is checked on.
    expect(
      screen.getByRole("heading", { name: "Project context to use" }),
    ).toBeInTheDocument();

    // Picking a repository lists its documents…
    expect(screen.getByRole("combobox")).toHaveValue("repo-a");
    expect(screen.getByTestId("context-doc-specs/api.md")).toBeInTheDocument();

    // …and ticking one calls the SKILL mutation with the repo and the path.
    const row = screen.getByTestId("context-doc-specs/api.md");
    fireEvent.click(within(row).getByRole("checkbox"));
    expect(setDocs).toHaveBeenCalledTimes(1);
    expect(setDocs.mock.calls[0]![0]).toEqual({
      skillId: "s1",
      repoId: "repo-a",
      docs: [{ path: "specs/api.md" }],
    });
  });
});
