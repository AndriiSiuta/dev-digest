# Project Context Folder

**Status:** agreed
**Packages touched:** server, client, reviewer-core
**Created:** 2026-08-28
**Clarifications resolved:** 2026-08-28 (all 12 — see "Open questions")
**Supersedes:** None

## Problem

A reviewer agent judges a PR on the diff, the repo skeleton, the callers of the
changed symbols and whatever house rules someone pasted into a skill. It cannot
read the documents the team already wrote about how the system is supposed to be
built — the specs, the architecture docs, the recorded insights sitting in the
repository being reviewed.

The cost of that gap is concrete: an invariant that is written down, agreed and
enforced socially ("the `api/` module does not import `db/` directly") is
invisible to the reviewer. A PR that breaks it passes review, and the maintainer
finds out later. Meanwhile the person who wrote the invariant has no way to say
"this agent should know about this document" short of copying the document's
text into an agent's system prompt by hand, where it immediately goes stale
against the file it was copied from.

The engine has been ready for this the whole time and nothing feeds it.
`reviewer-core` already accepts a `specs` prompt slot, already wraps it as
untrusted data and already emits a `## Project context` section
(`reviewer-core/src/prompt.ts:63,109,131`). `RunTrace` already carries a
`specs_read` field (`server/src/vendor/shared/contracts/trace.ts:93`), the run
trace drawer already renders both the `specs_read` chips and the `## Project
context` prompt block
(`client/src/app/repos/[repoId]/pulls/[number]/_components/RunTraceDrawer/_components/TraceBody/TraceBody.tsx:39-46,88-89`),
and `describeAssembly` already reserves a `specs` section with provenance
`project-context` (`server/src/platform/prompt-log.ts:99`). The only thing
missing is the middle: nothing discovers the documents, nothing lets a
maintainer choose them, and `run-executor` hardcodes `specs_read: []` and never
passes `specs` (`server/src/modules/reviews/run-executor.ts:348,563,205-245`).

This is also the first feature going through spec → plan → implement → verify,
and it was chosen because it is small enough to trace end to end and because it
produces a directly observable behaviour change in the reviewer: attach a
document, break what the document says, see the reviewer name the document.

## Scope — in / out

**In**

- **Discovery.** Recursively finding markdown documents in a repository
  checkout under configured search roots — `specs/`, `docs/` and `insights/`
  are the starting set, expressed roughly as `**/{specs,docs,insights}/**/*.md`.
- **Manual attachment to an agent.** A **Context** tab in the agent editor
  listing discovered documents with a checkbox, the path, the document type, a
  search filter and a read-only preview.
- **Manual attachment to a skill.** The same attachment surface inside the skill
  editor, under a section titled **"Project context to use"**.
- **Persisting the selection as paths.** The attachment records which documents
  are chosen; it does not snapshot their text.
- **Injection into the review prompt.** Before a run, the attached documents are
  read from the repository checkout and rendered into the existing `##
  Project context` prompt section as untrusted, delimiter-wrapped data covered
  by the existing injection guard.
- **Run transparency.** The run trace reports which documents were read and how
  large each was in tokens, without a separate model call.

**Out**

- **Automatic / PR-driven selection of documents.** The maintainer picks by
  hand. Explicitly a separate, later feature — this spec exists partly to
  establish whether manual attachment alone changes reviewer behaviour, which an
  automatic selector would confound.
- **Chunking, embedding or semantic retrieval over the documents.** Out because
  the selection is manual and whole-document; there is nothing to retrieve
  against.
- **A standalone project-context browsing or editing page.** The pre-staged
  `activeKeyFor("/context")` nav entry
  (`client/src/components/app-shell/helpers.ts:30`) and the `editor.save` /
  `reindex` / `chunks` strings in `client/messages/en/context.json` describe a
  larger surface than this feature. Out because nothing in the request asks a
  maintainer to *edit* repository documents from the studio, and writing back
  into a cloned repo is a separate problem with its own failure modes.
- **Feeding project context into anything other than a review run** — the PR
  brief, the intent classifier, the conventions extractor. Out because each has
  its own prompt budget and its own consumer, and none was asked for.
