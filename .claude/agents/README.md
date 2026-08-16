# Agents — map of the set

Project subagents for Claude Code. Each `.md` file here is one agent: YAML
frontmatter (identity, tools, preloaded skills) plus a system-prompt body.
Claude Code watches this directory — edits take effect without a restart, and
identity comes from the `name` field, not the filename.

This README is a map, not a copy: each agent's full rules live in its own
file. Agents delegate by `description`, so keep those fields accurate when
editing.

## Catalog

| Agent         | Responsibility                                              | Tools (allowlist)                          | Model            | Skills preloaded |
| ------------- | ----------------------------------------------------------- | ------------------------------------------ | ---------------- | ---------------- |
| `researcher`  | Read-only investigation: repo questions and external ones   | Read, Grep, Glob, Bash, WebFetch, WebSearch | `sonnet` (pinned) | none |
| `planner`     | Turns a feature/change request into a Development Plan      | Read, Grep, Glob, Bash                     | inherit          | engineering-insights, onion-architecture, frontend-ui-architecture, fastify-best-practices, next-best-practices |
| `implementer` | Executes an approved plan: code, tests, self-verification   | Read, Grep, Glob, Edit, Write, Bash, Skill | inherit          | engineering-insights, onion-architecture, frontend-ui-architecture, zod, drizzle-orm-patterns, fastify-best-practices, next-best-practices |
| `test-writer` | Writes and runs tests (client RTL, server hermetic + `*.it.test.ts`, reviewer-core) | Read, Grep, Glob, Edit, Write, Bash, Skill | inherit | engineering-insights |
| `architecture-reviewer` | Read-only layering/boundary review with evidence-backed findings | Read, Grep, Glob, Bash | inherit | onion-architecture, frontend-ui-architecture |
| `plan-verifier` | Read-only per-item conformance check of implementation vs plan | Read, Grep, Glob, Bash | inherit | none |
| `doc-writer`  | Docs-only writer: feature docs + Mermaid diagrams, routed to the right home | Read, Grep, Glob, Edit, Write, Bash | inherit | mermaid-diagram, engineering-insights |

Researcher, planner, architecture-reviewer, and plan-verifier restrict Bash
to read-only commands; doc-writer restricts Bash to read-only too and writes
only within its docs allowlist; implementer and test-writer may run mutating
commands within their guardrails. All seven exclude `server/clones/**`,
`**/node_modules/**`, and `**/src/vendor/**` from searches.

## Inputs and outputs

| Agent         | Input                                                | Output artifact |
| ------------- | ---------------------------------------------------- | --------------- |
| `researcher`  | A concrete, answerable question (repo, external, or mixed) | Research report — fixed sections: Conclusions / Evidence / References (or Sources) / Not found |
| `planner`     | A feature or change request; reads `specs/` → `docs/` → `INSIGHTS.md` → source | Development Plan — fixed sections: Goal & scope / Context consulted / Modules touched / Contract changes / Steps (each tagged `skills: [...]`) / Verification plan / Constraints & risks / Open questions |
| `implementer` | An approved Development Plan (from `planner` or the user) | Implementation Report — Result / Changes by step / Verification / Deviations / Deferred to review / Insights — plus the code changes themselves and ≤3 `INSIGHTS.md` entries |
| `test-writer` | The code/behavior under test and its package | Test Report — fixed sections: Result / Tests added / Commands run / Gaps deliberately not covered / Blocked, untestable / Insights — plus the test files themselves |
| `architecture-reviewer` | A review scope: diff/commit range, branch, module, or file list | Architecture Review — fixed sections: Verdict / Findings / Mechanical checks / Scope not reviewed / Rule sources consulted |
| `plan-verifier` | The Development Plan text AND the implementation to check (branch, range, diff, or working tree) | Plan Verification — fixed sections: Verdict / Item-by-item / Verification claims not re-run / Outside plan scope (not assessed) / Inputs consulted |
| `doc-writer`  | Source material (plan, report, or implemented code) and the feature's module(s) | Documentation Report — fixed sections: Files written / Diagrams added / Placement decisions / Stale or conflicting docs flagged / Suggested INSIGHTS promotions / Not documented — plus the doc files themselves |

Vague input makes each agent stop and return numbered clarifying questions
instead of guessing.

## Intended pipeline

```
researcher (optional) → planner → user approves plan → implementer
                                                          ↓
                              test-writer (when the plan's tests need extending)
                                                          ↓
                                                    plan-verifier
                                                          ↓
                          separate review agents: architecture-reviewer,
                          /code-review, security review, then the
                          pr-self-review gate before a PR
                                                          ↓
                              doc-writer (documents the shipped feature)
```

The scope split is deliberate: the planner never writes code; the implementer
never redesigns the plan and never performs architecture, security, or general
logic review — it flags such findings under "Deferred to review". The
plan-verifier checks conformance to the plan, never code quality; the
architecture-reviewer checks structure, never plan conformance; the
test-writer never edits production code; the doc-writer never writes intent
(`specs/`) or `INSIGHTS.md`.

The planner tags every step with the skills the implementer will apply, and
both are constrained by the same preloaded structural skills — that handshake
is what keeps plans from contradicting implementation rules.

## Sources behind planner and implementer rules

Agent-mechanics practices (frontmatter schema, `tools` as least-privilege
allowlist, `skills:` full-content preloading, `model` defaulting to inherit,
delegation-oriented descriptions):

- Official Claude Code subagents documentation —
  <https://code.claude.com/docs/en/sub-agents> (fetched 2026-08-14).

Project rules encoded in the prompts, from this repo's curated files:

- Root `CLAUDE.md` — reading order, contracts-first in `@devdigest/shared`,
  pnpm/npm split, migration gotchas, do-not-touch list.
- `.claude/skills/onion-architecture/SKILL.md` — backend layering: port →
  adapter → mock → container ordering, env-read chokepoints, transaction
  ownership. Binding on both agents via preload.
- `.claude/skills/frontend-ui-architecture/SKILL.md` — client file placement
  and component-splitting rules. Binding via preload.
- `.claude/skills/engineering-insights/SKILL.md` — read-INSIGHTS-first step
  (both agents) and the record-at-end loop (implementer only).
- `.claude/skills/pr-self-review/SKILL.md` — the critical invariants the
  agents avoid tripping (no hand-edited migrations, module registration,
  shared-contract sync) and the review-scope split the implementer honors.
- `TESTING.md` — the `*.it.test.ts` DB-backed vs hermetic lane split and
  per-package test commands.
- Root `INSIGHTS.md` — `skills-lock.json` is not a reliable index (read the
  directory), `pnpm arch` is absent on `main` despite being referenced, and
  the client's vendored `shared` copy drifts without a manual sync step.

## Adding an agent

Keep new agents consistent with the set: least-privilege `tools`, a
delegation-oriented `description` stating when to use it (and what it does
NOT do), a fixed-section output format, the clones/vendor exclusion clause,
and `skills:` preloads chosen by weight — inject only what applies to every
run; everything situational stays on-demand (Skill tool) or conditional-Read.
