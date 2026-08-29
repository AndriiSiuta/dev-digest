import 'dotenv/config';
import { createDb, type Db } from './client.js';
import * as t from './schema.js';
import { eq, and, sql } from 'drizzle-orm';
import {
  GENERAL_REVIEWER_PROMPT,
  SECURITY_REVIEWER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
  TEST_QUALITY_REVIEWER_PROMPT,
  API_CONTRACT_REVIEWER_PROMPT,
} from './seed-prompts.js';
import { SEED_SKILLS } from './seed-skills.js';
import { EVAL_SEED_CASE_COUNT } from '../modules/eval/constants.js';

/** Default provider/model for the built-in reviewer agents. */
const DEFAULT_PROVIDER = 'openrouter' as const;
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * Seed the starter's demo data. Idempotent: re-running upserts the default
 * workspace/user and the demo fixtures.
 *
 * Seeds: default workspace + system user + membership, default settings,
 * demo repo (acme/payments-api), PR #482 with files/commits, a sample review
 * with a few findings, and the three built-in agents (General + Security +
 * Performance), all on the default openrouter/deepseek-v4-flash provider+model.
 *
 * Course lessons populate the other tables (skills, conventions, memory, eval,
 * …) once their features are built — they start empty here.
 */

export const DEFAULT_WORKSPACE_NAME = 'default';
export const SYSTEM_USER_EMAIL = 'you@local';