- **The GitHub/CI review path.** Studio runs only for v1. Out because the CI
  runner has no studio DB to read attachments from — it resolves skills from
  `.devdigest/skills/*.md` in its own checkout (`server/src/modules/reviews/helpers.ts:11-18`)
  — so giving it project context is a separate resolution mechanism, not a
  reuse of this one.
- **Non-markdown documents.** Out because the reader is specified for `.md`.
- **Changing how the `## Skills / rules` section is assembled.** Out of scope
  here, but see "Constraints from the repo" — the skills section is *not*
  untrusted-wrapped today, and this spec must not be read as fixing that.

## Actors & triggers

**A maintainer, in the studio.** Opens an agent in the agent editor and selects
the Context tab, or opens a skill in the skill editor and uses the "Project
context to use" section. Preconditions: the agent (or skill) exists in the
workspace, and a repository whose documents can be listed is available as a
local checkout — discovery reads the working tree of a cloned repo, the same
source the intent classifier already reads referenced docs from
(`server/src/modules/intent/service.ts:199` via
`server/src/adapters/git/simple-git.ts:129`). A repository that was never cloned
has nothing to list.

**Scoping — per (agent, repo).** Agents and skills are workspace-scoped
(`agents.workspace_id`, `server/src/db/schema/agents.ts:10-12`) while document
discovery is per-repository-checkout. The Context tab therefore carries a
**repo picker**, and an attachment is identified by the triple
`(agent, repo, path)` — likewise `(skill, repo, path)`. This matches how the
data is consumed: a run is always for exactly one repo and one PR, so a run
resolves attachments by the repo it is reviewing and never has to choose between
repos. It also lets one agent be reused across repos while carrying different
documents in each.

**A review run, in the background.** When `run-executor` prepares an agent's
prompt, the attached documents are resolved and read. This is the same
best-effort pre-work slot the linked skills, the derived intent, the repo map
and the callers digest already occupy
(`server/src/modules/reviews/run-executor.ts:196-245`). No maintainer action
triggers it beyond having attached something. A run resolves attachments for the
PR's own repository only.

**Not a trigger: the GitHub/CI review path.** `reviewer-core` is shared with the
CI runner, which resolves skills from `.devdigest/skills/*.md` rather than the DB
(`server/src/modules/reviews/helpers.ts:11-18`). CI is out of scope for v1, and
this costs the engine nothing: the `specs` slot stays optional, so a CI run
simply omits the section exactly as it does today.

## Contract changes

