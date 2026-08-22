/**
 * mcp — the startup-cost budget. Pure: no DB, no Fastify, no transport.
 *
 * This file is the ONLY mechanical defence against token-budget drift. The whole
 * design's justification is that the MCP server costs almost nothing at session
 * start: a client that defers tool definitions still loads `instructions`, and a
 * client that does not (`ENABLE_TOOL_SEARCH=false`, a non-first-party
 * `ANTHROPIC_BASE_URL`, Cursor, Windsurf, Zed) loads the entire `tools/list`
 * payload into every new conversation whether the tools get used or not. Code
 * review does not catch a description that grows 200 bytes at a time over six
 * months; this does, and it names the number when it fails.
 *
 * Two rules the assertions here hold to:
 *
 *   - BYTES, never `String.length`. Truncation is on bytes, and while every
 *     description is ASCII today, `INSTRUCTIONS` is prose that may not stay that
 *     way — one em dash or one Cyrillic word and the two measures diverge.
 *   - Ceilings and structure ONLY. No assertion on exact wording and no assertion
 *     on an exact byte count: that would turn every copy edit into a red build
 *     without catching a single regression class we care about. The named
 *     constants in `constants.ts` are the contract, so raising a ceiling is a
 *     deliberate, reviewable act rather than a silent one.
 *
 * Measured at the time of writing (informational, deliberately NOT asserted):
 * tools/list 4089 B of 5120 · descriptions 291/772/494/455/407 B of 2048 each ·
 * instructions 1103 B of 2048. ~1 KB of headroom — a sixth tool fits once.
 */
import { describe, it, expect } from 'vitest';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import {
  DESCRIPTION_BYTE_CEILING,
  INSTRUCTIONS_BYTE_CEILING,
  TOOLS_LIST_BYTE_CEILING,
  TOOL_ORDER,
  type ToolName,
} from '../src/modules/mcp/constants.js';
import { TOOL_INPUT_JSON_SCHEMAS } from '../src/modules/mcp/schemas.js';
import { INSTRUCTIONS, TOOL_DESCRIPTIONS } from '../src/modules/mcp/server.js';

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

/** Bytes on the wire. `String.length` counts UTF-16 units and would under-read. */
function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function jsonBytes(value: unknown): number {
  return bytes(JSON.stringify(value));
}

/** One entry of a `tools/list` result, as the transport serializes it. */
interface ListedTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaType;
}

/**
 * The `tools/list` result, assembled from the same three sources registration
 * walks (`TOOL_ORDER` × `TOOL_DESCRIPTIONS` × `TOOL_INPUT_JSON_SCHEMAS`) — the
 * reason `server.ts` exports the descriptions and `schemas.ts` exports the
 * literals map at all.
 *
 * Known and accepted imprecision: the real result also carries
 * `_meta: {"anthropic/maxResultSizeChars": …}` on the two findings-returning
 * tools (~96 B total), and which tools get it lives in a non-exported
 * `REGISTRARS` map. So this measurement runs ~96 B optimistic against the
 * ceiling. It is not worth exporting the registrar map to close: the ceiling has
 * ~1 KB of headroom, and the only faithful measurement is a real `tools/list`
 * round-trip, which belongs in the HTTP-path test that does not exist yet.
 */
function toolsListResult(): { tools: ListedTool[] } {
  return {
    tools: TOOL_ORDER.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: TOOL_INPUT_JSON_SCHEMAS[name],
    })),
  };
}

/**
 * Every path at which one of `keys` appears as an object key, anywhere in the
 * tree. Walks `unknown` rather than a JSON Schema type on purpose: the point is
 * to find a key nobody declared, so narrowing to the declared shape first would
 * defeat it.
 */
function findKeyPaths(node: unknown, keys: readonly string[], path = '$'): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => findKeyPaths(child, keys, `${path}[${i}]`));
  }
  if (typeof node !== 'object' || node === null) return [];

  const hits: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const here = `${path}.${key}`;
    if (keys.includes(key)) hits.push(here);
    hits.push(...findKeyPaths(value, keys, here));
  }
  return hits;
}