export async function seed(db: Db): Promise<{ workspaceId: string; userId: string }> {
  // ---- workspace + user (no-auth defaults) ----
  let [ws] = await db
    .select()
    .from(t.workspaces)
    .where(eq(t.workspaces.name, DEFAULT_WORKSPACE_NAME));
  if (!ws) {
    [ws] = await db
      .insert(t.workspaces)
      .values({ name: DEFAULT_WORKSPACE_NAME })
      .returning();
  }
  const workspaceId = ws!.id;

  let [user] = await db.select().from(t.users).where(eq(t.users.email, SYSTEM_USER_EMAIL));
  if (!user) {
    [user] = await db
      .insert(t.users)
      .values({ email: SYSTEM_USER_EMAIL, name: 'You' })
      .returning();
  }
  const userId = user!.id;

  await db
    .insert(t.workspaceMembers)
    .values({ workspaceId, userId, role: 'owner' })
    .onConflictDoNothing();

  // ---- default settings ----
  const defaultSettings: Record<string, unknown> = {
    polling_interval_min: 5,
    theme: 'dark',
    density: 'regular',
    sync_to_folder: true,
  };
  for (const [key, value] of Object.entries(defaultSettings)) {
    await db
      .insert(t.settings)
      .values({ workspaceId, userId, key, value })
      .onConflictDoNothing();
  }

  // ---- demo repo (acme/payments-api) ----
  let [repo] = await db
    .select()
    .from(t.repos)
    .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.fullName, 'acme/payments-api')));
  if (!repo) {
    [repo] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: 'payments-api',
        fullName: 'acme/payments-api',
        defaultBranch: 'main',
        clonePath: null,
        createdBy: userId,
      })
      .returning();
  }
  const repoId = repo!.id;

  // ---- PR #482 (rate limiting) ----
  let [pr] = await db
    .select()
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.repoId, repoId), eq(t.pullRequests.number, 482)));
  if (!pr) {
    [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 482,
        title: 'Add rate limiting to public API endpoints',
        author: 'marisa.koch',
        branch: 'feat/rate-limit-public',
        base: 'main',
        headSha: 'a1b2c3d4e5f6',
        additions: 247,
        deletions: 38,
        filesCount: 9,
        status: 'needs_review',
        body: 'Add rate limiting to public API endpoints to prevent abuse from unauthenticated clients.',
      })
      .returning();

    // pr_files (subset)
    await db.insert(t.prFiles).values([
      { prId: pr!.id, path: 'src/middleware/ratelimit.ts', additions: 84, deletions: 0 },
      { prId: pr!.id, path: 'src/api/public/webhooks.ts', additions: 31, deletions: 6 },
      { prId: pr!.id, path: 'src/config.ts', additions: 4, deletions: 0 },
      { prId: pr!.id, path: 'src/api/users.ts', additions: 7, deletions: 2 },
    ]);

    // pr_commits
    await db.insert(t.prCommits).values({
      prId: pr!.id,
      sha: 'a1b2c3d4e5f6',
      message: 'Add token-bucket rate limiter',
      author: 'marisa.koch',
    });

    // a sample review + findings so the PR shows results before the first run
    const [review] = await db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId: pr!.id,
        kind: 'review',
        verdict: 'request_changes',
        summary:
          'Solid middleware approach, but a Stripe secret key is committed in plaintext and the user-list endpoint introduces an N+1 query under the new limiter.',
        score: 61,
        model: 'seed',
      })
      .returning();

    await db.insert(t.findings).values([
      {
        reviewId: review!.id,
        file: 'src/config.ts',
        startLine: 12,
        endLine: 12,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key in commit',
        rationale: 'Line 12 contains a literal `sk_live_` Stripe secret key.',
        suggestion: 'Move to env var and rotate the key immediately.',
        confidence: 0.98,
      },
      {
        reviewId: review!.id,
        file: 'src/api/users.ts',
        startLine: 45,
        endLine: 52,
        severity: 'WARNING',
        category: 'perf',
        title: 'N+1 query in user list endpoint',
        rationale: 'Loop issues one query per user → N+1.',
        suggestion: 'Use a single IN query and group in memory.',
        confidence: 0.86,
      },
    ]);
  }

  // ---- built-in agents (the three starter presets) ----
  // Prompt bodies live in ./seed-prompts.ts (mirrored in docs/agent-prompts/*.md).
  const seedAgents: Array<typeof t.agents.$inferInsert> = [
    {
      workspaceId,
      name: 'General Reviewer',
      description: 'Reviews a PR diff for bugs, correctness, and clarity.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: GENERAL_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'Security Reviewer',
      description: 'Flags secrets, injection, SSRF and the lethal trifecta before merge.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: SECURITY_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'Performance Reviewer',
      description: 'Catches N+1 queries, missing indexes, and hot-path allocations.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: PERFORMANCE_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    // The two skill-driven reviewers ship DISABLED: they are the control
    // experiment for the Skills lesson (run once with their skills off, once
    // with them on), and leaving them off keeps a fresh clone's review runs
    // identical to the pre-skills starter.
    {
      workspaceId,
      name: 'Test Quality Reviewer',
      description: 'Reviews the tests: uncovered branches, missing corner cases, over-mocking, flake.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: TEST_QUALITY_REVIEWER_PROMPT,
      enabled: false,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'API Contract Reviewer',
      description: 'Catches breaking changes to routes, request/response shapes and status codes.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: API_CONTRACT_REVIEWER_PROMPT,
      enabled: false,
      version: 1,
      createdBy: userId,
    },
  ];
  for (const a of seedAgents) {
    const [existing] = await db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, a.name)));
    if (!existing) await db.insert(t.agents).values(a);
  }

  await seedSkills(db, workspaceId);
  await seedEvalCases(db, workspaceId);

  return { workspaceId, userId };
}

/**
 * Seed the starter skills and link them to their agents.
 *
 * Idempotent by name on both sides: an existing skill is left exactly as the
 * user edited it (never overwritten), and a link is upserted rather than
 * duplicated. Links are written directly here — the version bump the agents
 * repository does on a link change is an editor concern, and a seeded agent
 * should read as version 1.
 */