Canonical copy is `server/src/vendor/shared/`; the client's
`client/src/vendor/shared/` is a hand-copy with no sync script and is already
known to lag, so every shape below must be mirrored there as a deliberate second
step (root `INSIGHTS.md`, *What Doesn't Work*, 2026-07-29).

- **A discovered document.** What discovery returns for the Context tab to
  render: the repo-relative path, the document type, and enough size information
  for the maintainer to judge the cost of attaching it. Contains no document
  body — a preview is fetched for one document at a time rather than shipped
  with the list.

  **Document type is derived, not declared:** it is the search root the file was
  found under — `spec`, `doc` or `insight`. No front-matter is parsed and no
  type is stored on the attachment; a document found under two roots takes the
  root it was reached through. The value set is therefore whatever the
  configured roots produce, which is a three-value enum for the default roots.

- **An attachment.** The record binding an agent (or a skill) to a chosen
  document **in a specific repository** — the triple `(agent, repo, path)` /
  `(skill, repo, path)` — in a defined order, with the same shape of per-link
  switch that `AgentSkillLink` already carries
  (`server/src/vendor/shared/contracts/knowledge.ts:~300`, `AgentSkillLink`).
  Stores the path, never the text.

- **`AgentVersionConfig`.** Attached documents join the immutable config
  snapshot, alongside the `skills: string[]` it already records
  (`server/src/vendor/shared/contracts/knowledge.ts`, `AgentVersionConfig`), and
  editing attachments bumps the agent version like any other config change. The
  reason is reproducibility: a past run must be able to show which documents it
  was told to read, and since the *content* is deliberately not snapshotted, the
  attachment list is the only durable record of that instruction.

- **`SkillVersion`.** The same rule applies to skills, and it has a consequence:
  `SkillVersion` today snapshots only `body` (plus `message` / `created_at`,
  `server/src/vendor/shared/contracts/knowledge.ts`, `SkillVersion`), so it has
  nowhere to record a skill's attached documents. Recording them requires
  widening that snapshot — the rule is deliberately not split between the two
  surfaces.

- **A per-repository search-roots setting.** The roots a repository is scanned
  under, with a workspace-level default of `specs`, `docs`, `insights`. Stored
  as repository configuration rather than in `AppConfig` — see "Constraints from
  the repo".

- **`RunTrace.specs_read`.** Today `z.array(z.string())` —
  `server/src/vendor/shared/contracts/trace.ts:93` — which can carry a path but
  not a size. Requirement 5 asks for the path *and* the token size, so this
  field widens to carry both per document. The trace drawer's existing rendering
  of `specs_read` consumes the current shape and is affected.

- **`Finding`.** Unchanged. Citation is by **path in the `rationale`, checked by
  substring**: each untrusted block is labelled with the document's
  repo-relative path (AC-12), the model names that path in its markdown
  `rationale`, and verification greps the rationale for one of the run's
  attached paths. No new field, and `@devdigest/shared` gains nothing for this.
  The trade-off is recorded honestly in AC-25 — this is the weakest of the four
  options considered, and nothing mechanically holds the model to it.

- **`PromptAssembly`.** Unchanged. `specs` already exists and is already
  populated by `assemblePrompt` from `parts.specs`
  (`reviewer-core/src/prompt.ts:107-110,157`).

## Acceptance criteria

| ID | Criterion (EARS) | How it is checked |
| ----- | ---------------- | ----------------- |
| AC-01 | WHEN a maintainer opens the Context tab of an agent, the system SHALL list every markdown document found beneath the configured search roots of the repository checkout, each with its repo-relative path. | server hermetic test (discovery over a fixture tree) |
| AC-02 | The document reader SHALL descend recursively to any depth beneath a configured search root. | server hermetic test |
| AC-03 | The document reader SHALL exclude files that are not markdown. | server hermetic test |
| AC-04 | WHERE a search filter term is entered in the Context tab, the system SHALL show only documents whose path matches the term. | client RTL |
| AC-05 | WHEN a maintainer selects a document row for preview, the system SHALL display that document's content read-only. | client RTL |
| AC-06 | WHEN a maintainer previews a document, the system SHALL NOT attach it. | client RTL |
| AC-07 | WHEN a maintainer ticks a document's checkbox, the system SHALL persist the document's path as an attachment of that agent and SHALL NOT persist the document's text. | server `*.it.test.ts` (row contains the path; no body column written) |
| AC-08 | The skill editor SHALL offer the same document attachment surface under a section titled "Project context to use". | client RTL |
| AC-09 | WHEN a review run starts for an agent with at least one attached document, the system SHALL read each attached document's content from the repository checkout at run time rather than from stored text. | server hermetic test (edit fixture between two runs; second prompt reflects the edit) |
| AC-10 | WHEN attached documents are read for a run, the system SHALL place them in the assembled prompt's `## Project context` section. | reviewer-core test + server hermetic test asserting the prompt reaching `MockLLMProvider` |
| AC-11 | The system SHALL enclose every attached document's content in untrusted delimiters, so it is covered by the assembled system prompt's injection guard. | reviewer-core test (`wrapUntrusted` applied per document) |
| AC-12 | The system SHALL make each attached document's repo-relative path identifiable inside its own untrusted block, so a finding can name the document it came from. | reviewer-core test on the assembled prompt text |
| AC-13 | WHERE a document is attached to a skill and that skill is linked and enabled on the agent, the system SHALL include that document in the same `## Project context` section of the agent's run. | server hermetic test |
| AC-14 | WHILE an agent has no attached documents and no documents reaching it via a linked skill, the assembled prompt SHALL be byte-identical to the prompt the same run produces today. | server hermetic test (snapshot equality against the pre-feature prompt) |
| AC-15 | WHEN a run assembles project context, the system SHALL record in the run trace each document that reached the prompt, with its repo-relative path and its size in tokens. | server hermetic test on the persisted `RunTrace` |
| AC-16 | The system SHALL assemble project context without issuing any additional model call. | server hermetic test (`MockLLMProvider` call count unchanged vs. the no-context baseline) |
| AC-17 | WHEN a run assembles project context, the run's live log SHALL report how many documents were attached and their combined token cost, matching the existing skills log line. | server hermetic test on emitted run events |
| AC-18 | IF an attached document's path no longer exists in the repository checkout, or cannot be read, THEN the system SHALL skip that document, continue the run, and record it in the trace as unreachable. | server hermetic test (fixture with one deleted path: run completes, prompt omits it, trace marks it unreachable) |
| AC-19 | IF the repository has no checkout available when a run starts, THEN the system SHALL complete the run without a `## Project context` section rather than failing it. | server hermetic test |
| AC-20 | IF the same document reaches a run more than once (attached directly and via a linked skill, or via two linked skills), THEN the system SHALL include its content in the prompt exactly once. | server hermetic test |
| AC-21 | IF the combined size of the documents selected for a run exceeds the configured ceiling, THEN the system SHALL include documents in attachment order until the ceiling would be crossed, SHALL omit every document from that point on whole (never truncated mid-document), and SHALL record the omitted paths in the trace. | server hermetic test (fixture set that overruns a test-injected ceiling) |
| AC-22 | WHEN two runs of the same agent execute concurrently, each run SHALL read the attached documents independently and record its own `specs_read` entries. | server hermetic test |
| AC-23 | IF a run is cancelled, THEN the run's persisted trace SHALL NOT claim documents that never reached a model call. | server hermetic test (cancel path builds its trace from the buffer, `server/src/modules/reviews/run-executor.ts:377`) |
| AC-24 | WHEN a maintainer unticks a document, the system SHALL remove the attachment, and subsequent runs SHALL assemble prompts without that document. | server `*.it.test.ts` |
| AC-25 | WHEN a document carrying a stated invariant is attached to an agent and that agent reviews a PR whose diff violates that invariant, the resulting finding's `rationale` SHALL contain the attached document's repo-relative path. | **Split, and the second half is not regression-protected.** Prompt half — server hermetic test: the invariant text and the document's path both reach the prompt sent to `MockLLMProvider`. Finding half — a recorded **manual** acceptance run against a real model, passing iff `rationale` contains one of the run's attached paths (substring); the run trace is kept as the artifact. It cannot be automated here: the e2e lane is deterministic and runs no LLM (`e2e/README.md`), and no hermetic lane can make a real model cite anything. Substring-in-`rationale` is deliberately the **weakest** of the four citation options considered — nothing in the system requires or verifies that the model actually names the document, so a regression in citing behaviour will surface only when someone runs this check by hand. |

Criteria added when the clarifications were resolved on 2026-08-28:

| ID | Criterion (EARS) | How it is checked |
| ----- | ---------------- | ----------------- |
| AC-26 | WHEN a maintainer selects a repository in the Context tab's repo picker, the system SHALL list that repository's documents and SHALL attach subsequent selections against that repository. | client RTL + server `*.it.test.ts` (attachment row carries the repo) |
| AC-27 | WHERE the same agent has documents attached in two different repositories, a run SHALL resolve only the attachments belonging to the repository of the PR under review. | server hermetic test |
| AC-28 | The system SHALL derive a document's type from the search root it was found under, yielding `spec`, `doc` or `insight` for the default roots. | server hermetic test |
| AC-29 | The system SHALL scan each repository under that repository's configured search roots, defaulting to `specs`, `docs` and `insights` when the repository has no setting of its own. | server hermetic test (repo with an override; repo without) |
| AC-30 | WHEN a maintainer changes an agent's attached documents, the system SHALL bump the agent's version and SHALL record the attached documents in that version's immutable config snapshot. | server `*.it.test.ts` (version incremented; snapshot lists the paths) |
| AC-31 | WHEN a maintainer changes a skill's attached documents, the system SHALL bump the skill's version and SHALL record the attached documents in that version's immutable snapshot. | server `*.it.test.ts` |
| AC-32 | WHEN a run assembles project context, the system SHALL order the agent's own attached documents first, followed by documents from linked skills in skill-link order. | server hermetic test on the assembled prompt |
| AC-33 | The studio SHALL NOT present project context as folder-indexed, chunk-counted, re-indexable, editable in place, or automatically read by every agent. | client RTL + a check that no such string survives in `client/messages/en/context.json` |

## Non-functional criteria

| ID | Criterion (EARS) | How it is checked |
| ------- | ---------------- | ----------------- |
| AC-NF-01 | IF an attached path resolves outside the configured search roots of its repository checkout, THEN the system SHALL refuse to read it. | server hermetic test with traversal inputs (`../`, absolute paths, symlink out of tree) |
| AC-NF-02 | The system SHALL NOT emit any attached document's content into the run's live log, its SSE stream, or its persisted log — only paths, sizes, token counts and fingerprints. | server hermetic test asserting the emitted log lines carry no document text; structurally guarded by `server/src/platform/prompt-log.ts` |
| AC-NF-03 | The system SHALL restrict document discovery, preview and attachment to repositories in the requesting workspace. | server `*.it.test.ts` (cross-workspace request denied) |
| AC-NF-04 | The user-facing copy for this feature SHALL NOT state a security guarantee the engine does not implement. | review against `reviewer-core/src/prompt.ts` at copy-writing time — see the 2026-08-05 root `INSIGHTS.md` entry on `client/messages/en/skills.json` |
| ~~AC-NF-05~~ | ~~Discovery latency ceiling.~~ Withdrawn 2026-08-28 — v1 states no discovery latency budget. See the explicit non-requirement below. | — |
| AC-NF-06 | The system SHALL report each document's token size in the trace using the tiktoken-backed `container.tokenizer.count`, the same estimator the skills log line already uses (`server/src/modules/reviews/run-executor.ts:436`). | server hermetic test (injected tokenizer is the one called) |

**Explicit non-requirement (v1):** discovery latency is deliberately
unbudgeted. No number is asserted, no caching is required, and a slow listing on
a large repository is not a defect against this spec. If it becomes one, that is
a new criterion with a new ID, not a reinterpretation of AC-NF-05.

## Constraints from the repo

- **The `specs` prompt slot already exists and is already untrusted-wrapped.**
  `PromptParts.specs` is documented as "Project-context spec chunks (untrusted
  content)", each element is wrapped with `wrapUntrusted` and the result is
  emitted as `## Project context`, positioned after `## Repo skeleton` and
  before the callers digest and the diff — `reviewer-core/src/prompt.ts:63`,
  `107-110`, `131`, `157`. This spec requires the *delta* that fills the slot,
  not a new prompt mechanism. Requirement 4's "delimiters and an injection
  guard" is already satisfied by that path plus `INJECTION_GUARD`
  (`reviewer-core/src/prompt.ts:19-28`), which is appended to every system
  prompt on both the studio and CI review paths.

