/**
 * mcp — the five tool input schemas, hand-authored as JSON Schema literals.
 *
 * NO ZOD IN THIS FILE, deliberately and for two independent reasons.
 *
 * The blocking one: `inputSchema` must satisfy `StandardSchemaWithJSON`, i.e.
 * carry a `jsonSchema` converter on `~standard`. Our pinned `zod@3.25.76` does
 * not, and neither does the `zod/v4` bundled inside it — its `~standard` is
 * `{validate, vendor, version}` and its `z.toJSONSchema()` is a top-level
 * helper, not that property. The failure lands at `pnpm typecheck`.
 *
 * The one that would still hold if zod were upgraded: `tools/list` ships this
 * schema VERBATIM, and it is paid for at the start of every session that loads
 * tool definitions upfront. `fromJsonSchema` round-trips a literal byte for byte
 * — nothing injected, no `$schema`, no `title` — so hand-authoring is the only
 * way to have byte-exact control over the most expensive part of that payload.
 * Verified: `fromJsonSchema(lit)['~standard'].jsonSchema.input({target:
 * 'draft-2020-12'})` deep-equals `lit`. (`jsonSchema` is a converter OBJECT with
 * `.input()` / `.output()` methods, not a function.)
 *
 * Rules the literals below hold to, each an acceptance criterion:
 *   - No `$schema`, no root `title`, no root `description` — bytes in every
 *     list, asserted absent by `test/mcp-budget.test.ts`.
 *   - No `oneOf` / `anyOf` / `allOf` anywhere: the Claude API rejects root-level
 *     combinators and nested ones are needless bytes. An xor-style constraint is
 *     enforced in the handler and answered with guidance instead.
 *   - Flat scalars. The one array in the whole surface is `files` on blast
 *     radius.
 *   - NOTHING is `required`, on any tool. MEASURED (2026-08-17): `fromJsonSchema`
 *     installs a default validator even when the `validator` arg is omitted, and
 *     a `required` miss is rejected by the SDK with a terse
 *     `Input validation error: … data must have required property 'repo'` — the
 *     handler is NEVER invoked, so our guidance builder cannot run. Keeping every
 *     field optional is what makes принцип 4 ("помилка веде далі") reachable: a
 *     missing `repo` reaches the handler and comes back as "Which repository?
 *     Pass repo as owner/repo. Imported: …".
 *   - `type` keywords ARE kept. They tell the model what to send, and a
 *     type-mismatch is the rarer slip; that one case still falls to the SDK's
 *     message, which names the offending field and is self-correcting. This is a
 *     deliberate split: our guidance owns "you forgot something", the SDK owns
 *     "you sent the wrong shape". `identifiers.ts` still coerces defensively,
 *     because the tool input types are `unknown`.
 *   - A per-property `description` only where a model cannot guess the format.
 *     Everything else is carried by the tool description in `server.ts`.
 *   - There is no `response_format` property. It was removed from the whole
 *     design (принцип 3); do not reintroduce it.
 */

import { fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import { FINDINGS_DEFAULT_LIMIT, TOOL, type ToolName } from './constants.js';

/**
 * Upper bound on `files` for blast radius. Sized to a large-but-real PR: past
 * this the answer is "review the PR", not a wider fan-out query.
 */
const BLAST_MAX_FILES = 50;

// ---------------------------------------------------------------------------
// Handler argument shapes.
//
// Every field is `unknown` on purpose. `fromJsonSchema` is called WITHOUT a
// validator (no AJV, no new dependency), so nothing checks these at runtime and
// `pr` legitimately arrives as the string `"412"`. Declaring `pr: number` would
// be a lie the compiler then enforces on the handler; `unknown` is what makes
// the `coerceInt` / `coerceString` pass in `identifiers.ts` unskippable.
// ---------------------------------------------------------------------------

export interface ListAgentsInput {
  enabled_only?: unknown;
}

export interface RunAgentOnPullRequestInput {
  repo?: unknown;
  pr?: unknown;
  agent?: unknown;
}

export interface GetFindingsInput {
  repo?: unknown;
  pr?: unknown;
  run_id?: unknown;
  min_severity?: unknown;
  limit?: unknown;
}

export interface GetConventionsInput {
  repo?: unknown;
  status?: unknown;
}

export interface GetBlastRadiusInput {
  repo?: unknown;
  files?: unknown;
}

// ---------------------------------------------------------------------------
// The literals. What you read here is exactly what ships in `tools/list`.
// ---------------------------------------------------------------------------

export const LIST_AGENTS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    enabled_only: { type: 'boolean' },
  },
  required: [],
  additionalProperties: false,
} as const satisfies JsonSchemaType;