async function seedSkills(db: Db, workspaceId: string): Promise<void> {
  const skillIdByName = new Map<string, string>();

  for (const sk of SEED_SKILLS) {
    const [existing] = await db
      .select()
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.name, sk.name)));
    if (existing) {
      skillIdByName.set(sk.name, existing.id);
      continue;
    }
    const [row] = await db
      .insert(t.skills)
      .values({
        workspaceId,
        name: sk.name,
        description: sk.description,
        type: sk.type,
        source: 'manual',
        body: sk.body,
        enabled: true,
        version: 1,
      })
      .returning();
    if (!row) continue;
    skillIdByName.set(sk.name, row.id);
    await db.insert(t.skillVersions).values({ skillId: row.id, version: 1, body: sk.body });
  }

  // Link each skill to its agents, keeping SEED_SKILLS order as prompt order.
  const orderByAgent = new Map<string, number>();
  for (const sk of SEED_SKILLS) {
    const skillId = skillIdByName.get(sk.name);
    if (!skillId) continue;
    for (const agentName of sk.agents) {
      const [agent] = await db
        .select()
        .from(t.agents)
        .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, agentName)));
      if (!agent) continue;
      const order = orderByAgent.get(agent.id) ?? 0;
      orderByAgent.set(agent.id, order + 1);
      await db
        .insert(t.agentSkills)
        .values({ agentId: agent.id, skillId, order, enabled: true })
        .onConflictDoNothing();
    }
  }
}

/** One hand-authored eval case for the Security Reviewer (AC-39). */
interface SeedEvalCase {
  /** Idempotency marker, stored as `input_meta.source_finding_id`. */
  slug: string;
  name: string;
  kind: 'must_find' | 'must_not_flag';
  file: string;
  startLine: number;
  endLine: number;
  /** A VALID unified-diff fragment (`@@` hunks) — the grounding gate builds its
   *  line index from parsed hunks, so an unparseable fragment scores everything
   *  ungrounded. The expectation range points at real new-side lines. */
  patch: string;
  prTitle: string;
  prBody: string;
  prNumber: number;
}

/**
 * Hand-authored because seeded data has zero findings, so the finding-born
 * path cannot produce them. 5 `must_find` (classic security misses) +
 * 3 `must_not_flag` (dismissed-noise shapes). Every "secret" below is an
 * obviously fake fixture value, same convention as the PR #482 sample data.
 */
const SEED_EVAL_CASES: SeedEvalCase[] = [
  {
    slug: 'seed:leaked-key',
    name: 'Hardcoded payment key committed in config',
    kind: 'must_find',
    file: 'src/config.ts',
    startLine: 11,
    endLine: 11,
    patch:
      '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_SEEDFIXTURE000",\n   redisUrl: process.env.REDIS_URL,',
    prTitle: 'Wire up payments config',
    prBody: 'Adds the payment provider settings to the config module.',
    prNumber: 511,
  },
  {
    slug: 'seed:sql-injection',
    name: 'SQL built by string concatenation from user input',
    kind: 'must_find',
    file: 'src/db/users.ts',
    startLine: 41,
    endLine: 42,
    patch:
      '@@ -40,2 +40,4 @@\n export async function findUser(db, name) {\n+  const query = "SELECT * FROM users WHERE name = \'" + name + "\'";\n+  return db.raw(query);\n }',
    prTitle: 'Add user lookup by name',
    prBody: 'Supports the new admin search box.',
    prNumber: 512,
  },
  {
    slug: 'seed:ssrf',
    name: 'Proxy fetches an attacker-controlled URL (SSRF)',
    kind: 'must_find',
    file: 'src/api/fetch-proxy.ts',
    startLine: 13,
    endLine: 14,
    patch:
      '@@ -12,2 +12,5 @@\n export async function proxy(req, res) {\n+  const target = req.query.url;\n+  const resp = await fetch(target);\n+  res.send(await resp.text());\n }',
    prTitle: 'Add image proxy endpoint',
    prBody: 'Lets the client fetch remote previews through the API.',
    prNumber: 513,
  },
  {
    slug: 'seed:missing-auth',
    name: 'Admin listing endpoint has no auth check',
    kind: 'must_find',
    file: 'src/api/admin.ts',
    startLine: 9,
    endLine: 11,
    patch:
      "@@ -8,2 +8,5 @@\n router.get('/admin/users', async (req, res) => {\n+  // TODO: auth\n+  const users = await db.listAllUsers();\n+  res.json(users);\n });",
    prTitle: 'Add admin user listing',
    prBody: 'First cut of the admin console backend.',
    prNumber: 514,
  },
  {
    slug: 'seed:weak-hash',
    name: 'Passwords hashed with MD5',
    kind: 'must_find',
    file: 'src/auth/password.ts',
    startLine: 4,
    endLine: 5,
    patch:
      "@@ -3,2 +3,4 @@\n import crypto from 'node:crypto';\n+export const hashPassword = (pw) =>\n+  crypto.createHash('md5').update(pw).digest('hex');\n export const compare = (a, b) => a === b;",
    prTitle: 'Add password hashing helper',
    prBody: 'Replaces the plain-text comparison with a hash.',
    prNumber: 515,
  },
  {
    slug: 'seed:benign-refactor',
    name: 'Date formatting tweak flagged as a risk',
    kind: 'must_not_flag',
    file: 'src/lib/format.ts',
    startLine: 21,
    endLine: 21,
    patch:
      '@@ -20,3 +20,3 @@\n export function formatDate(d) {\n-  return d.toISOString();\n+  return d.toISOString().slice(0, 10);\n }',
    prTitle: 'Shorten displayed dates',
    prBody: 'Date-only display in the activity list.',
    prNumber: 516,
  },
  {
    slug: 'seed:test-fixture-token',
    name: 'Fake token in a test fixture flagged as a leak',
    kind: 'must_not_flag',
    file: 'test/fixtures.ts',
    startLine: 6,
    endLine: 6,
    patch:
      "@@ -5,2 +5,3 @@\n export const FIXTURES = {\n+  fakeToken: 'test-token-not-a-secret',\n };",
    prTitle: 'Add auth test fixtures',
    prBody: 'Deterministic fixtures for the auth suite.',
    prNumber: 517,
  },
  {
    slug: 'seed:startup-log',
    name: 'Startup log line flagged as information disclosure',
    kind: 'must_not_flag',
    file: 'src/server.ts',
    startLine: 31,
    endLine: 31,
    patch:
      '@@ -30,2 +30,3 @@\n app.listen(PORT, () => {\n+  console.log(`listening on ${PORT}`);\n });',
    prTitle: 'Log the bound port on boot',
    prBody: 'Small DX improvement for local runs.',
    prNumber: 518,
  },
];