- **The delimiter label is currently positional, not path-bearing.**
  `wrapUntrusted(\`spec-${i}\`, s)` labels blocks `spec-0`, `spec-1`
  (`reviewer-core/src/prompt.ts:109`). AC-12 exists because a model cannot cite
  a document it only knows as `spec-0`.

- **`run-executor` is the missing call, and this exact failure mode is on
  record.** Root `INSIGHTS.md`, *What Doesn't Work*, 2026-08-05: the skills
  pipeline was complete on every layer except the one call that fed it, so
  `parts.skills` was always undefined, the section was never emitted, and the
  trace drawer's skills block was dead UI rather than a rendering bug. Skills
  have since been wired (`server/src/modules/reviews/run-executor.ts:210,
  228-231, 429-455`); project context is now in precisely the same state —
  `specs_read: []` is hardcoded at
  `server/src/modules/reviews/run-executor.ts:348` and `:563`, and no `specs:`
  key is passed to `reviewPullRequest`. AC-15 and AC-10 exist to close that
  loop, and AC-14 exists because "the layer below is complete" is exactly the
  condition under which a missing call goes unnoticed.

- **Copy must not over-promise the trust model.** Root `INSIGHTS.md`, *What
  Doesn't Work*, 2026-08-05: `client/messages/en/skills.json` shipped four
  strings telling the user an imported skill is "wrapped as untrusted data"
  while `assemblePrompt` joined `parts.skills` verbatim into a trusted user
  section. The entry was marked resolved by rewriting the copy, not by changing
  the engine — and `reviewer-core/src/prompt.ts:130` still reads
  `` userSections.push(`## Skills / rules\n${skillsBlock}`) `` with no wrapping.
  Two consequences bind this spec: AC-NF-04, and the fact that documents
  attached *to a skill* (AC-13) must reach the untrusted `## Project context`
  section rather than being folded into the trusted skills block.

