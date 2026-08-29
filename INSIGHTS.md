# DevDigest — insights

Durable findings recorded by the `engineering-insights` skill: things that are
true about this code but not visible in it. Append-only — correct a stale entry
with a dated note beneath it rather than editing it away.

This is the **root** file: it holds only findings that cross package boundaries.
Anything scoped to one package lives in that package's file —
[`client`](client/INSIGHTS.md) · [`server`](server/INSIGHTS.md) ·
[`reviewer-core`](reviewer-core/INSIGHTS.md) · [`e2e`](e2e/INSIGHTS.md).

Sections are fixed. Add to the one that fits; never invent a new heading.

## What Works

- **2026-08-29** — Sending `plan.md` to a model of a **different family** before
  any code is written pays for itself, but not in the way you would expect: of
  20 findings on the PR Brief plan, **none** challenged the feature's shape, the
  `@devdigest/shared` contract, the cache key or the architecture — and 8 of the
  14 accepted were **tests that would have passed green without proving their
  AC**. The three sharpest: an AC-30 test that could not distinguish "the server
  recomputed the risk level" from "the model happened to agree" (fix: stub the
  model at `'none'` while a `high` risk survives); a grounding universe taken
  from Smart Diff's output, which is a strict subset of the changed files, so a
  risk citing a real-but-unclassified file would have been dropped as invented;
  and a `getBrief` projection omitting `head_sha`, which would make the cache
  never hit and charge for a model call on every request **with no type error**.
  Same-family review is weakest exactly there, because the reviewer shares the
  author's idea of what "tested" means. Budget ~$0.06 and one round trip.
  Evidence: `plans/04-pr-brief.review-note.md`, and the Revision log in
  `plans/04-pr-brief.plan.md`.

- **2026-08-29** — …but **verify the outside reviewer's factual claims before
  applying any of them**: 3 of those 20 findings were wrong about this codebase
  and would have caused damage. The worst asserted that the plan "invents
  `reviewRepo.getIntent`, duplicating the intent module" and prescribed adding a
  facade method — when `IntentService.get` is itself exactly
  `return this.container.reviewRepo.getIntent(prId)`
  (`server/src/modules/intent/service.ts:46`). The other two claimed
  `container.projectContextDocs` was absent (`platform/container.ts:198`) and
  that `resolveFeatureModel`'s signature might not match
  (`modules/settings/feature-models.ts:51-55`). A cross-family reviewer has no
  repo access — treat its architecture claims as hypotheses and its test-rigour
  claims as findings.

## What Doesn't Work

- **2026-08-28** — `implementation-planner` is read-only by design, so a
  Development Plan exists **only in the calling session's transcript** — nothing
  writes it to disk, and `plan-verifier` needs that exact text later to run its
  plan lane. The orchestrator must persist the plan itself before dispatching
  `implementer`; a scratchpad path under
  `/tmp/claude-*/<session>/scratchpad/` survives the session but not a
  `--resume` into a new one, so a plan worth verifying twice belongs in the
  repo. The same gap does not exist for specs: `spec-creator` writes its own
  file. Evidence: `.claude/agents/implementation-planner.md` frontmatter
  (`tools: Read, Grep, Glob, Bash` — no Write), vs `spec-creator.md`.