/**
 * Seed EVAL_SEED_CASE_COUNT eval cases for the Security Reviewer (AC-39).
 *
 * Idempotent via the `seed:<slug>` marker in `input_meta.source_finding_id`
 * (the same field the finding-born path uses for its duplicate check): a
 * re-run skips every case whose marker already exists, the same name-check
 * pattern `seedAgents` uses.
 */
async function seedEvalCases(db: Db, workspaceId: string): Promise<void> {
  if (SEED_EVAL_CASES.length !== EVAL_SEED_CASE_COUNT) {
    throw new Error(
      `SEED_EVAL_CASES has ${SEED_EVAL_CASES.length} entries, expected ${EVAL_SEED_CASE_COUNT}`,
    );
  }
  const [agent] = await db
    .select()
    .from(t.agents)
    .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, 'Security Reviewer')));
  if (!agent) return;

  for (const c of SEED_EVAL_CASES) {
    const [existing] = await db
      .select({ id: t.evalCases.id })
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          sql`${t.evalCases.inputMeta}->>'source_finding_id' = ${c.slug}`,
        ),
      );
    if (existing) continue;
    await db.insert(t.evalCases).values({
      workspaceId,
      ownerKind: 'agent',
      ownerId: agent.id,
      name: c.name,
      inputDiff: c.patch,
      inputFiles: [c.file],
      inputMeta: {
        pr_title: c.prTitle,
        pr_body: c.prBody,
        repo: 'acme/payments-api',
        pr_number: c.prNumber,
        source_finding_id: c.slug,
      },
      expectedOutput: {
        kind: c.kind,
        file: c.file,
        start_line: c.startLine,
        end_line: c.endLine,
      },
    });
  }
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const handle = createDb(url);
  seed(handle.db)
    .then(async (r) => {
      console.log('✓ seeded', r);
      await handle.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('✗ seed failed:', err);
      await handle.close();
      process.exit(1);
    });
}
