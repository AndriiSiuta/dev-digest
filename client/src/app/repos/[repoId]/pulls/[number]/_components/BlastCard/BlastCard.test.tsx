/**
 * BlastCard — the four states (loading / empty / degraded / populated), the
 * per-symbol expand flow, the collapsed-by-default Prior-PRs footer, and the
 * negative acceptance criterion: no Graph toggle exists in the DOM.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
// `fireEvent`, not `@testing-library/user-event` — the latter is not a
// dependency of this package; fireEvent is the established harness here
// (see SmartDiffViewer.test.tsx).
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { BlastPanel } from "@devdigest/shared";
import blastMessages from "../../../../../../../../messages/en/blast.json";

let mockState: {
  data: BlastPanel | undefined;
  isLoading: boolean;
  isError: boolean;
};

vi.mock("@/lib/hooks/blast", () => ({
  useBlastPanel: () => mockState,
}));

import { BlastCard } from "./BlastCard";

beforeEach(() => {
  mockState = { data: undefined, isLoading: true, isError: false };
});
afterEach(cleanup);

function panel(over: Partial<BlastPanel> = {}): BlastPanel {
  return {
    blast: {
      changed_symbols: [
        { name: "parseDiff", file: "src/diff.ts", kind: "function" },
        { name: "lonely", file: "src/lonely.ts", kind: "function" },
      ],
      downstream: [
        {
          symbol: "parseDiff",
          callers: [
            { name: "runReview", file: "src/review.ts", line: 42 },
            { name: "buildBrief", file: "src/brief.ts", line: 7 },
          ],
          endpoints_affected: ["GET /reviews"],
          crons_affected: ["nightly-sync"],
        },
      ],
      summary: "2 symbols · 2 callers · 1 endpoint · 1 cron",
    },
    history: {
      history: [
        {
          pr_number: 12,
          title: "Earlier change",
          author: "octocat",
          merged_at: "2026-08-10T00:00:00.000Z",
          files_overlap: ["src/diff.ts"],
          notes: "",
        },
        {
          pr_number: 9,
          title: "Older change",
          author: "hubot",
          merged_at: "",
          files_overlap: ["src/diff.ts", "src/brief.ts"],
          notes: "",
        },
      ],
    },
    degraded: false,
    head_sha: "abc123",
    ...over,
  };
}

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ blast: blastMessages }}>
      <BlastCard prId="pr1" />
    </NextIntlClientProvider>
  );
}

describe("BlastCard — loading and empty", () => {
  it("renders the shell without content while loading", () => {
    renderCard();
    expect(screen.getByText("Blast Radius")).toBeInTheDocument();
    expect(screen.queryByText("symbols")).not.toBeInTheDocument();
    expect(screen.queryByText("Prior PRs touching these files")).not.toBeInTheDocument();
  });

  it("shows the empty state when the PR changed no symbols", () => {
    mockState = {
      data: panel({
        blast: { changed_symbols: [], downstream: [], summary: "" },
      }),
      isLoading: false,
      isError: false,
    };
    renderCard();
    expect(screen.getByText("No changed symbols")).toBeInTheDocument();
    expect(screen.queryByText("symbols")).not.toBeInTheDocument();
  });
});

describe("BlastCard — degraded", () => {
  it("renders the degraded note WITH the populated content, and no cron badges", () => {
    const base = panel({ degraded: true });
    base.blast.downstream[0]!.crons_affected = [];
    mockState = { data: base, isLoading: false, isError: false };
    renderCard();

    expect(
      screen.getByText("partial index — endpoints/crons incomplete")
    ).toBeInTheDocument();
    // Populated content still renders alongside the note.
    expect(screen.getByRole("button", { name: /parseDiff/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /parseDiff/ }));
    expect(screen.getByText("GET /reviews")).toBeInTheDocument();
    expect(screen.queryByText("nightly-sync")).not.toBeInTheDocument();
  });
});

describe("BlastCard — populated flow", () => {
  it("shows count chips, expands a symbol to its callers and badges, and expands the collapsed Prior-PRs footer", () => {
    mockState = { data: panel(), isLoading: false, isError: false };
    renderCard();

    // Header stats (inline, count-first): 2 symbols / 2 callers / 1 endpoint
    // / 1 cron — pluralized labels, no chip buttons.
    expect(screen.getByText("symbols").parentElement).toHaveTextContent("2");
    expect(screen.getByText("callers").parentElement).toHaveTextContent("2");
    expect(screen.getByText("endpoint").parentElement).toHaveTextContent("1");
    expect(screen.getByText("cron").parentElement).toHaveTextContent("1");

    // Symbol tree starts collapsed; callable symbols render with parens.
    const symbolToggle = screen.getByRole("button", { name: /parseDiff\(\)/ });
    expect(symbolToggle).toHaveAttribute("aria-expanded", "false");
    expect(symbolToggle).toHaveTextContent("2 callers");
    expect(screen.queryByText("src/review.ts:42")).not.toBeInTheDocument();

    fireEvent.click(symbolToggle);
    expect(symbolToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("src/review.ts:42")).toBeInTheDocument();
    expect(screen.getByText("src/brief.ts:7")).toBeInTheDocument();
    expect(screen.getByText("GET /reviews")).toBeInTheDocument();
    expect(screen.getByText("nightly-sync")).toBeInTheDocument();

    // A changed symbol with no downstream callers still gets a row — static
    // (not a toggle button), showing a zero count.
    expect(screen.getByText("lonely()")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /lonely/ })).not.toBeInTheDocument();
    expect(screen.getByText("0 callers")).toBeInTheDocument();

    // Prior-PRs footer: collapsed by default, header carries the count.
    const historyToggle = screen.getByRole("button", {
      name: /Prior PRs touching these files/,
    });
    expect(historyToggle).toHaveAttribute("aria-expanded", "false");
    expect(historyToggle).toHaveTextContent("2");
    expect(screen.queryByText(/Earlier change/)).not.toBeInTheDocument();

    fireEvent.click(historyToggle);
    expect(screen.getByText("#12 Earlier change — octocat")).toBeInTheDocument();
    expect(screen.getByText(/1 shared file/)).toBeInTheDocument();
    expect(screen.getByText(/2026-08-10/)).toBeInTheDocument();
    // NULL updatedAt row falls back to the no-date copy.
    expect(screen.getByText("#9 Older change — hubot")).toBeInTheDocument();
    expect(screen.getByText(/no date/)).toBeInTheDocument();

    // Acceptance criterion: no Graph toggle exists in the DOM.
    expect(screen.queryByText("graph")).not.toBeInTheDocument();
    expect(screen.queryByText("tree")).not.toBeInTheDocument();
  });
});
