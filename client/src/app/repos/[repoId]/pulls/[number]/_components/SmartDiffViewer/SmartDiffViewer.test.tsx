/**
 * SmartDiffViewer — group order (core before boilerplate), the boilerplate
 * group's default-collapsed lock file vs. a small expanded core file, the
 * findings badge expanding + scrolling, whole-section collapse/expand, and
 * the fetch-error state.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { PrFile, SmartDiffResponse } from "@/lib/types";
import type { DiffFocus } from "./SmartDiffViewer";
import prReviewMessages from "../../../../../../../../messages/en/prReview.json";
import shellMessages from "../../../../../../../../messages/en/shell.json";

let mockState: {
  data: SmartDiffResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};

vi.mock("@/lib/hooks", () => ({
  useSmartDiff: () => mockState,
}));

import { SmartDiffViewer } from "./SmartDiffViewer";

beforeEach(() => {
  mockState = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const FILES: PrFile[] = [
  {
    path: "src/core.ts",
    additions: 5,
    deletions: 0,
    patch: "@@ -1,1 +1,2 @@\n const a = 1;\n+const coreLine = 2;",
  },
  {
    path: "pnpm-lock.yaml",
    additions: 400,
    deletions: 0,
    patch: "@@ -1,1 +1,2 @@\n a\n+const lockLine = 1;",
  },
  {
    path: "package.json",
    additions: 300,
    deletions: 0,
    patch: "@@ -1,1 +1,2 @@\n b\n+const pkgLine = 1;",
  },
];

function response(over: Partial<SmartDiffResponse> = {}): SmartDiffResponse {
  return {
    groups: [
      {
        role: "core",
        files: [
          {
            path: "src/core.ts",
            pseudocode_summary: null,
            additions: 5,
            deletions: 0,
            finding_lines: [],
            findings: [],
          },
        ],
      },
      { role: "wiring", files: [] },
      {
        role: "boilerplate",
        files: [
          {
            path: "pnpm-lock.yaml",
            pseudocode_summary: null,
            additions: 400,
            deletions: 0,
            finding_lines: [],
            findings: [],
          },
        ],
      },
    ],
    split_suggestion: { too_big: false, total_lines: 5, proposed_splits: [] },
    ...over,
  };
}

function renderViewer(focus?: DiffFocus | null) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={{ prReview: prReviewMessages, shell: shellMessages }}
    >
      <SmartDiffViewer prId="pr1" files={FILES} focus={focus} />
    </NextIntlClientProvider>
  );
}

describe("SmartDiffViewer — group order and default-open", () => {
  it("renders Core before Boilerplate, with the lock file collapsed and the small core file expanded", () => {
    mockState = { data: response(), isLoading: false, isError: false, refetch: vi.fn() };
    renderViewer();

    const coreHeading = screen.getByText("Core");
    const boilerplateHeading = screen.getByText("Boilerplate");
    expect(
      coreHeading.compareDocumentPosition(boilerplateHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // Small core file starts open.
    expect(screen.getByText("const coreLine = 2;")).toBeInTheDocument();
    // Lock file starts collapsed, despite being far larger.
    expect(screen.queryByText("const lockLine = 1;")).not.toBeInTheDocument();
  });
});

describe("SmartDiffViewer — findings badge", () => {
  it("expands a collapsed (boilerplate) file and scrolls to the finding's line when clicked", () => {
    mockState = {
      data: response({
        groups: [
          { role: "core", files: [] },
          { role: "wiring", files: [] },
          {
            role: "boilerplate",
            files: [
              {
                path: "pnpm-lock.yaml",
                pseudocode_summary: null,
                additions: 400,
                deletions: 0,
                finding_lines: [2],
                findings: [
                  {
                    id: "f1",
                    line: 2,
                    end_line: 2,
                    severity: "WARNING",
                    title: "Unexpected lockfile churn",
                  },
                ],
              },
            ],
          },
        ],
      }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderViewer();

    expect(screen.queryByText("const lockLine = 1;")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Jump to/));
    expect(screen.getByText("const lockLine = 1;")).toBeInTheDocument();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });
});

describe("SmartDiffViewer — section collapse", () => {
  it("collapses and re-expands a whole group's file list on heading click, independent of other groups", () => {
    mockState = { data: response(), isLoading: false, isError: false, refetch: vi.fn() };
    renderViewer();

    const coreToggle = screen.getByRole("button", { name: /Core/ });
    const boilerplateToggle = screen.getByRole("button", { name: /Boilerplate/ });
    expect(coreToggle).toHaveAttribute("aria-expanded", "true");

    // Starts expanded (unchanged default): the core file's line is visible.
    expect(screen.getByText("const coreLine = 2;")).toBeInTheDocument();

    fireEvent.click(coreToggle);
    expect(coreToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("const coreLine = 2;")).not.toBeInTheDocument();
    // The heading itself — label, dot, file count — stays visible while collapsed.
    expect(screen.getByText("Core")).toBeInTheDocument();
    // Collapsing Core does not touch Boilerplate's own (independent) state.
    expect(boilerplateToggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(coreToggle);
    expect(coreToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("const coreLine = 2;")).toBeInTheDocument();
  });
});

describe("SmartDiffViewer — error state", () => {
  it("shows an error state with retry when the fetch fails", () => {
    const refetch = vi.fn();
    mockState = { data: undefined, isLoading: false, isError: true, refetch };
    renderViewer();

    expect(screen.getByText("Couldn't load Smart Diff")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Retry"));
    expect(refetch).toHaveBeenCalled();
  });
});

describe("SmartDiffViewer — deep-link focus", () => {
  /** Two boilerplate files: the group is the one that always starts with its
   *  files collapsed, so it is the case AC-46 names. */
  function twoBoilerplateFiles(): SmartDiffResponse {
    return response({
      groups: [
        { role: "core", files: [] },
        { role: "wiring", files: [] },
        {
          role: "boilerplate",
          files: [
            {
              path: "pnpm-lock.yaml",
              pseudocode_summary: null,
              additions: 400,
              deletions: 0,
              finding_lines: [],
              findings: [],
            },
            {
              path: "package.json",
              pseudocode_summary: null,
              additions: 300,
              deletions: 0,
              finding_lines: [],
              findings: [],
            },
          ],
        },
      ],
    });
  }

  it("expands the focused file in a collapsed group, leaving its siblings collapsed", () => {
    mockState = { data: twoBoilerplateFiles(), isLoading: false, isError: false, refetch: vi.fn() };
    renderViewer({ file: "pnpm-lock.yaml", line: 2 });

    expect(screen.getByText("const lockLine = 1;")).toBeInTheDocument();
    expect(screen.queryByText("const pkgLine = 1;")).not.toBeInTheDocument();
  });

  it("re-opens a whole group the reviewer had collapsed when the focus lands inside it", () => {
    mockState = { data: twoBoilerplateFiles(), isLoading: false, isError: false, refetch: vi.fn() };
    const { rerender } = renderViewer();

    const boilerplateToggle = screen.getByRole("button", { name: /Boilerplate/ });
    fireEvent.click(boilerplateToggle);
    expect(boilerplateToggle).toHaveAttribute("aria-expanded", "false");

    rerender(
      <NextIntlClientProvider
        locale="en"
        messages={{ prReview: prReviewMessages, shell: shellMessages }}
      >
        <SmartDiffViewer prId="pr1" files={FILES} focus={{ file: "pnpm-lock.yaml", line: 2 }} />
      </NextIntlClientProvider>
    );

    expect(screen.getByRole("button", { name: /Boilerplate/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getByText("const lockLine = 1;")).toBeInTheDocument();
  });
});
