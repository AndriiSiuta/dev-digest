/**
 * FileCard — collapsible file header + the Smart Diff findings overlay: the
 * "N findings" badge, clicking it expanding the file and scrolling to the
 * lowest finding's line, and the per-line severity badge(s) rendered on each
 * annotated line.
 */
import type { ComponentProps } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { PrFile, SmartDiffFinding } from "@/lib/types";
import shellMessages from "../../../../messages/en/shell.json";
import { FileCard } from "./FileCard";

afterEach(cleanup);

const FILE: PrFile = {
  path: "src/config.ts",
  additions: 2,
  deletions: 1,
  patch: "@@ -1,2 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n+const d = 5;",
};

function finding(o: Partial<SmartDiffFinding>): SmartDiffFinding {
  return {
    id: "f1",
    line: 1,
    end_line: 1,
    severity: "WARNING",
    title: "Something to look at",
    ...o,
  };
}

function renderCard(props: Partial<ComponentProps<typeof FileCard>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ shell: shellMessages }}>
      <div data-theme="dark">
        <FileCard file={FILE} {...props} />
      </div>
    </NextIntlClientProvider>
  );
}

describe("FileCard — findings badge", () => {
  it("is absent when no findings are passed", () => {
    renderCard();
    expect(screen.queryByLabelText(/Jump to/)).not.toBeInTheDocument();
  });

  it("is absent when findings is an empty array", () => {
    renderCard({ findings: [] });
    expect(screen.queryByLabelText(/Jump to/)).not.toBeInTheDocument();
  });

  it("shows the finding count when findings are passed", () => {
    renderCard({ findings: [finding({ id: "a" }), finding({ id: "b" })] });
    expect(screen.getByText("2 findings")).toBeInTheDocument();
  });

  it("clicking the badge expands a collapsed file and scrolls to the lowest finding line", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderCard({
      defaultOpen: false,
      findings: [
        finding({ id: "hi", line: 3, end_line: 3 }),
        finding({ id: "lo", line: 1, end_line: 1 }),
      ],
    });

    // Collapsed: no code lines rendered yet.
    expect(screen.queryByText("const a = 1;")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Jump to/));

    // Expanding is synchronous; the lines are now in the document.
    expect(screen.getByText("const a = 1;")).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });

  it("clicking the badge does not toggle the file closed (stops propagation)", () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderCard({ defaultOpen: false, findings: [finding({ id: "a" })] });
    fireEvent.click(screen.getByLabelText(/Jump to/));
    expect(screen.getByText("const a = 1;")).toBeInTheDocument();
  });
});

describe("FileCard — per-line severity badge", () => {
  it("renders a labeled severity badge on the annotated line, keyed by the finding's own severity", () => {
    renderCard({
      defaultOpen: true,
      findings: [finding({ id: "a", line: 1, severity: "CRITICAL", title: "Fix this" })],
    });
    // Full badge (icon + label), not the old bare-letter chip.
    expect(screen.getByText("Critical")).toBeInTheDocument();
    expect(screen.getByTitle("Fix this")).toBeInTheDocument();
  });

  it("shows one badge per finding when a line carries more than one", () => {
    renderCard({
      defaultOpen: true,
      findings: [
        finding({ id: "a", line: 1, severity: "WARNING" }),
        finding({ id: "b", line: 1, severity: "SUGGESTION" }),
      ],
    });
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getByText("Suggestion")).toBeInTheDocument();
  });
});

describe("FileCard — deep-link focus", () => {
  it("opens a collapsed file and scrolls to the focused line", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    // `open` is state INITIALIZED from `defaultOpen`, so the prop alone could
    // never reopen this card — the focus effect is what does it (AC-46/AC-47).
    renderCard({ defaultOpen: false, focus: { line: 3 } });

    expect(screen.getByText("const c = 4;")).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });

  it("opens a collapsed file without scrolling when the focus carries no line", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderCard({ defaultOpen: false, focus: { line: null } });

    expect(screen.getByText("const a = 1;")).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("leaves a file collapsed when it is not the focus target", () => {
    renderCard({ defaultOpen: false });
    expect(screen.queryByText("const a = 1;")).not.toBeInTheDocument();
  });
});
