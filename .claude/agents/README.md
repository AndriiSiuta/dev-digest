# Agents — map of the set

Project subagents for Claude Code. Each `.md` file here is one agent: YAML
frontmatter (identity, tools, preloaded skills) plus a system-prompt body.
Claude Code watches this directory — edits take effect without a restart, and
identity comes from the `name` field, not the filename.

This README is a map, not a copy: each agent's full rules live in its own
file. Agents delegate by `description`, so keep those fields accurate when
editing.

The set is organised as a **spec-driven loop**: `spec-creator` fixes *what
and why* in a `specs/` file with EARS acceptance criteria;
`implementation-planner` turns that into *how and in what order*, with every
task citing an AC-ID; `implementer` builds it; `plan-verifier` closes the
loop by checking both the plan and every AC-ID against the code.

## Catalog

| Agent         | Responsibility                                              | Tools (allowlist)                          | Model            | Skills preloaded |
| ------------- | ----------------------------------------------------------- | ------------------------------------------ | ---------------- | ---------------- |
| `researcher`  | Read-only investigation: repo questions and external ones   | Read, Grep, Glob, Bash, WebFetch, WebSearch | `sonnet` (pinned) | none |
| `spec-creator` | Writes the feature spec: six clarification categories, EARS acceptance criteria, `[NEEDS CLARIFICATION]` markers | Read, Grep, Glob, Bash, Write, Edit, 4 read-only `devdigest` MCP tools | inherit | engineering-insights |
| `implementation-planner` | Turns an approved spec into a Development Plan; every task cites an AC-ID | Read, Grep, Glob, Bash | inherit          | engineering-insights, onion-architecture, frontend-ui-architecture, fastify-best-practices, next-best-practices |
| `implementer` | Executes an approved plan: code, tests, self-verification   | Read, Grep, Glob, Edit, Write, Bash, Skill | inherit          | engineering-insights, onion-architecture, frontend-ui-architecture, zod, drizzle-orm-patterns, fastify-best-practices, next-best-practices |
| `test-writer` | Writes and runs tests (client RTL, server hermetic + `*.it.test.ts`, reviewer-core) | Read, Grep, Glob, Edit, Write, Bash, Skill | inherit | engineering-insights |
| `plan-verifier` | **Final gate.** Read-only per-item check of implementation vs plan *and* vs every AC-ID | Read, Grep, Glob, Bash | inherit | none |
| `architecture-reviewer` | Read-only layering/boundary review with evidence-backed findings | Read, Grep, Glob, Bash | inherit | onion-architecture, frontend-ui-architecture |
| `doc-writer`  | Docs-only writer: feature docs + Mermaid diagrams, routed to the right home | Read, Grep, Glob, Edit, Write, Bash | inherit | mermaid-diagram, engineering-insights |

Researcher, implementation-planner, architecture-reviewer, and plan-verifier
restrict Bash to read-only commands. `spec-creator` and `doc-writer` restrict
Bash to read-only too and write only within their allowlist — one spec file
for the former, `docs/**` for the latter. Implementer and test-writer may run
mutating commands within their guardrails. All eight exclude
`server/clones/**`, `**/node_modules/**`, and `**/src/vendor/**` from
searches.

### `spec-creator` and the MCP surface

`spec-creator` is the only agent wired to the local `devdigest` MCP server
(`http://127.0.0.1:3001/mcp`, registered as `devdigest`). It gets four
**read-only** tools, so the spec is grounded in the system's live state and
not only in its source:

| Tool | Grounds |
|------|---------|
| `devdigest_list_agents` | which review agents and models exist today |
| `devdigest_get_findings` | the baseline output a new requirement must beat |
| `devdigest_get_conventions` | house rules already extracted, so a spec does not re-require them |
| `devdigest_get_blast_radius` | which endpoints and callers a change area really touches |

`devdigest_run_agent_on_pull_request` is deliberately **not** granted: it
starts a billed model run and writes rows, and a spec agent reads state
rather than producing it. The server being down is a one-line note in the
report, never a blocker — a missing MCP read must not become an assumption.

## Inputs and outputs

| Agent         | Input                                                | Output artifact |
| ------------- | ---------------------------------------------------- | --------------- |
| `researcher`  | A concrete, answerable question (repo, external, or mixed) | Research report — fixed sections: Conclusions / Evidence / References (or Sources) / Not found |
| `spec-creator` | A feature request; reads `specs/` → `docs/` → `INSIGHTS.md` → source, plus live state over MCP | **One** file under `specs/` (routed by package) + a Spec Created report — File written / Acceptance criteria / Open questions / Context consulted / Deliberately not specified |
| `implementation-planner` | A feature spec with stable AC-IDs and no unresolved `[NEEDS CLARIFICATION]` markers | Development Plan — Goal & scope / Context consulted / Modules touched / Contract changes / Tasks (each tagged `covers: [AC-…]` and `skills: [...]`) / AC coverage / Verification plan / Constraints & risks / Technical open questions |
| `implementer` | An approved Development Plan (from `implementation-planner` or the user) | Implementation Report — Result / Changes by task / Verification / Deviations / Deferred to review / Insights — plus the code changes themselves and ≤3 `INSIGHTS.md` entries |
| `test-writer` | The code/behavior under test and its package | Test Report — fixed sections: Result / Tests added / Commands run / Gaps deliberately not covered / Blocked, untestable / Insights — plus the test files themselves |
| `plan-verifier` | The spec, the Development Plan, AND the implementation to check (branch, range, diff, or working tree) | Plan Verification — Verdict / AC coverage / Item-by-item / Requirement-state findings / Verification claims not re-run / Outside plan scope / Inputs consulted |
| `architecture-reviewer` | A review scope: diff/commit range, branch, module, or file list | Architecture Review — fixed sections: Verdict / Findings / Mechanical checks / Scope not reviewed / Rule sources consulted |
| `doc-writer`  | Source material (plan, report, or implemented code) and the feature's module(s) | Documentation Report — fixed sections: Files written / Diagrams added / Placement decisions / Stale or conflicting docs flagged / Suggested INSIGHTS promotions / Not documented — plus the doc files themselves |

