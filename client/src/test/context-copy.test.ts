import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import messages from "../../messages/en/context.json";

/**
 * The `context` i18n namespace shipped as scaffolding for a DIFFERENT design —
 * a `.devdigest/specs/` folder, chunk counts, re-indexing, an in-studio editor
 * with save, and "Every agent and the PR brief read them as grounding context".
 * The spec rules all of that out, so AC-33 exists to stop the stale copy
 * surviving the feature — the same fix `messages/en/skills.json` needed when
 * its copy outran the engine (root `INSIGHTS.md`, 2026-08-05).
 *
 * AC-NF-04 is the second half: the copy must not state a security guarantee the
 * engine does not implement. What is TRUE, verified against
 * `reviewer-core/src/prompt.ts`: attached documents are `wrapUntrusted()`-ed
 * and the system prompt carries the injection guard. What is NOT true and must
 * never be written: that SKILLS are wrapped the same way (they are joined
 * verbatim into a trusted section), or that attaching a document makes the
 * model cite it (nothing enforces that — see AC-25).
 */

const copy = JSON.stringify(messages).toLowerCase();

describe("messages/en/context.json — AC-33", () => {
  it.each([
    "chunk",
    "reindex",
    "re-index",
    "indexing",
    "resync",
    "indexstatus",
    ".devdigest/specs",
    "every agent",
  ])("does not present project context as %s", (forbidden) => {
    expect(copy).not.toContain(forbidden);
  });

  it("does not offer an in-studio editor/save flow", () => {
    // The stale namespace had `editor.save` / `editor.saving` and a
    // `mode.preview` / `mode.edit` toggle. Both surfaces are out of scope: the
    // studio never writes back into a cloned repository.
    expect(messages).not.toHaveProperty("editor");
    expect(messages).not.toHaveProperty("mode");
    expect(copy).not.toContain("edit mode");
    // "Saving…" here is about persisting the ATTACHMENT, never the document.
    expect(messages.saveError.toLowerCase()).toContain("attachment");
  });

  it("describes whole-document, manual, per-owner attachment", () => {
    expect(copy).toContain("attach");
    expect(copy).toContain("read from the repository checkout");
    expect(copy).toContain("per repository");
  });
});

describe("messages/en/context.json — AC-NF-04", () => {
  it("claims only the untrusted-wrapping the engine actually applies", () => {
    expect(messages.trust).toContain("untrusted-data delimiters");
    expect(messages.trust).toContain("injection guard");
  });

  it("never claims skills are wrapped, nor that attaching guarantees a citation", () => {
    expect(copy).not.toContain("skills are wrapped");
    expect(copy).not.toContain("guarantee");
    expect(copy).not.toContain("will cite");
    expect(copy).not.toContain("always cite");
  });
});

describe("the re-index hook is gone", () => {
  it("nothing in client/src references useReindexContext", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (entry === "vendor" || entry === "node_modules") continue;
        // This file names the hook in prose; it is the assertion, not a caller.
        if (entry === "context-copy.test.ts") continue;
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry)) {
          // The identifier followed by `(` or `,`/`}` — a call or an import,
          // not the word appearing inside a comment explaining its removal.
          if (/useReindexContext\s*[(,}]/.test(readFileSync(full, "utf8"))) hits.push(full);
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(hits).toEqual([]);
  });
});
