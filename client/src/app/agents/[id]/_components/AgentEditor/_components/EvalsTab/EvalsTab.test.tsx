/**
 * EvalsTab — flow tests over the four surfaces: the case list (AC-10), the
 * single run control + latest result (AC-32/AC-33), the batch history
 * (AC-34/AC-26), and the two-batch comparison (AC-35).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
// `fireEvent`, not `@testing-library/user-event` — the latter is not a
// dependency of this package (client INSIGHTS.md 2026-08-20).
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { EvalBatchDetail, EvalBatchSummary, EvalCase, EvalRunRecord } from "@devdigest/shared";
import evalMessages from "../../../../../../../../messages/en/eval.json";

let mockState: {
  cases: {
    data: EvalCase[] | undefined;
    isLoading: boolean;
    isError: boolean;
    refetch: ReturnType<typeof vi.fn>;
  };
  del: { mutate: ReturnType<typeof vi.fn>; isPending: boolean };
  run: {
    mutate: ReturnType<typeof vi.fn>;
    isPending: boolean;
    isError: boolean;
    error: unknown;
    data: EvalBatchDetail | undefined;
  };
  batches: { data: EvalBatchSummary[] | undefined; isLoading: boolean; isError: boolean };
  batchById: Record<string, EvalBatchDetail>;
};

vi.mock("@/lib/hooks/eval", () => ({
  useAgentEvalCases: () => mockState.cases,
  useDeleteEvalCase: () => mockState.del,
  useRunEvalBatch: () => mockState.run,
  useEvalBatches: () => mockState.batches,
  useEvalBatch: (_agentId: string, batchId: string | null | undefined) => ({
    data: batchId != null ? mockState.batchById[batchId] : undefined,
    isLoading: false,
    isError: false,
  }),
}));

import { EvalsTab } from "./EvalsTab";

function makeCase(over: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "c1",
    owner_kind: "agent",
    owner_id: "ag1",
    name: "Hardcoded Stripe secret key",
    input_diff: "@@ -10,3 +10,4 @@\n+  stripeKey: 'sk_live_x'",
    input_files: ["src/config.ts"],
    input_meta: { pr_title: "Add Stripe", pr_body: null, repo: "acme/payments-api", pr_number: 7 },
    expected_output: { kind: "must_find", file: "src/config.ts", start_line: 12, end_line: 14 },
    notes: null,
    ...over,
  };
}

function makeRun(over: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    id: "run1",
    case_id: "c1",
    case_name: "Hardcoded Stripe secret key",
    batch_id: "b1",
    agent_version: 3,
    ran_at: "2026-08-29T10:00:00.000Z",
    actual_output: {},
    pass: true,
    recall: null,
    precision: null,
    citation_accuracy: 1,
    duration_ms: 900,
    cost_usd: 0.001,
    error: null,
    ...over,
  };
}

function makeBatch(over: Partial<EvalBatchDetail> = {}): EvalBatchDetail {
  return {
    batch_id: "b1",
    agent_id: "ag1",
    agent_version: 3,
    model: "gpt-4.1",
    ran_at: "2026-08-29T10:00:00.000Z",
    cases_total: 3,
    cases_errored: 0,
    cases_passed: 2,
    recall: 0.8,
    precision: 0.6,
    citation_accuracy: 0.545,
    duration_ms: 4200,
    cost_usd: 0.01,
    results: [],
    ...over,
  };
}

beforeEach(() => {
  mockState = {
    cases: { data: [], isLoading: false, isError: false, refetch: vi.fn() },
    del: { mutate: vi.fn(), isPending: false },
    run: { mutate: vi.fn(), isPending: false, isError: false, error: null, data: undefined },
    batches: { data: [], isLoading: false, isError: false },
    batchById: {},
  };
});
afterEach(cleanup);

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
      <EvalsTab agentId="ag1" agentVersion={3} model="gpt-4.1" />
    </NextIntlClientProvider>,
  );
}

describe("EvalsTab — cases (AC-10)", () => {
  it("lists cases with name, kind badge and range, deletes by id, and shows the empty copy", () => {
    mockState.cases.data = [
      makeCase(),
      makeCase({
        id: "c2",
        name: "Formatting nit",
        expected_output: { kind: "must_not_flag", file: "src/app.ts", start_line: 4, end_line: 6 },
      }),
    ];
    renderTab();

    expect(screen.getByText("Hardcoded Stripe secret key")).toBeInTheDocument();
    expect(screen.getByText(evalMessages.evalsTab.kind.mustFind)).toBeInTheDocument();
    expect(screen.getByText(evalMessages.evalsTab.kind.mustNotFlag)).toBeInTheDocument();
    expect(screen.getByText("src/config.ts:12–14")).toBeInTheDocument();

    const row = screen.getByTestId("eval-case-row-c2");
    fireEvent.click(within(row).getByText(evalMessages.evalsTab.delete));
    expect(mockState.del.mutate).toHaveBeenCalledTimes(1);
    expect(mockState.del.mutate).toHaveBeenCalledWith("c2");

    // Empty list → the real-creation-path copy, no rows.
    cleanup();
    mockState.cases.data = [];
    renderTab();
    expect(screen.getByText(evalMessages.evalsTab.emptyCases)).toBeInTheDocument();
  });
});

describe("EvalsTab — run (AC-32/AC-33)", () => {
  it("runs once per click, refuses a second trigger while pending, and renders the returned batch", () => {
    mockState.cases.data = [makeCase()];
    renderTab();

    fireEvent.click(screen.getByText("Run eval (1 case)"));
    expect(mockState.run.mutate).toHaveBeenCalledTimes(1);

    // Pending: disabled + pending copy; a click fires nothing more (AC-32).
    cleanup();
    mockState.run.isPending = true;
    renderTab();
    const pendingBtn = screen
      .getByText(evalMessages.evalsTab.runningBatch)
      .closest("button") as HTMLButtonElement;
    expect(pendingBtn).toBeDisabled();
    fireEvent.click(pendingBtn);
    expect(mockState.run.mutate).toHaveBeenCalledTimes(1);

    // Returned detail: three metrics + passed/total (AC-33).
    cleanup();
    mockState.run.isPending = false;
    mockState.run.data = makeBatch({ cases_errored: 1 });
    renderTab();
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText("54.5%")).toBeInTheDocument();
    expect(screen.getByText("2 / 3 passed")).toBeInTheDocument();
    expect(screen.getByText("1 case errored")).toBeInTheDocument();
  });

  it("renders the in-flight refusal as its own outcome, not a generic error", async () => {
    const { ApiError } = await import("@/lib/api");
    mockState.cases.data = [makeCase()];
    mockState.run.isError = true;
    mockState.run.error = new ApiError("in flight", 409, "eval_run_in_flight");
    renderTab();
    expect(screen.getByText(evalMessages.evalsTab.refusedInFlight)).toBeInTheDocument();
    expect(screen.queryByText(evalMessages.evalsTab.runError)).not.toBeInTheDocument();
  });
});

describe("EvalsTab — history (AC-34, AC-26)", () => {
  it("renders batches newest first with version, model and cost labels", () => {
    mockState.batches.data = [
      makeBatch({ batch_id: "b5", agent_version: 5, model: "gpt-5-mini", ran_at: "2026-08-29T12:00:00.000Z", cost_usd: 0.02 }),
      makeBatch({ batch_id: "b3", agent_version: 3, ran_at: "2026-08-28T12:00:00.000Z" }),
    ];
    renderTab();

    const [newest, older] = screen.getAllByTestId(/eval-batch-row-/);
    expect(newest).toBeDefined();
    expect(older).toBeDefined();
    expect(newest).toHaveAttribute("data-testid", "eval-batch-row-b5");
    expect(within(newest!).getByText("v5")).toBeInTheDocument();
    expect(within(newest!).getByText("gpt-5-mini")).toBeInTheDocument();
    expect(within(newest!).getByText(/\$0\.02/)).toBeInTheDocument();
    expect(within(older!).getByText("v3")).toBeInTheDocument();
  });
});

describe("EvalsTab — comparison (AC-35)", () => {
  it("selecting two batches renders both metric columns, deltas, and per-case rows aligned by case_id", () => {
    const runA1 = makeRun({ id: "r1", case_id: "c1", batch_id: "b3", pass: true });
    const runA2 = makeRun({
      id: "r2",
      case_id: "c2",
      case_name: "SQL injection in search",
      batch_id: "b3",
      pass: false,
    });
    const runB1 = makeRun({ id: "r3", case_id: "c1", batch_id: "b5", agent_version: 5, pass: true });
    const runB2 = makeRun({
      id: "r4",
      case_id: "c2",
      case_name: "SQL injection in search",
      batch_id: "b5",
      agent_version: 5,
      pass: null,
      error: "provider timeout",
    });
    mockState.batches.data = [
      makeBatch({ batch_id: "b5", agent_version: 5, model: "gpt-5-mini", recall: 0.6 }),
      makeBatch({ batch_id: "b3", agent_version: 3, recall: 0.8 }),
    ];
    mockState.batchById = {
      b3: makeBatch({ batch_id: "b3", agent_version: 3, recall: 0.8, results: [runA1, runA2] }),
      b5: makeBatch({
        batch_id: "b5",
        agent_version: 5,
        model: "gpt-5-mini",
        recall: 0.6,
        results: [runB1, runB2],
      }),
    };
    renderTab();

    // Until two are picked, the panel invites a selection.
    expect(screen.getByText(evalMessages.evalsTab.selectTwo)).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId("eval-batch-row-b3")).getByRole("checkbox"));
    fireEvent.click(within(screen.getByTestId("eval-batch-row-b5")).getByRole("checkbox"));

    // Both column headers name version + model. ("v3 · gpt-4.1" also appears
    // as the run row's current-agent note, hence getAllByText.)
    expect(screen.getAllByText("v3 · gpt-4.1").length).toBeGreaterThan(0);
    expect(screen.getByText("v5 · gpt-5-mini")).toBeInTheDocument();
    // Signed recall delta: 0.6 − 0.8 = −20%.
    expect(screen.getByText("-20%")).toBeInTheDocument();
    // Per-case rows aligned by case_id, incl. the side that errored.
    expect(screen.getByText("SQL injection in search")).toBeInTheDocument();
    expect(screen.getAllByText(evalMessages.evalsTab.casePass).length).toBeGreaterThan(0);
    expect(screen.getByText(evalMessages.evalsTab.caseFail)).toBeInTheDocument();
    expect(screen.getByText(evalMessages.evalsTab.caseError)).toBeInTheDocument();
  });
});
