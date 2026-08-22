/**
 * FindingsTab — after the Overview restructure the Intent card no longer
 * mounts here; a quiescent tab shows the findings empty state instead.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { useCancelRun } from "../../../../../../../lib/hooks/reviews";

import { FindingsTab } from "./FindingsTab";

afterEach(cleanup);

const cancelMutation = {
  mutate: vi.fn(),
  isPending: false,
} as unknown as ReturnType<typeof useCancelRun>;

describe("FindingsTab", () => {
  it("no longer mounts the Intent card; a quiescent tab shows the findings empty state", () => {
    render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <FindingsTab
          prId="pr1"
          liveRunIds={[]}
          reviewRunning={false}
          lethalTrifecta={[]}
          runs={[]}
          prRuns={[]}
          prCommits={[]}
          cancelMutation={cancelMutation}
          onOpenTrace={vi.fn()}
          onDelete={vi.fn()}
          onRunDone={vi.fn()}
        />
      </NextIntlClientProvider>
    );

    expect(screen.queryByText("PR intent & scope")).not.toBeInTheDocument();
    expect(screen.getByText("No findings yet")).toBeInTheDocument();
  });
});
