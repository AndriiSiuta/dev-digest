# Insights — e2e

Decisions about the browser suite and dead ends. Read before adding a flow or
"fixing" a flaky one.

Read at the start of a task, written at the end of one, by the
`engineering-insights` skill. Sections are fixed — add to the one that fits,
newest first. If it would be obvious to anyone reading the code, leave it out.

Formats — `Decisions` takes prose; every other section takes a dated bullet:

```markdown
### YYYY-MM-DD — <short title>

**What:** the decision, in one sentence.
**Why:** the constraint that forced it.
**Rejected:** what we tried or considered, and how it failed.
```

```markdown
- **YYYY-MM-DD** — <the claim, specific enough to act on cold>.
  `specs/NN-name.flow.json`
```

Roughly 5 entries per section. Promote stable entries into `docs/` and delete
them here.

---

## Decisions

### 2026-07-31 — Hermetic runner instead of resetting the dev DB

**What:** `npm run e2e:hermetic` boots an isolated, freshly-seeded stack on
alternate ports (Postgres :5433, API :3101, web :3100).
**Why:** flows assume exactly one seeded repo — flow `02` follows the home
redirect to the *first* repo — so a dev DB with other imported repos fails
02/04/05.
**Rejected:** `docker compose down -v` to reset the dev DB. It deletes the
`devdigest_pgdata` volume along with every real repo and review you imported.

### 2026-07-31 — Deterministic locators, no AI commands

**What:** flows use only `--url`, `--text`, and `find role|text|label`, against
read-only seeded data.
**Why:** the suite must run in CI with no API key and produce identical results
every time.
**Rejected:** agent-browser's `chat` command — convenient, but it makes runs
non-reproducible and requires a key.

## What Works

_None yet._

## What Doesn't Work

_None yet._

## Codebase Patterns

_None yet._

## Tool & Library Notes

- **2026-08-16** — In this sandbox, `npm i -g agent-browser && agent-browser
  install` succeeds (downloads Chrome for Testing fine), but every
  `agent-browser open` then fails with `No usable sandbox!
  content/browser/zygote_host/zygote_host_impl_linux.cc` — the container has no
  unprivileged user namespaces, so Chrome's own sandbox can't start. `npm run
  e2e:hermetic` boots Postgres/API/web correctly and only fails at the browser
  step (`0/7 flows passed`, all `Command failed: agent-browser open …`). Not
  yet resolved here: the CLI's `open`/`agent-browser.json` docs show no
  `--no-sandbox`/Chrome-args passthrough, so making this container run e2e
  needs upstream support or a wrapper, not a flow change. `scripts/e2e.sh`.

## Recurring Errors & Fixes

_None yet._

## Open Questions

_None yet._