Vague input makes each agent stop and return numbered clarifying questions
instead of guessing. `spec-creator` is the exception in one direction: it
blocks only when the request is not specifiable at all, and turns every
*later* unknown into a `[NEEDS CLARIFICATION]` marker inside the spec.

## Intended pipeline

```
researcher (optional)
       ↓
spec-creator ──► specs/NN-feature.md with AC-01…AC-NN (EARS)
       ↓            ▲
  markers open? ────┘  unresolved [NEEDS CLARIFICATION] bounce back here
       ↓ none
implementation-planner ──► Development Plan, every task `covers: [AC-…]`
       ↓
user approves plan
       ↓
implementer
       ↓
test-writer (when the plan's tests need extending)
       ↓
plan-verifier  ◄── FINAL GATE: plan conformance + AC-ID conformance,
       ↓            read-only, static, evidence-backed
separate review agents: architecture-reviewer, /code-review,
security review, then the pr-self-review gate before a PR
       ↓
doc-writer (documents the shipped feature)
```

The scope split is deliberate:

- `spec-creator` answers **what and why** — no file paths, no mechanisms, no
  task breakdown — and never resolves its own markers by guessing.
- `implementation-planner` answers **how and in what order** and never
  invents, widens, or reinterprets a requirement; a missing requirement
  bounces back to `spec-creator` instead of becoming an assumption.
- `implementer` never redesigns the plan and never performs architecture,
  security, or general logic review — it flags such findings under
  "Deferred to review".
- `plan-verifier` checks conformance, never code quality; it runs two
  separate lanes (plan tasks, and AC-IDs read from the spec itself) because
  a perfectly executed plan can still leave a criterion unmet.
- `architecture-reviewer` checks structure, never plan conformance;
  `test-writer` never edits production code; `doc-writer` never writes
  intent (`specs/`) or `INSIGHTS.md`.

Two handshakes hold the loop together. **AC-IDs** are the spec→plan→code
trace: the planner tags each task, the implementer carries the IDs into its
report, and the verifier re-derives the list from the spec rather than
trusting the plan's table. **Skill tags** are the plan→implementation trace:
the planner names the skills each task needs, and both agents are bound by
the same preloaded structural skills, which is what keeps plans from
contradicting implementation rules.

## Sources behind the agent prompts

Agent-mechanics practices (frontmatter schema, `tools` as least-privilege
allowlist, `skills:` full-content preloading, `model` defaulting to inherit,
delegation-oriented descriptions):

- Official Claude Code subagents documentation —
  <https://code.claude.com/docs/en/sub-agents> (fetched 2026-08-14).

Requirements syntax:

- A. Mavin, P. Wilkinson, A. Harwood, M. Novak, "Easy Approach to
  Requirements Syntax (EARS)", 17th IEEE International Requirements
  Engineering Conference, 2009 — the five patterns (ubiquitous,
  event-driven, state-driven, optional-feature, unwanted behaviour) plus
  their complex combinations, reproduced in `spec-creator.md`.

Project rules encoded in the prompts, from this repo's curated files:

- Root `CLAUDE.md` — reading order, contracts-first in `@devdigest/shared`,
  pnpm/npm split, migration gotchas, do-not-touch list.
- `specs/README.md`, `server/specs/README.md` and the sibling package
  `specs/README.md` files — spec routing (cross-package vs. single package),
  the `NN-feature-name.md` filename rule, and the section shape
  `spec-creator` extends with AC-IDs.
- `server/specs/01-mcp-server.md` §Tools — the five MCP tools and their
  inputs; the blocking, billed nature of
  `devdigest_run_agent_on_pull_request` is why `spec-creator` is not given it.
- `.claude/skills/onion-architecture/SKILL.md` — backend layering: port →
  adapter → mock → container ordering, env-read chokepoints, transaction
  ownership. Binding on planner and implementer via preload.
- `.claude/skills/frontend-ui-architecture/SKILL.md` — client file placement
  and component-splitting rules. Binding via preload.
- `.claude/skills/engineering-insights/SKILL.md` — read-INSIGHTS-first step
  (spec-creator, planner, implementer) and the record-at-end loop
  (implementer only).
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

MCP tools are allowlisted individually as `mcp__<server>__<tool>`; granting
a whole server is not least-privilege. Before adding one, check what the
tool actually does — the split between the four read tools and the one
billed write tool on `devdigest` is the worked example.