- **Best-effort pre-work is the house pattern for prompt enrichment.** Intent,
  callers, repo map and skills each degrade to "section omitted, prompt
  identical to the baseline" rather than failing a run
  (`server/src/modules/reviews/run-executor.ts:196-245`, `429-455`). AC-14 and
  AC-19 hold this feature to it.

- **Prompt logging is structurally content-free.**
  `server/src/platform/prompt-log.ts` returns types with no field that can hold
  section content, because every logged line is also streamed over SSE and
  persisted into `run_traces.log`. `SECTION_SOURCE.specs = 'project-context'`
  is already reserved (`:99`). AC-NF-02 restates this as a requirement rather
  than leaving it to discipline.

- **`git.readFile` has no path containment check.**
  `server/src/adapters/git/simple-git.ts:129-131` is
  `readFile(join(this.clonePathFor(repo), path), 'utf8')` — a stored path
  containing `../` escapes the checkout. Today's caller passes paths extracted
  from a PR body; this feature persists user-chosen paths and replays them on
  every run, which is why AC-NF-01 is stated as a hard requirement.

- **The grounding gate is mechanical and diff-scoped.**
  `reviewer-core/INSIGHTS.md`, *Decisions*, 2026-07-31: a finding that does not
  cite a real line in the diff is dropped. Attaching a document does not create
  a new citable surface — a finding about a document-stated invariant still has
  to point at a line in the diff to survive. This constrains what AC-25 can
  ask for.

