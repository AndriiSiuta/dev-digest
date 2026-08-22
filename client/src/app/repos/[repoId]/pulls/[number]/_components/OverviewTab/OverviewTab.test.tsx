/**
 * OverviewTab — the PR Brief surface: Intent and Blast cards render side by
 * side with the PR description below.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import intentMessages from "../../../../../../../../messages/en/intent.json";
import blastMessages from "../../../../../../../../messages/en/blast.json";

vi.mock("@/lib/hooks/intent", () => ({
  usePrIntent: () => ({ data: undefined, isLoading: true, isError: false }),
  useClassifyIntent: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/hooks/blast", () => ({
  useBlastPanel: () => ({ data: undefined, isLoading: true, isError: false }),
}));

import { OverviewTab } from "./OverviewTab";

afterEach(cleanup);

describe("OverviewTab", () => {
  it("renders the Intent card, the Blast card, and the description together", () => {
    render(
      <NextIntlClientProvider
        locale="en"
        messages={{ intent: intentMessages, blast: blastMessages }}
      >
        <OverviewTab prId="pr1" headSha="abc123" prBody="This PR adds rate limiting." />
      </NextIntlClientProvider>
    );

    expect(screen.getByText("PR intent & scope")).toBeInTheDocument();
    expect(screen.getByText("Blast Radius")).toBeInTheDocument();
    expect(screen.getByText("Description")).toBeInTheDocument();
    expect(screen.getByText("This PR adds rate limiting.")).toBeInTheDocument();
  });
});
