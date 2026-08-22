/**
 * mcp — argument normalization. Pure, and NOTHING HERE THROWS: an MCP tool must
 * answer an ordinary miss with guidance, so every function returns a value the
 * caller can branch on (`{ error }` or `undefined`).
 *
 * There is deliberately no `owner/repo#412` parser: the surface takes flat
 * scalars (`repo`, `pr`, `agent`), which deletes that whole parsing failure mode
 * (принцип 2, `specs/01-mcp-server.md`).
 *
 * The coercions are mandatory rather than defensive: tool arguments arrive as
 * whatever the model emitted and there is no runtime validator behind the
 * hand-authored JSON Schemas, so `pr` legitimately shows up as the string
 * `"412"`.
 */

import type { AgentRow } from '../../db/rows.js';

/** GitHub logins and repo names: alphanumerics, `-`, `_`, `.` (repos only, but
 *  a login can never contain `.`, which is what makes the host check below work). */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Normalize whatever the model sent into `owner/repo`.
 *
 * Accepts the canonical `owner/repo`, and tolerates the two forms an agent is
 * most likely to paste out of a terminal or a browser:
 *   - `https://github.com/owner/repo`, with any trailing path (`/pull/412`)
 *   - `git@github.com:owner/repo.git`
 *
 * Everything after the first two segments is dropped. No network lookup, no
 * validation that the repo is imported — that is the caller's next step.
 */
export function normalizeRepoRef(input: unknown): { fullName: string } | { error: string } {
  const raw = coerceString(input);
  if (raw === undefined) {
    return { error: 'repo is required, as "owner/repo" (e.g. "vercel/next.js")' };
  }

  let s = raw;
  // scp-style git remote: git@github.com:owner/repo.git
  s = s.replace(/^[^@/\s]+@([^:/\s]+):/, '');
  // Any URL scheme: https://, http://, ssh://, git://
  s = s.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
  // Strip credentials left in a URL, a trailing `.git`, and trailing slashes.
  s = s.replace(/^[^@/\s]+@/, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\.git$/, '');

  const parts = s.split('/').filter((p) => p.length > 0);
  // A leading host segment (`github.com`, `localhost:3000`) — a GitHub login can
  // contain neither `.` nor `:`, so this never eats a real owner.
  const first = parts[0];
  if (parts.length > 2 && first !== undefined && (first.includes('.') || first.includes(':'))) {
    parts.shift();
  }

  const [owner, repo] = parts;
  if (!owner || !repo || !SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    return { error: `"${raw}" is not a repository reference — use "owner/repo"` };
  }
  return { fullName: `${owner}/${repo}` };
}

/**
 * Find an agent by the name the model used. Three passes, most exact first:
 * identical, then whitespace-trimmed, then case-insensitive.
 *
 * NO fuzzy matching, on purpose: a near-miss that silently starts the wrong
 * reviewer spends money on the wrong prompt. A miss returns `undefined` and the
 * caller answers with `agentNotFound(...)`, which lists every real name inline.
 */
export function matchAgentByName(name: unknown, agents: AgentRow[]): AgentRow | undefined {
  const wanted = coerceString(name);
  if (wanted === undefined) return undefined;

  const exact = agents.find((a) => a.name === wanted);
  if (exact) return exact;

  const trimmed = agents.find((a) => a.name.trim() === wanted);
  if (trimmed) return trimmed;

  const lower = wanted.toLowerCase();
  return agents.find((a) => a.name.trim().toLowerCase() === lower);
}

/**
 * An integer argument (`pr`, `limit`). Accepts a number or a numeric string;
 * returns `undefined` for anything else, including `12.5`, `"12abc"`, `NaN` and
 * values outside the safe-integer range.
 */
export function coerceInt(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!/^[+-]?\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * A string argument (`repo`, `agent`, `min_severity`, `status`). Trimmed; an
 * empty or whitespace-only value is a miss, not an empty string. Numbers and
 * booleans are stringified rather than rejected — an agent name of `"2024"` is
 * legal and arrives unquoted often enough to be worth tolerating.
 */
export function coerceString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length > 0 ? s : undefined;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === 'boolean') return String(v);
  return undefined;
}
