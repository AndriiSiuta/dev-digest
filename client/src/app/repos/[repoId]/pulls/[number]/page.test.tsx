/**
 * PR detail page — the query-state wiring the brief's review-focus deep link
 * rides on: activating a focus item must produce ONE router.replace carrying
 * `tab`, `focus` and `line` together (writing them one at a time would lose
 * all but the last), and the params it wrote must arrive at DiffTab parsed.
 *
 * The page-level guard `client/INSIGHTS.md` (2026-08-29) prescribes: every
 * tab, hook and shell is stubbed, so what is under test is the page's own
 * query-param plumbing and nothing else.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const replace = vi.fn();
let searchParams: URLSearchParams;

vi.mock("next/navigation", () => ({
  useParams: () => ({ repoId: "r1", number: "4" }),
  useSearchParams: () => searchParams,
  useRouter: () => ({ replace }),
}));

vi.mock("../../../../../components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/repo-not-found", () => ({
  RepoNotFound: () => <div>repo not found</div>,
}));
vi.mock("./_components/PrDetailHeader", () => ({
  PrDetailHeader: () => <div>header</div>,
}));
vi.mock("./_components/OverviewTab", () => ({
  OverviewTab: ({ onFocusFile }: { onFocusFile: (file: string, line?: number | null) => void }) => (
    <button type="button" onClick={() => onFocusFile("src/a.ts", 12)}>
      activate focus item
    </button>
  ),
}));
vi.mock("./_components/FindingsTab", () => ({ FindingsTab: () => <div>findings tab</div> }));
vi.mock("./_components/DiffTab", () => ({
  DiffTab: ({ focus }: { focus?: { file: string; line: number | null } | null }) => (
    <div>{focus ? `focus: ${focus.file} @ ${String(focus.line)}` : "focus: none"}</div>
  ),
}));
vi.mock("./_components/RunTraceDrawer", () => ({ default: () => <div>trace drawer</div> }));

vi.mock("../../../../../lib/hooks", () => ({
  usePulls: () => ({ data: [{ id: "pr1", number: 4 }], isLoading: false }),
  usePullDetail: () => ({
    data: {
      number: 4,
      head_sha: "abc123",
      body: "body",
      files_count: 2,
      files: [],
      commits: [],
      status: "open",
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("../../../../../lib/hooks/reviews", () => ({
  usePrReviews: () => ({ data: [], refetch: vi.fn() }),
  useCancelRun: () => ({ mutate: vi.fn() }),
  usePrActiveRuns: () => ({ data: [] }),
  usePrRuns: () => ({ data: [] }),
  useDeleteRun: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../../../../lib/repo-context", () => ({
  useActiveRepo: () => ({ activeRepo: { full_name: "acme/repo" } }),
  useRepoNotFound: () => false,
}));

import PRDetailPage from "./page";

beforeEach(() => {
  searchParams = new URLSearchParams();
  replace.mockClear();
});
afterEach(cleanup);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PRDetailPage />
    </QueryClientProvider>
  );
}

describe("PR detail page — the review-focus deep link", () => {
  it("writes tab, focus and line in a single navigation", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "activate focus item" }));

    // ONE replace: three sequential single-key writes would each rebuild from
    // the same stale search params and only the last would survive.
    expect(replace).toHaveBeenCalledTimes(1);
    const url = String(replace.mock.calls[0]?.[0]);
    const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(url.startsWith("/repos/r1/pulls/4?")).toBe(true);
    expect(query.get("tab")).toBe("diff");
    expect(query.get("focus")).toBe("src/a.ts");
    expect(query.get("line")).toBe("12");
    // The path is encoded on the wire, not left raw.
    expect(url).toContain("focus=src%2Fa.ts");
  });

  it("hands those params to the Files-changed tab as a parsed focus", () => {
    searchParams = new URLSearchParams({ tab: "diff", focus: "src/a.ts", line: "12" });
    renderPage();

    expect(screen.getByText("focus: src/a.ts @ 12")).toBeInTheDocument();
  });

  it("passes no focus to the Files-changed tab when the deep link is absent", () => {
    searchParams = new URLSearchParams({ tab: "diff" });
    renderPage();

    expect(screen.getByText("focus: none")).toBeInTheDocument();
  });

  it("leaves an existing ?trace= untouched when the deep link is written", () => {
    searchParams = new URLSearchParams({ trace: "run-9" });
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "activate focus item" }));

    const url = String(replace.mock.calls[0]?.[0]);
    expect(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("trace")).toBe("run-9");
  });
});