- **2026-07-29** — Editing `client/src/vendor/shared/` alone silently desyncs the client from the API: it is a hand-copy of the canonical `server/src/vendor/shared/`, there is no sync script, and it already lags in 5 files. Evidence: `diff -rq server/src/vendor/shared client/src/vendor/shared`.

  | File | Missing on the client side |
  |------|----------------------------|
  | `adapters.ts` | `sessionId` on the LLM call; `'openrouter'` in the provider union; `CommitFile` / `CommitFilesPayload` |
  | `contracts/eval-ci.ts` | the whole `AgentManifest` schema; the `Provider` / `CiFailOn` imports |
  | `contracts/knowledge.ts` | `'openrouter'` notes; expanded `CiFailOn` policy comments; the `agent_versions` config-snapshot block |
  | `contracts/productionize.ts` | `'openrouter'` in the provider enum |
  | `contracts/trace.ts` | comment wording only (harmless) |

  Every gap is OpenRouter- or CI-runner-related, so the client cannot currently express an OpenRouter-backed agent even though the API accepts one.

  - **2026-08-28** — The table above is now partly stale, and the entry's claim
    still holds: `contracts/knowledge.ts` and `contracts/trace.ts` were brought
    into sync by hand (the project-context contract change), so `diff -rq`
    reports **3** differing files — `adapters.ts`, `contracts/eval-ci.ts`,
    `contracts/productionize.ts`. All three are still the OpenRouter/CI-runner
    gap. What the sync proved: the **client typecheck is the mechanism that
    catches an incomplete hand-copy** — an unmirrored `SkillVersion.context_docs`
    surfaced as three TS2741/TS2322 errors in `client/`, not as a runtime
    surprise. Run `cd client && ./node_modules/.bin/tsc --noEmit` immediately
    after touching `server/src/vendor/shared/`.

- **2026-07-29** — `.claude/skills/README.md` documents a `.cursor/skills → ../.claude/skills` symlink that does not exist, so Cursor gets no skills here. Evidence: `ls .cursor` → no such directory.

- **2026-08-05** — No package in this repo has ESLint — no config file, no `eslint` dependency, no `lint` script, no lint step in any of the five workflows — so the `// eslint-disable-next-line react-hooks/exhaustive-deps` comments in `client/src` suppress a rule that has never run, and nothing mechanically enforces import direction or hook deps. Evidence: `client/src/lib/hooks/reviews.ts:212`, `client/src/app/agents/[id]/_components/AgentEditor/_components/ConfigTab/ConfigTab.tsx:39`, `client/src/app/repos/[repoId]/pulls/[number]/_components/ReviewRunAccordion/ReviewRunAccordion.tsx:56`.
  - **2026-08-05** — Partly stale the same day: `server/` now has `eslint` + `typescript-eslint` and a `lint` script, but still no config file, so `pnpm lint` there fails rather than lints; the suppressed-rule finding above remains true of `client/`. Evidence: `server/package.json:11,45,50`; no `server/eslint.config.*`.
    - **2026-08-05** — Fully resolved for three of four packages: `server/`, `client/` and `reviewer-core/` each now have both a `lint` script and an `eslint.config.mjs`, and `cd server && pnpm lint` exits 0. The configs are **untracked on `refactor/architecture-plan-wave-0-3`**, so lint works locally and is still absent for anyone who has not pulled them; `e2e/` has neither. Evidence: `server/eslint.config.mjs`, `client/eslint.config.mjs`, `reviewer-core/eslint.config.mjs`.

- **2026-08-05** — The skills pipeline is complete on every layer except the one call that feeds it: `run-executor` builds its `reviewPullRequest` input without a `skills` key, so `parts.skills` is always undefined, the `## Skills / rules` section is never emitted and `PromptAssembly.skills` is always null — the trace drawer's skills block is dead UI, not a rendering bug. Evidence: `server/src/modules/reviews/run-executor.ts:189-205` (no `skills:`), `reviewer-core/src/prompt.ts:88-89,109`.

- **2026-08-05** — `client/messages/en/skills.json` promises a trust model the engine does not implement: four strings tell the user an imported skill is "wrapped as untrusted data" / "delimiter-wrapped", while `assemblePrompt` joins `parts.skills` verbatim into a trusted user section and only `wrapUntrusted()`s the diff/specs/repo-map — so shipping that copy as-is would state a security property the code does not provide. Evidence: `client/messages/en/skills.json:48,52,56,96` vs `reviewer-core/src/prompt.ts:89,109`.

## Codebase Patterns