- **The client's vendored `@devdigest/shared` is a hand-copy that already
  lags.** Root `INSIGHTS.md`, *What Doesn't Work*, 2026-07-29 — five files
  behind, no sync script. The `specs_read` widening in "Contract changes" must
  land on both sides.

- **Pre-staged scaffolding exists for this feature and disagrees with the
  request.** Root `INSIGHTS.md`, *Codebase Patterns*, 2026-08-05 warns to search
  for scaffolding before writing any. Found: `client/messages/en/context.json`
  (a complete i18n namespace with zero usages in `client/src`),
  `activeKeyFor("/context")` in
  `client/src/components/app-shell/helpers.ts:30`, `PROMPT_COLORS.specs` and the
  `specs_read` rendering in the trace drawer, and `specs` listed as "L05" in
  `reviewer-core/README.md:32`. The i18n file describes a **different design**
  from the one requested: a `.devdigest/specs/` folder rather than configurable
  `specs`/`docs`/`insights` roots, chunk counts and re-indexing rather than
  whole-document attachment, an in-studio editor with save, and "Every agent and
  the PR brief read them as grounding context" rather than manual per-agent
  attachment.

  **Resolved 2026-08-28 — the namespace is stale scaffolding and is rewritten to
  match this spec**, exactly as `client/messages/en/skills.json` was rewritten
  when its copy outran the engine. Configurable search roots stay;
  `.devdigest/specs/`, `chunks`, `reindex` / `indexing` / `resync`,
  `indexStatus`, the `editor.save` flow and the "Every agent and the PR brief
  read them as grounding context" claim all go. AC-33 exists so the stale copy
  cannot survive the feature, and AC-NF-04 remains pointed at this file.

