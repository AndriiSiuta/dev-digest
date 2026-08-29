/**
 * OverviewTab — the PR Brief surface: the brief card renders alongside (and
 * replaces neither of) the Intent and Blast cards, the description below, and
 * a review-focus activation propagates out to the page's `onFocusFile`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { PrBriefRecord } from "@devdigest/shared";
import intentMessages from "../../../../../../../../messages/en/intent.json";
import blastMessages from "../../../../../../../../messages/en/blast.json";
import briefMessages from "../../../../../../../../messages/en/brief.json";

vi.mock("@/lib/hooks/intent", () => ({
  usePrIntent: () => ({ data: undefined, isLoading: true, isError: false }),
  useClassifyIntent: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/hooks/blast", () => ({
  useBlastPanel: () => ({ data: undefined, isLoading: true, isError: false }),
}));

const BRIEF: PrBriefRecord = {
  pr_id: "pr1",
  head_sha: "abc123",
  pr_head_sha: "abc123",
  model: "gpt-4.1",
  generated_at: "2026-08-29T10:00:00.000Z",
  brief: {
    what: "Adds rate limiting.",
    why: "Every review run is a paid model call.",
    risk_level: "low",
    risks: [],
    review_focus: [{ file: "src/a.ts", line: 12, reason: "The limiter is wired here." }],
    degraded: false,
    missing_inputs: [],
  },
};

vi.mock("@/lib/hooks/brief", () => ({
  usePrBrief: () => ({ data: BRIEF, isLoading: false, isError: false }),
  useGenerateBrief: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { OverviewTab } from "./OverviewTab";

afterEach(cleanup);

function renderTab(onFocusFile = vi.fn()) {
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{ intent: intentMessages, blast: blastMessages, brief: briefMessages }}
    >
      <OverviewTab
        prId="pr1"
        headSha="abc123"
        prBody="This PR adds rate limiting."
        onFocusFile={onFocusFile}
      />
    </NextIntlClientProvider>
  );
  return onFocusFile;
}

describe("OverviewTab", () => {
  it("renders the Brief, Intent and Blast cards, and the description, together", () => {
    renderTab();

    expect(screen.getByText("PR Brief")).toBeInTheDocument();
    expect(screen.getByText("PR intent & scope")).toBeInTheDocument();
    expect(screen.getByText("Blast Radius")).toBeInTheDocument();
    expect(screen.getByText("Description")).toBeInTheDocument();
    expect(screen.getByText("This PR adds rate limiting.")).toBeInTheDocument();
  });

  it("propagates a review-focus activation to the page's onFocusFile", () => {
    const onFocusFile = renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Open src/a.ts in Files changed" }));
    expect(onFocusFile).toHaveBeenCalledWith("src/a.ts", 12);
  });
});
