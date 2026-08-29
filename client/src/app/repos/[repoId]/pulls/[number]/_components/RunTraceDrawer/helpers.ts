import type { LogLine } from "@devdigest/ui";
import type { RunTrace, SpecRead } from "@devdigest/shared";

interface RawEvent {
  t: string;
  kind: string;
  msg: string;
}

/** Map run-bus events to the LiveLogStream LogLine shape. */
export function eventsToLog(events: RawEvent[]): LogLine[] {
  return events.map((e) => ({ t: e.t, k: e.kind as LogLine["k"], m: e.msg }));
}

/** Map a persisted trace's log to the LiveLogStream LogLine shape. */
export function traceLog(trace: RunTrace | undefined): LogLine[] {
  return trace?.log.map((l) => ({ t: l.t, k: l.kind as LogLine["k"], m: l.msg })) ?? [];
}

/** Seconds-formatted duration. */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Token in→out summary (e.g. "12k→1.5k"). */
export function formatTokens(tokensIn: number, tokensOut: number): string {
  return `${(tokensIn / 1000).toFixed(0)}k→${(tokensOut / 1000).toFixed(1)}k`;
}

/**
 * Normalise `RunTrace.specs_read` to the current object shape.
 *
 * Two shapes arrive at runtime. New traces carry
 * `{ path, tokens, status }`; traces written before project context landed
 * carry a bare `string[]`, and the server reads a trace with a CAST, not a
 * parse (`modules/reviews/repository/run.repo.ts`), so those legacy rows reach
 * this component unvalidated. Rendering them straight would print
 * `[object Object]` in one direction and drop the token count in the other.
 */
export function normalizeSpecsRead(specsRead: RunTrace["specs_read"]): SpecRead[] {
  return (specsRead as unknown as Array<string | SpecRead>).map((entry) =>
    typeof entry === "string"
      ? // A legacy row records no size and no outcome: it only ever listed
        // paths, so "included with unknown size" is the honest reading.
        { path: entry, tokens: 0, status: "included" as const }
      : entry,
  );
}