- **No configuration key for search roots exists.** `AppConfig` is a closed,
  zod-validated env schema with no roots or glob field
  (`server/src/platform/config.ts`), and the workspace `settings` module stores
  non-secret prefs as key/value rows
  (`server/src/modules/settings/routes.ts:11-20`). Requirement 2 says "the
  search roots are set in configuration" without saying which.

  **Resolved 2026-08-28: a per-repository setting, with a workspace-level
  default of `specs`, `docs`, `insights`** (AC-29). Not `AppConfig` — roots
  differ per repository, and `AppConfig` is a process-wide env schema that
  cannot express that. The workspace default follows the precedent of the
  per-feature model choices, which fall back to a registry default until a
  workspace picks one (`server/src/modules/settings/feature-models.ts:12-27`).

- **Test lanes are fixed by filename.** DB-backed tests are `*.it.test.ts` and
  run against a testcontainers Postgres; everything else in `server/` must stay
  hermetic and use `server/src/adapters/mocks.ts`
  (`TESTING.md:46-47,79-87`, root `CLAUDE.md`). The "How it is checked" column
  above uses those lanes as named.

- **Ordering and precedence between an agent's own attachments and a linked
  skill's attachments is undefined by the request.** `agent_skills` carries an
  explicit `order` column and the skills reaching a prompt are assembled "in the
  order the user arranged it" (`server/src/modules/reviews/run-executor.ts:206`,
  `server/src/db/schema/agents.ts:51-60`), so a parallel ordering question is
  unavoidable here.

  **Resolved 2026-08-28: the agent's own documents first, then documents from
  linked skills in skill-link order** (AC-32) — which reuses the ordering
  `enabledSkillsForPrompt` already establishes rather than inventing a second
  one. Note the interaction with AC-21: because overflow drops from the end,
  this ordering means a skill's documents are the first to be omitted when the
  ceiling is reached.

## Context consulted

**Specs**

- `specs/README.md` — routing rule: "Forward-looking specs for work that spans
  more than one package… Work that lives inside a single package goes in that
  package's `specs/` instead." This feature touches `server`, `client` and
  `reviewer-core`, so it routes to the root `specs/`. `01-smart-diff.md` and
  `02-blast-radius.md` are the existing files, making `03` the next free number.
- `specs/02-blast-radius.md` — read for house shape; no overlap with this
  feature (it explicitly puts prompt feeding out of its own scope).
- `docs/specs/skills.md`, `docs/specs/conventions.md` — checked for an existing
  project-context spec. There is none; this is not a re-spec of anything.

**INSIGHTS**

