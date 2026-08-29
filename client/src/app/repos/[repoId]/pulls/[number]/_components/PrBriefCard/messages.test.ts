/**
 * brief.json — the namespace was pre-staged for a DIFFERENT design (the old
 * `{intent, blast, history}` composition plus an unrelated git-blame feature),
 * and AC-28 requires none of that copy to survive. A plain assertion over the
 * parsed JSON, not a render: a key can only be proven ABSENT by looking at the
 * file itself.
 */
import { describe, it, expect } from "vitest";
import briefMessages from "../../../../../../../../messages/en/brief.json";

const msgs: Record<string, unknown> = briefMessages;

describe("messages/en/brief.json", () => {
  it("carries the brief's own `why` as a plain string", () => {
    expect(typeof msgs.why).toBe("string");
    expect(typeof msgs.what).toBe("string");
  });

  it("no longer describes the old {intent, blast, history} composition", () => {
    const block = msgs.block as Record<string, unknown>;
    expect(block.risks).toBe("Risks"); // kept as-is
    expect(block.intent).toBeUndefined();
    expect(block.blast).toBeUndefined();
    expect(block.history).toBeUndefined();
    expect(msgs.noHistory).toBeUndefined();
    expect(msgs.overlap).toBeUndefined();
  });

  it("no longer carries the git-blame copy — every leaf of the old `why` object is gone", () => {
    // `why` changing from an object to a string does not by itself prove the
    // old leaves are gone: a namespace shipping both shapes would satisfy the
    // string check above and still leave this copy in place.
    const why = msgs.why as Record<string, unknown>;
    expect(why.title).toBeUndefined();
    expect(why.blame).toBeUndefined();
    expect(why.noHistory).toBeUndefined();
    expect(why.noCommits).toBeUndefined();
  });

  it("promises only what this card does — the empty-state hint claims no automatic computation", () => {
    expect(msgs.unavailable).toBe("Brief not available yet.");
    // The old hint ("Run a review or open the PR to compute it.") is factually
    // wrong under AC-38: nothing computes a brief on a review or a page open.
    expect(String(msgs.unavailableHint)).not.toMatch(/run a review|open the pr/i);
  });
});
