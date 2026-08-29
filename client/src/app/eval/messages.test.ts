/**
 * eval.json describes ONLY the built eval surfaces (AC-38). The pre-staged
 * copy promised a manual case editor, a per-case run button and a metric
 * trend chart — none of which exist — so this pins their removal, and the
 * presence of the keys the shipped components actually resolve.
 */
import { describe, it, expect } from "vitest";
import msgs from "../../../messages/en/eval.json";

// The JSON module type only carries the keys that exist; index loosely so the
// absence assertions stay compilable.
const loose = msgs as Record<string, Record<string, unknown> | undefined>;

describe("messages/en/eval.json — built surfaces only (AC-38)", () => {
  it("no longer promises the manual editor, per-case runs, or the trend chart", () => {
    expect(loose.caseEditor).toBeUndefined();
    expect(loose.evalsTab?.run).toBeUndefined();
    expect(loose.evalsTab?.running).toBeUndefined();
    expect(loose.evalsTab?.edit).toBeUndefined();
    expect(loose.evalsTab?.newCase).toBeUndefined();
    expect(loose.dashboard?.metricTrend).toBeUndefined();
    expect(loose.dashboard?.legend).toBeUndefined();
    expect(loose.dashboard?.configure).toBeUndefined();
    expect(loose.page?.crumbNewCase).toBeUndefined();
    expect(loose.page?.crumbEvalCase).toBeUndefined();
  });

  it("keeps the dashboard empty-state string AC-37 renders", () => {
    expect(typeof msgs.dashboard.noRuns).toBe("string");
    expect(msgs.dashboard.noRuns.length).toBeGreaterThan(0);
  });

  it("carries the keys the built surfaces resolve", () => {
    // FindingCard control (AC-11..13)
    expect(typeof msgs.findingAction.add).toBe("string");
    expect(typeof msgs.findingAction.adding).toBe("string");
    expect(typeof msgs.findingAction.added).toBe("string");
    expect(typeof msgs.findingAction.exists).toBe("string");
    // Batch run + latest result (AC-32, AC-33)
    expect(typeof msgs.evalsTab.runBatch).toBe("string");
    expect(typeof msgs.evalsTab.runningBatch).toBe("string");
    expect(typeof msgs.evalsTab.refusedInFlight).toBe("string");
    expect(typeof msgs.evalsTab.passedOfTotal).toBe("string");
    expect(typeof msgs.evalsTab.erroredCount).toBe("string");
    // History + comparison (AC-34, AC-35)
    expect(typeof msgs.evalsTab.historyHeading).toBe("string");
    expect(typeof msgs.evalsTab.version).toBe("string");
    expect(typeof msgs.evalsTab.compareHeading).toBe("string");
    expect(typeof msgs.evalsTab.selectTwo).toBe("string");
    expect(typeof msgs.evalsTab.perCaseHeading).toBe("string");
    // Dashboard (AC-36)
    expect(typeof msgs.dashboard.casesTotal).toBe("string");
    expect(typeof msgs.dashboard.table.agent).toBe("string");
  });
});
