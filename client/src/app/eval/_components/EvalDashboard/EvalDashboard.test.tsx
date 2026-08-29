/**
 * EvalDashboard — the populated table (AC-36), the explicit no-runs empty
 * state (AC-37), and the mechanical "reachable from the sidebar" check on the
 * vendored NAV registry.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { NAV } from "@devdigest/ui";
import type { EvalDashboardView } from "@devdigest/shared";
import evalMessages from "../../../../../messages/en/eval.json";

let mockState: {
  data: EvalDashboardView | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: ReturnType<typeof vi.fn>;
};

vi.mock("@/lib/hooks/eval", () => ({
  useEvalDashboard: () => mockState,
}));

import { EvalDashboard } from "./EvalDashboard";

beforeEach(() => {
  mockState = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
});
afterEach(cleanup);

function renderDashboard() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
      <EvalDashboard />
    </NextIntlClientProvider>,
  );
}

const batch = (over: Partial<EvalDashboardView["recent"][number]> = {}) => ({
  batch_id: "b1",
  agent_id: "ag1",
  agent_name: "Security Reviewer",
  agent_version: 3,
  model: "gpt-4.1",
  ran_at: "2026-08-29T10:00:00.000Z",
  cases_total: 8,
  cases_errored: 0,
  cases_passed: 6,
  recall: 0.8,
  precision: 0.6,
  citation_accuracy: 0.545,
  duration_ms: 9000,
  cost_usd: 0.02,
  ...over,
});

describe("EvalDashboard", () => {
  it("renders agent names, times and the three metrics for recent batches (AC-36)", () => {
    mockState = {
      data: {
        cases_total: 9,
        recent: [
          batch(),
          batch({ batch_id: "b2", agent_id: "ag2", agent_name: "Perf Reviewer", recall: 1 }),
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderDashboard();

    expect(screen.getByText("Security Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Perf Reviewer")).toBeInTheDocument();
    expect(screen.getAllByText("80%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("60%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("54.5%").length).toBeGreaterThan(0);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText(evalMessages.dashboard.table.agent)).toBeInTheDocument();
  });

  it("renders the explicit empty state — no table, no error UI (AC-37)", () => {
    mockState = {
      data: { cases_total: 3, recent: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderDashboard();

    expect(screen.getByText(evalMessages.dashboard.noRuns)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(evalMessages.dashboard.loadError)).not.toBeInTheDocument();
  });

  it("is reachable from the left sidebar via the vendored NAV registry (AC-36)", () => {
    const items = NAV.flatMap((g) => g.items);
    expect(items.some((it) => it.key === "eval" && it.href === "/eval")).toBe(true);
  });
});
