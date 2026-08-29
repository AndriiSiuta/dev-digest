import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
// `fireEvent`, not `@testing-library/user-event` — the latter is not a
// dependency of this package (client INSIGHTS.md 2026-08-20).
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/prReview.json";
import evalMessages from "../../../../../../../../messages/en/eval.json";
import { ApiError } from "../../../../../../../lib/api";

let mockCreate: {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
};

vi.mock("@/lib/hooks/eval", () => ({
  useCreateEvalCase: () => mockCreate,
}));

import { FindingCard } from "./FindingCard";

beforeEach(() => {
  mockCreate = {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  };
});
afterEach(cleanup);

const FINDING: FindingRecord = {
  id: "f1",
  severity: "CRITICAL",
  category: "security",
  title: "Hardcoded Stripe secret key",
  file: "src/config.ts",
  start_line: 11,
  end_line: 11,
  rationale: "A **live** Stripe key is committed in source.",
  suggestion: "Move the key to an environment variable.",
  confidence: 0.95,
  kind: "finding",
  trifecta_components: null,
  evidence: null,
  review_id: "r1",
  accepted_at: null,
  dismissed_at: null,
};

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={{ prReview: messages, eval: evalMessages }}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("FindingCard (smoke, both themes)", () => {
  (["dark", "light"] as const).forEach((theme) => {
    it(`renders severity + file:line + rationale in ${theme}`, () => {
      renderWithIntl(
        <div data-theme={theme}>
          <FindingCard f={FINDING} defaultExpanded onAction={() => {}} />
        </div>,
      );
      expect(screen.getByText("Hardcoded Stripe secret key")).toBeInTheDocument();
      expect(screen.getByText("src/config.ts:11")).toBeInTheDocument();
      // category label is shown alongside the severity badge
      expect(screen.getByText("security")).toBeInTheDocument();
    });
  });

  it("fires accept/dismiss actions", () => {
    const onAction = vi.fn();
    renderWithIntl(<FindingCard f={FINDING} defaultExpanded onAction={onAction} />);
    fireEvent.click(screen.getByText("Accept"));
    expect(onAction).toHaveBeenCalledWith("accept");
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onAction).toHaveBeenCalledWith("dismiss");
  });
});

describe("FindingCard — eval-case control (AC-11..13)", () => {
  const addLabel = evalMessages.findingAction.add;

  it("shows the control on an ACCEPTED finding and fires exactly one request per click", () => {
    renderWithIntl(
      <FindingCard
        f={{ ...FINDING, accepted_at: "2026-08-29T10:00:00.000Z" }}
        defaultExpanded
      />,
    );
    fireEvent.click(screen.getByText(addLabel));
    expect(mockCreate.mutate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mutate).toHaveBeenCalledWith("f1");

    // While the request is in flight the control is disabled — a second click
    // fires nothing (AC-13's "exactly one request").
    cleanup();
    mockCreate.isPending = true;
    renderWithIntl(
      <FindingCard
        f={{ ...FINDING, accepted_at: "2026-08-29T10:00:00.000Z" }}
        defaultExpanded
      />,
    );
    const pendingBtn = screen
      .getByText(evalMessages.findingAction.adding)
      .closest("button") as HTMLButtonElement;
    expect(pendingBtn).toBeDisabled();
    fireEvent.click(pendingBtn);
    expect(mockCreate.mutate).toHaveBeenCalledTimes(1);
  });

  it("shows the control on a DISMISSED finding too", () => {
    renderWithIntl(
      <FindingCard
        f={{ ...FINDING, dismissed_at: "2026-08-29T10:00:00.000Z" }}
        defaultExpanded
      />,
    );
    expect(screen.getByText(addLabel)).toBeInTheDocument();
  });

  it("renders NO control on an undecided finding (AC-12)", () => {
    renderWithIntl(<FindingCard f={FINDING} defaultExpanded />);
    expect(screen.queryByText(addLabel)).not.toBeInTheDocument();
  });

  it("surfaces the eval_case_exists outcome without reload, not as an error", () => {
    mockCreate.isError = true;
    mockCreate.error = new ApiError("case exists", 409, "eval_case_exists");
    renderWithIntl(
      <FindingCard
        f={{ ...FINDING, accepted_at: "2026-08-29T10:00:00.000Z" }}
        defaultExpanded
      />,
    );
    expect(screen.getByText(evalMessages.findingAction.exists)).toBeInTheDocument();
    expect(
      screen.queryByText(evalMessages.findingAction.failed),
    ).not.toBeInTheDocument();
  });

  it("renders an inline error note for any other failure", () => {
    mockCreate.isError = true;
    mockCreate.error = new ApiError("boom", 500, "internal");
    renderWithIntl(
      <FindingCard
        f={{ ...FINDING, accepted_at: "2026-08-29T10:00:00.000Z" }}
        defaultExpanded
      />,
    );
    expect(screen.getByText(evalMessages.findingAction.failed)).toBeInTheDocument();
    expect(screen.getByText(addLabel)).toBeInTheDocument();
  });
});