export const RUN_AGENT_ON_PULL_REQUEST_JSON_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Repository as "owner/repo"' },
    pr: { type: 'integer', description: 'Pull request number' },
    agent: { type: 'string', description: 'Reviewer name; omit to see the available ones' },
  },
  required: [],
  additionalProperties: false,
} as const satisfies JsonSchemaType;

export const GET_FINDINGS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Repository as "owner/repo"' },
    pr: { type: 'integer', description: 'Pull request number' },
    run_id: { type: 'string' },
    min_severity: { type: 'string', enum: ['CRITICAL', 'WARNING', 'SUGGESTION'] },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: FINDINGS_DEFAULT_LIMIT },
  },
  required: [],
  additionalProperties: false,
} as const satisfies JsonSchemaType;

export const GET_CONVENTIONS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Repository as "owner/repo"' },
    status: {
      type: 'string',
      enum: ['accepted', 'pending', 'rejected', 'all'],
      default: 'accepted',
    },
  },
  required: [],
  additionalProperties: false,
} as const satisfies JsonSchemaType;

export const GET_BLAST_RADIUS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Repository as "owner/repo"' },
    files: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: BLAST_MAX_FILES,
      description: 'Repository-relative paths of changed files',
    },
  },
  required: [],
  additionalProperties: false,
} as const satisfies JsonSchemaType;

/**
 * The literals keyed by tool name, so the budget test can walk the whole
 * surface in `TOOL_ORDER` and serialize exactly what `tools/list` will carry.
 * Costs nothing on the wire.
 */
export const TOOL_INPUT_JSON_SCHEMAS: Record<ToolName, JsonSchemaType> = {
  [TOOL.listAgents]: LIST_AGENTS_JSON_SCHEMA,
  [TOOL.runAgentOnPullRequest]: RUN_AGENT_ON_PULL_REQUEST_JSON_SCHEMA,
  [TOOL.getFindings]: GET_FINDINGS_JSON_SCHEMA,
  [TOOL.getConventions]: GET_CONVENTIONS_JSON_SCHEMA,
  [TOOL.getBlastRadius]: GET_BLAST_RADIUS_JSON_SCHEMA,
};

// ---------------------------------------------------------------------------
// Wrapped for registration. `fromJsonSchema`'s `validator` argument is
// deliberately omitted — the handlers coerce and answer a miss with guidance,
// which a validator would pre-empt with a protocol error.
// ---------------------------------------------------------------------------

export const listAgentsInputSchema = fromJsonSchema<ListAgentsInput>(LIST_AGENTS_JSON_SCHEMA);

export const runAgentOnPullRequestInputSchema = fromJsonSchema<RunAgentOnPullRequestInput>(
  RUN_AGENT_ON_PULL_REQUEST_JSON_SCHEMA,
);

export const getFindingsInputSchema = fromJsonSchema<GetFindingsInput>(GET_FINDINGS_JSON_SCHEMA);

export const getConventionsInputSchema =
  fromJsonSchema<GetConventionsInput>(GET_CONVENTIONS_JSON_SCHEMA);

export const getBlastRadiusInputSchema = fromJsonSchema<GetBlastRadiusInput>(
  GET_BLAST_RADIUS_JSON_SCHEMA,
);