- **2026-08-05** — Pre-staged-for-a-lesson goes well beyond the empty tables `server/INSIGHTS.md` lists: for skills, the DB tables, the `@devdigest/shared` contracts, the `## Skills / rules` prompt section, the trace-drawer block + its colour token, and the entire `messages/en/skills.json` i18n namespace all ship in the starter with no module and no screen behind them — search for existing scaffolding before writing any of it. Evidence: `server/src/vendor/shared/contracts/knowledge.ts:114-141`, `reviewer-core/src/prompt.ts:109`, `client/src/app/repos/[repoId]/pulls/[number]/_components/RunTraceDrawer/constants.ts:16`, `client/messages/en/skills.json`.
  **Refined 2026-08-29 — the pre-staged i18n namespace is the dangerous half,
  and it has now misled three features running.** `skills.json` described a
  trust model the engine lacked (entry above); `context.json` described a
  reindex/chunks surface Project Context deliberately did not build
  (`specs/03-project-context-folder.md` AC-33); `brief.json` described the *old*
  four-block composition plus a git-blame `why.*` sub-namespace belonging to an
  unrelated feature. Contracts and tables that are pre-staged merely sit unused,
  but pre-staged **copy** reads as a requirement and quietly widens scope. Treat
  a `messages/en/*.json` namespace with **zero usages in `client/src`** as a
  proposal from a past author, not a spec: diff it against what you are actually
  building and rewrite it, and expect to delete keys. Check with
  `grep -rl "useTranslations(\"<ns>\")" client/src`.

  - **2026-08-05** — Conventions was staged even further than skills — table, `ConventionCandidate` contract, `FEATURE_MODELS.conventions`, `repoIntel.getConventionSamples()`, the whole `messages/en/conventions.json` namespace, `activeKeyFor("/conventions")` AND the mock adapter's schema names all shipped with no module, so the build was assembly, not authoring. Evidence: `server/src/modules/repo-intel/service.ts:630`, `client/src/components/app-shell/helpers.ts:31`, `docs/specs/conventions.md` §2.

- **2026-08-05** — `POST /agents/:id/skills` is two endpoints in one body schema and picking the wrong shape silently destroys data: `{skills:[…]}` / `{skill_ids:[…]}` REPLACE the agent's whole ordered set (that is what `useSetAgentSkills` sends), while `{skill_id}` appends — so "also give this agent the new skill" must use the single-id form or the agent's other skills vanish. Evidence: `server/src/modules/agents/routes.ts:170-180`, `client/src/lib/hooks/skills.ts` (`useLinkAgentSkill` vs `useSetAgentSkills`).

- **2026-07-29** — `.gitignore` carries un-ignore rules for an `agent-runner/dist/` that does not exist yet; they are pre-staged for the Export-to-CI lesson (L06), not leftovers to clean up. Evidence: `.gitignore:3-6`, `reviewer-core/README.md:7-9`.

## Tool & Library Notes

- **2026-08-14** — `pnpm arch` is invoked by `pr-self-review` (phase 2) and named
  in `onion-architecture`'s Enforcement section, and the 2026-08-05 audit note
  below says it was wired — but `server/package.json` on `main` has no `arch`
  script; only the pieces landed (`server/.dependency-cruiser.cjs`,
  `dependency-cruiser` ^17.4.3 in devDependencies). Until the script exists,
  run `cd server && pnpm exec depcruise --config .dependency-cruiser.cjs src`;
  agent prompts must not rely on `pnpm arch`. Evidence:
  `grep '"arch"' server/package.json` → no match.