/** `JsonSchemaType` is a wide interface; read it as a bag for key-set checks. */
function keysOf(schema: JsonSchemaType): string[] {
  return Object.keys(schema as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Byte ceilings — the reason this file exists
// ---------------------------------------------------------------------------

describe('INSTRUCTIONS byte budget', () => {
  it('fits under INSTRUCTIONS_BYTE_CEILING', () => {
    const measured = bytes(INSTRUCTIONS);

    // Loaded at the start of every session that connects, and in a client that
    // defers tool definitions it is loaded INSTEAD of them — so it is the one
    // string paid for unconditionally.
    expect(
      measured,
      `INSTRUCTIONS is ${measured} B against INSTRUCTIONS_BYTE_CEILING ${INSTRUCTIONS_BYTE_CEILING} B ` +
        `(over by ${measured - INSTRUCTIONS_BYTE_CEILING} B). Cut prose or raise the constant deliberately.`,
    ).toBeLessThanOrEqual(INSTRUCTIONS_BYTE_CEILING);
  });

  it('is actually populated — an empty string would pass every ceiling', () => {
    expect(bytes(INSTRUCTIONS)).toBeGreaterThan(0);
  });
});

describe('tool description byte budget', () => {
  // One `it` per tool so a failure names the offending tool in the test title as
  // well as the byte count in the message.
  for (const name of TOOL_ORDER) {
    it(`${name} fits under DESCRIPTION_BYTE_CEILING`, () => {
      const measured = bytes(TOOL_DESCRIPTIONS[name]);

      expect(
        measured,
        `${name} description is ${measured} B against DESCRIPTION_BYTE_CEILING ${DESCRIPTION_BYTE_CEILING} B ` +
          `(over by ${measured - DESCRIPTION_BYTE_CEILING} B). The client truncates at this ceiling — ` +
          `a description over it loses its tail silently.`,
      ).toBeLessThanOrEqual(DESCRIPTION_BYTE_CEILING);

      expect(measured, `${name} has no description`).toBeGreaterThan(0);
    });
  }

  it('reports every over-ceiling description at once, not just the first', () => {
    // The per-tool cases above fail one at a time; this one shows the whole
    // picture in a single failure so a broad copy edit is diagnosed in one run.
    const over = TOOL_ORDER.map((name) => ({ name, bytes: bytes(TOOL_DESCRIPTIONS[name]) })).filter(
      (row) => row.bytes > DESCRIPTION_BYTE_CEILING,
    );

    expect(over, `ceiling is ${DESCRIPTION_BYTE_CEILING} B per description`).toEqual([]);
  });
});

describe('tools/list payload byte budget', () => {
  it('the whole serialized payload fits under TOOLS_LIST_BYTE_CEILING', () => {
    const result = toolsListResult();
    const measured = jsonBytes(result);

    // Asserted against the NAMED constant, never a literal number: raising the
    // budget must show up as a one-line change in `constants.ts` that a reviewer
    // sees, not as an edited number buried in a test.
    const breakdown = result.tools
      .map((tool) => `${tool.name} ${jsonBytes(tool)} B (desc ${bytes(tool.description)} B)`)
      .join('\n  ');

    expect(
      measured,
      `tools/list is ${measured} B against TOOLS_LIST_BYTE_CEILING ${TOOLS_LIST_BYTE_CEILING} B ` +
        `(over by ${measured - TOOLS_LIST_BYTE_CEILING} B). Per tool:\n  ${breakdown}`,
    ).toBeLessThanOrEqual(TOOLS_LIST_BYTE_CEILING);
  });

  it('every tool contributes a non-trivial, measurable share', () => {
    // Guards the measurement itself: if a tool serialized to almost nothing the
    // budget above would be measuring the wrong object.
    for (const tool of toolsListResult().tools) {
      expect(jsonBytes(tool), `${tool.name} serialized to nothing`).toBeGreaterThan(50);
    }
  });
});

// ---------------------------------------------------------------------------
// Payload hygiene — what must never appear on the wire
// ---------------------------------------------------------------------------

describe('tools/list payload hygiene', () => {
  const BANNED_KEYS = [
    // Injected by every schema generator (`z.toJSONSchema()` included) and pure
    // cost — the hand-authored literals exist so nothing injects it.
    '$schema',
    // Removed from the whole design by принцип 3 ("стисла структурована
    // відповідь"): one lean shape per tool, no output-mode toggle.
    'response_format',
    // Would cost bytes in every list AND send the payload twice to a
    // structured-output client.
    'outputSchema',
  ] as const;

  it('carries no $schema, response_format or outputSchema anywhere', () => {
    // NOTE on strength: this file builds the payload from the same three sources
    // registration reads, so this catches a banned key appearing in a schema
    // literal or in `TOOL_INPUT_JSON_SCHEMAS` — the realistic regression, e.g.
    // someone replacing a literal with generated JSON Schema. It does NOT catch
    // an `outputSchema` handed straight to `server.registerTool`; only a real
    // `tools/list` round-trip would, and that test does not exist yet.
    expect(findKeyPaths(toolsListResult(), BANNED_KEYS)).toEqual([]);
  });

  for (const name of TOOL_ORDER) {
    it(`${name} input schema has no root title or description`, () => {
      // Root-level annotations are paid for in every session and tell the model
      // nothing the tool description does not already say.
      const keys = keysOf(TOOL_INPUT_JSON_SCHEMAS[name]);
      expect(keys).not.toContain('title');
      expect(keys).not.toContain('description');
    });
  }

  it('still allows a PER-PROPERTY description, which is where format hints belong', () => {
    // Asserted positively so the rule above is not mistaken for "no descriptions
    // at all" and quietly over-applied by the next editor: `repo` must keep
    // telling the model it wants "owner/repo".
    const perProperty = TOOL_ORDER.flatMap((name) =>
      findKeyPaths(TOOL_INPUT_JSON_SCHEMAS[name], ['description']),
    );
    expect(perProperty.length).toBeGreaterThan(0);
    expect(perProperty.every((path) => path.includes('.properties.'))).toBe(true);
  });

  it('uses no oneOf / anyOf / allOf, at any depth', () => {
    // The Claude API rejects a root-level combinator outright, and a nested one
    // is needless bytes: an xor-style constraint is enforced in the handler and
    // answered with guidance instead (принцип 4).
    expect(findKeyPaths(toolsListResult(), ['oneOf', 'anyOf', 'allOf'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Structural invariants — parity between the three sources of a tool
// ---------------------------------------------------------------------------

describe('TOOL_ORDER', () => {
  it('holds exactly five distinct, devdigest_-prefixed names', () => {
    expect(TOOL_ORDER).toHaveLength(5);
    expect(new Set(TOOL_ORDER).size).toBe(TOOL_ORDER.length);

    // The prefix is what keeps these from colliding with another server's tools
    // in a client that flattens the namespace.
    for (const name of TOOL_ORDER) expect(name.startsWith('devdigest_')).toBe(true);
  });

  it('matches the key sets of TOOL_DESCRIPTIONS and TOOL_INPUT_JSON_SCHEMAS exactly', () => {
    // Set equality in both directions, so no tool can gain a schema without a
    // description or a description without a schema — and so a tool dropped from
    // `TOOL_ORDER` (and therefore never registered) fails here rather than going
    // quietly missing from the wire.
    const ordered = [...TOOL_ORDER].sort();
    expect(Object.keys(TOOL_DESCRIPTIONS).sort()).toEqual(ordered);
    expect(Object.keys(TOOL_INPUT_JSON_SCHEMAS).sort()).toEqual(ordered);
  });
});

describe('input schema shape', () => {
  for (const name of TOOL_ORDER) {
    const schema = TOOL_INPUT_JSON_SCHEMAS[name as ToolName];

    it(`${name} is a closed object`, () => {
      expect(schema.type).toBe('object');
      // Closed on purpose: an unexpected key is a model mistake worth surfacing.
      expect(schema.additionalProperties).toBe(false);
    });

    it(`${name} requires nothing — this is load-bearing, not cosmetic`, () => {
      // MEASURED: `fromJsonSchema` installs a default validator even with the
      // `validator` argument omitted, so ONE entry in `required` makes the SDK
      // reject the call with its own terse `Input validation error: … data must
      // have required property 'repo'` BEFORE our handler runs. That silently
      // breaks принцип 4 ("помилка веде далі"): the guidance builder that would
      // answer a missing `repo` with the list of imported repositories never
      // gets a chance to run. Keeping `required` empty is what makes every miss
      // answerable in our own words.
      expect(schema.required).toEqual([]);
    });

    it(`${name} stays flat and small`, () => {
      const properties = Object.keys(schema.properties ?? {});
      expect(properties.length).toBeLessThanOrEqual(8);
      expect(properties.length).toBeGreaterThan(0);
    });
  }
});
