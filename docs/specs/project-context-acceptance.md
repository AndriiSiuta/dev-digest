# Project Context — manual acceptance run (AC-25, finding half)

**Spec:** `specs/03-project-context-folder.md`
**Status:** runbook written, run NOT executed
**Owner of the decision to run it:** the user — it costs real model spend
against a real provider key.

## What this covers, and what it does not

AC-25 reads:

> WHEN a document carrying a stated invariant is attached to an agent and that
> agent reviews a PR whose diff violates that invariant, the resulting finding's
> `rationale` SHALL contain the attached document's repo-relative path.

The spec splits it and says so explicitly. **The prompt half is automated** in
`server/test/project-context-prompt.test.ts` — the document's path and its
stated invariant both reach the prompt sent to `MockLLMProvider`, and the
assembled `## Project context` section is untrusted-wrapped and path-labelled.
That half is regression-protected and runs in the hermetic lane.

**The finding half is not, and cannot be here.** Three independent reasons:

1. The e2e lane is deterministic and runs no LLM (`e2e/README.md`), so it cannot
   observe a model naming anything.
2. No hermetic lane can make a real model cite anything — `MockLLMProvider`
   returns a fixture, so asserting on its `rationale` would be asserting on the
   fixture.
3. **The grounding gate compounds it.** A finding that does not cite a real line
   in the diff is dropped regardless of which document it came from
   (`reviewer-core/INSIGHTS.md`, *Decisions*, 2026-07-31). Attaching a document
   creates no new citable surface — the finding still has to point at a diff
   line to survive at all, and only then can its `rationale` mention the path.

**State this plainly, because it is the honest reading:** substring-in-`rationale`
is the **weakest of the four citation options considered** when the spec was
written. Nothing in the system requires the model to name the document, nothing
verifies that it did, and no code path fails if it stops. **A regression in
citing behaviour will surface only when someone runs this check by hand.**

## The run

### Preconditions

- `./scripts/dev.sh` up (Postgres + API :3001 + web :3000).
- Migrations applied: `cd server && pnpm db:migrate`. They do not run on boot.
- A provider key present via `SecretsProvider` (`~/.devdigest/secrets.json`).
  **This is the step that costs money.**

### 1. Repository and PR

| | |
|---|---|
| Repository | `AndriiSiuta/weather-app` (already imported in this workspace; the blast-radius demo lives there) |
| PR | a PR whose diff **violates** the invariant below. Reuse `weather-app#4` only if its diff still violates it; otherwise open a small PR that does. |

The PR must be small and the violation must be **on a changed line**, not
inferred from unchanged code — otherwise the grounding gate drops the finding
before its `rationale` is ever read.

### 2. The document

Add (or confirm) a markdown file under one of the repository's configured search
roots — by default `specs/`, `docs/`, `insights/`:

- **Path:** `docs/architecture.md`
- **Stated invariant, written unambiguously in that file:**
  `The api/ module never imports db/ directly; all persistence goes through a repository.`

The path is what the pass condition greps for, so record the exact string.

### 3. The agent

| | |
|---|---|
| Agent | a single-pass reviewer in this workspace |
| Provider / model | whichever key is configured; record the exact `provider/model` used |
| `repo_intel` | off, so the prompt carries no unrelated enrichment |
| Linked skills | none, so nothing else can supply the invariant |

Attach the document: agent editor → **Context** tab → pick the repository →
tick `docs/architecture.md`. Confirm the agent's version bumped.

### 4. Execute

Run the agent on the PR from the PR page. Wait for the run to complete.

### 5. Pass condition

**Pass iff at least one finding's `rationale` contains one of the run's attached
repo-relative paths, as a plain substring.**

```
docs/architecture.md ∈ finding.rationale
```

Substring match, exact path, no normalisation. Check every surviving finding;
one hit is enough.

Two supporting checks that are *not* the pass condition but tell you whether a
failure is the model's or the pipeline's:

- The run trace's **Specs read** row lists `docs/architecture.md` with a non-zero
  token count and status `included`. If it does not, the pipeline failed, not the
  model — and that half **is** covered by the hermetic tests, so treat it as a
  real regression.
- The trace's **Prompt assembly → Project context** block contains
  `<untrusted source="docs/architecture.md">` and the invariant sentence.

If both supporting checks pass and the pass condition fails, the model simply did
not name the document. That is a **recorded observation, not a build failure** —
see the honesty note above.

### 6. Artifact

File the run trace as the artifact:

- Open the run trace drawer, export/copy the trace JSON.
- Save it as `docs/specs/artifacts/project-context-ac25-<yyyy-mm-dd>.json`.
- Record below: date, repo, PR number, agent, `provider/model`, attached paths,
  pass/fail, and the matching `rationale` excerpt if it passed.

## Recorded outcomes

| Date | Repo | PR | Agent | provider/model | Attached path | Result | Artifact |
|------|------|----|-------|----------------|---------------|--------|----------|
| _not yet run_ | — | — | — | — | — | — | — |

**The run has not been executed.** It was left as a decision for the user rather
than made during implementation, because it spends real money against a real
provider key. Everything else in this document is ready to follow as written.
