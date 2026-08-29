import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { RunTrace } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/runs.json"; // apps/web/messages/en/runs.json

// Mock the trace hooks so the drawer renders without a query client / SSE.
const TRACE: RunTrace = {
  config: { agent: "Security", version: "1", provider: "openai", model: "gpt-4.1", pr: 482, source: "local" },
  stats: { duration_ms: 8200, tokens_in: 12000, tokens_out: 1500, cost_usd: 0.06, findings: 2, grounding: "2/2 passed" },
  prompt_assembly: { system: "You are a reviewer.", skills: "### skill", memory: null, specs: null, user: "Review PR #482" },
  tool_calls: [{ tool: "review_file", args: "src/config.ts", meta: "single-pass", ms: 1200 }],
  raw_output: '{"verdict":"request_changes"}',
  memory_pulled: [{ pr: 471, text: "rate-limit public endpoints" }],
  specs_read: [],
  log: [
    { t: "00.10", kind: "info", msg: "Starting review with agent Security" },
    { t: "00.90", kind: "result", msg: "Citation grounding: 2/2 passed" },
  ],
};

vi.mock("../../../../../../../lib/hooks/trace", () => ({
  useRunTrace: () => ({ data: TRACE, isLoading: false }),
}));
vi.mock("../../../../../../../lib/hooks/reviews", () => ({
  useRunEvents: () => ({ events: [], running: false }),
}));

import RunTraceDrawer from "./RunTraceDrawer";
import { normalizeSpecsRead } from "./helpers";

afterEach(cleanup);

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ runs: messages }}>
      <div data-theme="dark">{ui}</div>
    </NextIntlClientProvider>,
  );
}

describe("A5 Run Trace drawer (smoke)", () => {
  it("renders the trace tabs and stats", () => {
    renderWithIntl(<RunTraceDrawer runId="r1" agentName="Security" prNumber={482} onClose={() => {}} />);
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByText("Stats")).toBeInTheDocument();
    expect(screen.getByText("2/2 passed")).toBeInTheDocument();
    expect(screen.getByText("Tool calls")).toBeInTheDocument();
  });

  it("switches to the live log tab", () => {
    renderWithIntl(<RunTraceDrawer runId="r1" agentName="Security" prNumber={482} onClose={() => {}} />);
    fireEvent.click(screen.getByText("log"));
    // LiveLogStream renders its filter input
    expect(screen.getByPlaceholderText("Filter log…")).toBeInTheDocument();
  });

  it("renders each project-context document with its path and token count (AC-15)", () => {
    TRACE.specs_read = [
      { path: "specs/api.md", tokens: 412, status: "included" },
      { path: "docs/gone.md", tokens: 0, status: "unreachable" },
      { path: "docs/big.md", tokens: 0, status: "omitted" },
    ];
    renderWithIntl(<RunTraceDrawer runId="r1" agentName="Security" prNumber={482} onClose={() => {}} />);
    expect(screen.getByText("specs/api.md")).toBeInTheDocument();
    expect(screen.getByText("412 tok")).toBeInTheDocument();
    // The two non-included states are visually distinct and named.
    expect(screen.getByText("docs/gone.md")).toBeInTheDocument();
    expect(screen.getByText("unreachable")).toBeInTheDocument();
    expect(screen.getByText("docs/big.md")).toBeInTheDocument();
    expect(screen.getByText("omitted — over the context budget")).toBeInTheDocument();
    TRACE.specs_read = [];
  });

  it("renders a legacy string[] specs_read as paths, not [object Object] (AC-15)", () => {
    // Historical rows are read with a CAST, not a parse, on the server, so the
    // pre-widening shape still arrives here at runtime.
    TRACE.specs_read = ["specs/security-baseline.md"] as unknown as RunTrace["specs_read"];
    renderWithIntl(<RunTraceDrawer runId="r1" agentName="Security" prNumber={482} onClose={() => {}} />);
    expect(screen.getByText("specs/security-baseline.md")).toBeInTheDocument();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
    TRACE.specs_read = [];
  });

  it("keeps the empty state when nothing was read", () => {
    renderWithIntl(<RunTraceDrawer runId="r1" agentName="Security" prNumber={482} onClose={() => {}} />);
    expect(screen.getByText("Specs read")).toBeInTheDocument();
    expect(screen.getAllByText("none").length).toBeGreaterThan(0);
  });
});

describe("normalizeSpecsRead", () => {
  it("accepts both the current object shape and the legacy string[]", () => {
    expect(
      normalizeSpecsRead([
        { path: "a.md", tokens: 10, status: "included" },
      ] as RunTrace["specs_read"]),
    ).toEqual([{ path: "a.md", tokens: 10, status: "included" }]);

    expect(normalizeSpecsRead(["b.md"] as unknown as RunTrace["specs_read"])).toEqual([
      { path: "b.md", tokens: 0, status: "included" },
    ]);
  });
});