- **2026-08-14** — Claude Code subagent frontmatter: `skills:` preloads the
  full skill content into the subagent at startup, but a `tools:` allowlist
  drops the `Skill` tool unless it is listed explicitly — so an agent that must
  invoke skills on demand needs both. `.claude/agents/implementer.md` lists
  `Skill` for per-task skill invocation; `implementation-planner.md`
  deliberately omits it (read-only, skills preloaded instead). Evidence:
  code.claude.com/docs/en/sub-agents, frontmatter field table.

  - **2026-08-28** — The same `tools:` allowlist also accepts MCP tools, one
    at a time, in `mcp__<server>__<tool>` form — where `<server>` is the key
    under `mcpServers` in `~/.claude.json`, here `devdigest`, not the
    `127.0.0.1:3001/mcp` URL. So the grants on
    `.claude/agents/spec-creator.md` read
    `mcp__devdigest__devdigest_get_findings` and friends, with the server
    name and the tool's own prefix both present. There is no server-wide
    grant, and that is the point: the fifth tool,
    `devdigest_run_agent_on_pull_request`, blocks on a real review run and
    writes `agent_runs` + findings rows, so a read-only agent must be handed
    the four read tools by name. Evidence:
    `server/specs/01-mcp-server.md` §Tools and §"The blocking contract".

- **2026-07-29** — Half this repo is pnpm and half is npm, so running `pnpm install` in `reviewer-core/` or `e2e/` would create a second competing lockfile — match the lockfile already in the directory, not the root README's pnpm prerequisite.

  | Package | Lockfile |
  |---------|----------|
  | `server/`, `client/` | `pnpm-lock.yaml` |
  | `reviewer-core/`, `e2e/` | `package-lock.json` |

- **2026-07-29** — `skills-lock.json` disagrees with `.claude/skills/` in both directions, so it cannot be read as an index of available skills; read the directory. Evidence: lock-only — `architecture-patterns`, `github-workflow-automation`; disk-only — `mermaid-diagram`, `react-best-practices`, `react-testing-library`, `security`.

## Recurring Errors & Fixes

- **2026-08-29** — A system LLM feature failing with a 500 wrapping
  `401 Incorrect API key provided` is usually the **registry default provider**,
  not the feature. `FEATURE_MODELS` defaults `risk_brief` to `openai`/`gpt-4.1`,
  and this machine's `~/.devdigest/secrets.json` holds an `OPENAI_API_KEY`
  beginning `v1-…`, which is not OpenAI's `sk-…` format and is rejected. The fix
  is a **workspace Settings override**, never a contract edit — the same
  mechanism `conventions` already uses:
  `curl -X PUT localhost:3001/settings -H 'content-type: application/json' -d
  '{"feature_models":{"risk_brief":{"provider":"openrouter","model":"…"}}}'`.
  Check key shapes without printing them:
  `python3 -c "import json,os;print({k:v[:8] for k,v in
  json.load(open(os.path.expanduser('~/.devdigest/secrets.json'))).items()})"`.
  Evidence: `server/src/modules/settings/feature-models.ts:51-56`,
  `server/src/vendor/shared/contracts/platform.ts:58-64`.