- Root `INSIGHTS.md` — read in full (feature spans three packages). Load-bearing
  entries cited above: the skills-pipeline-never-fed entry and the
  `skills.json` untrusted-copy entry (both *What Doesn't Work*, 2026-08-05), the
  pre-staged-scaffolding entry (*Codebase Patterns*, 2026-08-05), and the
  vendored-shared drift entry (*What Doesn't Work*, 2026-07-29).
- `reviewer-core/INSIGHTS.md` — the 2026-07-31 mechanical grounding gate
  decision; constrains AC-25.
- `server/INSIGHTS.md` — read; the *What Doesn't Work* entries are about MCP
  transport, `severityCounts` prototype-chain indexing and the intent
  classifier's logger threading. None constrains this feature directly; the
  logger-threading entry is a near-miss worth knowing when wiring the new run
  log line (AC-17).
- `client/INSIGHTS.md` — read; *What Doesn't Work* is empty. The query-key
  prefix-invalidation and thread-the-prop-instead patterns are relevant to the
  Context tab's data fetching but are implementation guidance, not requirements.

**Docs and READMEs**

- `reviewer-core/README.md` — the engine's optional prompt slots, `specs` named
  as L05.
- `e2e/README.md` — deterministic locators only, no LLM, read-only seeded data.
  This is why AC-25 cannot be an e2e criterion.
- `TESTING.md` — lane split and the `*.it.test.ts` rule.

**Source read**

`reviewer-core/src/prompt.ts`; `server/src/modules/reviews/run-executor.ts`;
`server/src/modules/reviews/helpers.ts`;
`server/src/vendor/shared/contracts/trace.ts`;
`server/src/vendor/shared/contracts/knowledge.ts`;
`server/src/vendor/shared/contracts/findings.ts`;
`server/src/platform/prompt-log.ts`; `server/src/platform/config.ts`;
`server/src/adapters/git/simple-git.ts`; `server/src/modules/intent/service.ts`;
`server/src/modules/settings/routes.ts`; `server/src/db/schema/agents.ts`;
`client/src/app/agents/[id]/_components/AgentEditor/` (tabs + constants);
`client/src/app/repos/[repoId]/pulls/[number]/_components/RunTraceDrawer/`;
`client/messages/en/context.json`; `client/src/components/app-shell/helpers.ts`.

**MCP**

The `devdigest` MCP server was unreachable (connection refused on
`http://127.0.0.1:3001/mcp`; `./scripts/dev.sh` is not running), so the live
agent list, current findings, extracted conventions and blast radius were not
consulted and nothing in this spec is grounded in runtime state.

## Open questions

**None.** All twelve clarifications raised in the 2026-08-28 draft are resolved;
no clarification markers remain in this document.

The decisions are recorded in the sections above. Summarised here so a reader
can see what was *chosen* rather than only what the spec now says — and so a
later reversal is visibly a change of decision, not a gap being filled:

| # | Question | Decision | Lands in |
|---|----------|----------|----------|
| 1 | Which repo's documents does the Context tab list? | Per `(agent, repo)`; the tab carries a repo picker. A run is always for one repo+PR, and one agent reused across repos can carry different documents in each. | Actors & triggers; AC-26, AC-27 |
| 2 | Where do search roots live? | A per-repository setting, workspace default `specs`, `docs`, `insights`. Not `AppConfig` — roots differ per repo. | Contract changes; Constraints; AC-29 |
| 3 | What is "document type"? | Derived from the search root: `spec` / `doc` / `insight`. No front-matter parsing. | Contract changes; AC-28 |
| 4 | Are attachments versioned? | Yes — part of the immutable config snapshot for agents *and* skills; editing bumps the version. Reason: a past run must show which documents it was told to read, and content is deliberately not snapshotted. | Contract changes; AC-30, AC-31 |
| 5 | What does "cites the document" mean? | Path in the `rationale`, substring-checked. `Finding` unchanged, no new shared field. | Contract changes; AC-12, AC-25 |
| 6 | Moved or deleted attached path? | Skip, continue the run, record as unreachable in the trace — the `IntentService.gather` pattern. | AC-18 |
| 7 | Overflow? | Include in attachment order until the ceiling would be crossed; omit the rest whole; record omitted paths. Ceiling value is a named constant the planner sizes. | AC-21 |
| 8 | Token measurement? | `container.tokenizer.count` (tiktoken), the estimator the skills log line already uses. | AC-NF-06 |
| 9 | Discovery latency budget? | None for v1 — an explicit non-requirement. AC-NF-05 withdrawn rather than given an invented number. | ~~AC-NF-05~~ + the note beneath it |
| 10 | Is `context.json` authoritative? | No — stale scaffolding, rewritten to match this spec as `skills.json` was. | Constraints; AC-33, AC-NF-04 |
| 11 | Ordering? | Agent's own documents first, then linked skills in skill-link order. | AC-32 |
| 12 | CI review path? | Studio only in v1; CI has no studio DB to resolve attachments from. | Scope — out; Actors & triggers |

Two consequences worth carrying forward rather than rediscovering:

- **Decision 4 implies a `SkillVersion` widening.** That snapshot holds only
  `body` today, so "skills are versioned the same way agents are" is not free —
  it is a contract change, called out under Contract changes.
- **Decisions 7 and 11 interact.** Overflow drops from the end and skills sort
  last, so a linked skill's documents are the first to be omitted when the
  ceiling is reached. That is a consequence of two independently reasonable
  choices, not something either decision states on its own.