- **2026-08-29** — A dev API answering `{"message":"Route GET:/pulls/:id/brief
  not found","error":"Not Found","statusCode":404}` (Fastify's DEFAULT 404, not
  the app's `{"error":{"code":"not_found",...}}` envelope) means the running
  process predates the module's registration in `src/modules/index.ts` — not a
  registration bug. `scripts/dev.sh` runs `pnpm dev` = `tsx watch src/server.ts`,
  but a stack started before a new module exists still needs a restart if it was
  launched as plain `tsx src/server.ts` (check `ps aux | grep server.ts`: the
  watch parent is absent). Read the 404's SHAPE before touching the code.

## Session Notes

- **2026-07-29** — Wrote per-module `CLAUDE.md` files and swept the repo for drift while doing it; every entry here and in the per-module files came from that sweep. The `engineering-insights` skill was built in the same session.
- **2026-07-29** — Run Cost Badge lab re-added per-run cost (`agent_runs.cost_usd`, migration 0010) that commit `d45ab0d` had deliberately removed — the removal only disconnected persistence/UI, `reviewer-core` kept computing `ReviewOutcome.costUsd` the whole time, so the re-add was a one-field reconnect. Evidence: `reviewer-core/src/review/run.ts:216`.
- **2026-08-04** — `.claude/skills/react-frontend-architecture/` deliberately holds only `SOURCES.md` (curated research for a skill not yet written) — the missing `SKILL.md` is pending work, not a broken skill to clean up. Evidence: `.claude/skills/react-frontend-architecture/SOURCES.md:1-15`.
  - **2026-08-04** — `.claude/skills/onion-architecture/` now follows the same pattern: `SOURCES.md` holds the verified research plus the SKILL.md plan (§12) for the backend layering skill. Evidence: `.claude/skills/onion-architecture/SOURCES.md:1-10`.
    - **2026-08-05** — Resolved: the skill is written (`SKILL.md` v1.0.0 + `README.md` sources) and listed in the catalog; unlike the frontend skill, `SOURCES.md` was **kept** — it carries the per-tool layer map (§13) and the live-code drift the rules were written against (§14). Evidence: `.claude/skills/onion-architecture/SKILL.md:1-6`, `.claude/skills/README.md:9`.
  - **2026-08-04** — Resolved same day: renamed to `.claude/skills/frontend-ui-architecture/` and the skill was written (`SKILL.md` v1.0.0 + `README.md` sources); `SOURCES.md` was absorbed into those two files and deleted. Evidence: `.claude/skills/frontend-ui-architecture/SKILL.md:1-6`.
- **2026-08-05** — Second research pass on `.claude/skills/onion-architecture/SOURCES.md`: mapped every backend dependency to an onion layer and added the five areas the first pass missed (LLM SDKs as an ACL, jobs/queues, the SSE run bus, config/secrets, mechanical enforcement); the SKILL.md plan is now §15, and §12 carries a superseded banner.
- **2026-08-05** — Repo-wide architecture read against `frontend-ui-architecture`, the `onion-architecture` SOURCES research, and the React/Next/Fastify/Postgres skills; analysis only, no code changed. Findings landed as entries in this file and in `client` / `server` / `reviewer-core`.
- **2026-08-05** — Acted on that audit: mechanical enforcement (ESLint in all three packages, `dependency-cruiser` layer rules + `pnpm arch`, CI lint steps), the `pulls`/`settings` module promotions with `polling`/`workspace` moved onto shared container repositories, DB indexes + enum CHECK constraints (migrations 0011/0012), and the client's missing error boundaries. Still open from the same audit: no route declares `schema.response`, nothing runs in a transaction, and `client/src/vendor/shared/` still lags the canonical copy.

- **2026-08-05** — Spec for the Skills feature (storage, editor, agent binding, `.md`/`.zip` import, seeded Test Quality + API Contract reviewers) written to `docs/specs/skills.md`; investigation only, no code changed. The four entries above came from that read.
  - **2026-08-05** — Then implemented in full the same session: `modules/skills/`, `agent_skills.enabled` (migration 0013), the `/skills` page + agent Skills tab, `fflate`-based `.zip` import, and the `run-executor` wiring that finally makes the prompt block non-empty. The two entries under *What Doesn't Work* above are resolved by it; the trust-copy one was fixed by rewriting `client/messages/en/skills.json`.

- **2026-08-05** — Built the Conventions Extractor (spec + roadmap in `docs/specs/conventions.md`): `modules/conventions/`, migration 0015, the `/repos/[repoId]/conventions` page and the skill-draft modal. The design premise — a model proposes, code samples and code verifies — is the same grounding-gate shape `reviewer-core` already uses for findings.

## Open Questions

- **2026-08-05** — Is `repoIntel.getConventionSamples()` filtering tests out right for this feature? It reuses the review-context rank filter (`isJunkPath` drops `.test.`/`.spec.`), so testing conventions — some of the most useful house rules — are structurally invisible to the extractor. Evidence: `server/src/modules/repo-intel/service.ts:629-630,709-728`.

- **2026-07-29** — Is the client's vendored `@devdigest/shared` copy meant to be synced by a manual step someone knows about, or was it simply forgotten? Nothing in `scripts/` or CI touches it, and the drift is one-directional.
- **2026-07-29** — Are `architecture-patterns` and `github-workflow-automation` in `skills-lock.json` planned additions or removed skills whose lock entries were never cleaned?
