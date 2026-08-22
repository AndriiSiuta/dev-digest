/**
 * mcp — the `RunBus` ⇄ MCP-progress bridge behind the one blocking tool.
 *
 * `run_agent_on_pull_request` starts a review and does not return until it
 * finishes (принцип 1: результат, а не операція). That turns two in-memory
 * signals — the run event bus and the MCP request context — into one `await`,
 * and everything subtle about the tool lives here rather than in the handler.
 *
 * No Fastify types, no Drizzle types, no `container`: the whole file is drivable
 * from a plain object. `McpRunBus` (`types.ts`) exists precisely for that —
 * `RunBus` is a class with five `private` fields and TypeScript compares private
 * members NOMINALLY, so importing the class would make a fake bus impossible
 * (`INSIGHTS.md`, 2026-08-17).
 *
 * THE RACES, AND WHY THERE AREN'T ANY
 *
 *   - Subscribing after `runReview` returned the run id is race-free BY
 *     CONSTRUCTION, not by luck: `RunBus.subscribe` replays the buffered events
 *     SYNCHRONOUSLY before attaching the listener, and `onDone` fires via
 *     `queueMicrotask` when the run is already complete
 *     (`platform/sse.ts:63-68, 90-100`). A run that finished in the gap still
 *     resolves.
 *   - There is no read-after-write race either: `runBus.complete(runId)` is
 *     called AFTER `insertReview` → `insertFindings` → `markReviewed` →
 *     `completeAgentRun` → `saveRunTrace` on every path that calls it
 *     (`modules/reviews/run-executor.ts:97, 355, 379` — verified). "Wait for
 *     done, then read the DB" is safe.
 *
 * THE HOLE, STATED PLAINLY — do not try to fix it here. `runBus.complete` is
 * guaranteed only on those three paths. If `executeRuns` rejects outside them,
 * `modules/reviews/service.ts:133` only logs: the `agent_runs` row stays
 * `running` (until the boot reaper) and `onDone` NEVER fires. `budgetMs` is the
 * sole protection against a permanent hang, which is why it is mandatory and why
 * `'timeout'` returns a usable handle to the caller instead of an error.
 */

import type { RunEvent } from '@devdigest/shared';
import type { ServerContext } from '@modelcontextprotocol/server';
import { CANCEL_ON_ABORT, PROGRESS_HEARTBEAT_MS, PROGRESS_THROTTLE_MS } from './constants.js';
import type { McpDeps } from './types.js';

/**
 * How the wait ended.
 *
 * `'done'` means the BUS completed — nothing more. The bus carries no status, so
 * `'failed'` and `'cancelled'` are resolved by the caller from the persisted
 * `agent_runs` row; they are members of this union so the tool handler and the
 * waiter share one vocabulary rather than two overlapping ones.
 *
 * Resolving them HERE was preferred and rejected on the evidence: `listRuns`
 * needs `workspaceId` + `prId`, which are not in this signature, and the handler
 * has to call `listRuns` anyway to build `{status, run_id, score, error}` via
 * `projectRun`. Mapping here would mean either a second identical DB read or
 * returning a `RunSummary` — dragging a DB-shaped type into the one file that
 * must stay fakeable. See the module README for the split.
 */
export type WaitOutcome = 'done' | 'failed' | 'cancelled' | 'timeout' | 'aborted';

/**
 * Block until the run ends or the budget expires, reporting progress as it goes.
 *
 * `budgetMs` is passed in rather than read from `constants.ts` because it
 * differs by call: `RUN_WAIT_BUDGET_MS` when the client sent a `progressToken`,
 * `RUN_WAIT_BUDGET_NO_TOKEN_MS` when it did not. Nothing here hard-codes either
 * — the caller owns that choice, so retuning a constant needs no change in this
 * file.
 */
export async function waitForRun(
  runId: string,
  deps: McpDeps,
  ctx: ServerContext,
  budgetMs: number,
): Promise<WaitOutcome> {
  const { signal } = ctx.mcpReq;
  /**
   * No token means NO NOTIFICATIONS AT ALL. `notifications/progress` without a
   * `progressToken` is protocol-invalid, and `notifications/message` is not a
   * substitute — it requires the client to have declared the `logging`
   * capability and is not specified to reset the idle timer.
   *
   * This costs the client nothing but visibility: MEASURED on a 90 s silent
   * call, the transport flushes response headers at +3 ms and emits its own
   * `: keepalive` SSE comment every 15 s with no handler involvement, so the
   * 60 s first-byte timer is never in play and the 5 min idle timer is fed
   * whether or not we notify. A token-less caller simply waits blind.
   */
  const progressToken = ctx.mcpReq._meta?.progressToken;
  const notifying = progressToken !== undefined;

  let settled = false;
  let settle!: (outcome: WaitOutcome) => void;
  const ended = new Promise<WaitOutcome>((resolve) => {
    settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
  });

  // --- progress pump -------------------------------------------------------
  // Coalescing state. `pending` holds at most ONE event: the newest one seen
  // since the last send. Older ones are dropped, never queued — the whole point
  // is that the synchronous replay burst collapses instead of firing dozens of
  // notifications back to back.
  let pending: RunEvent | undefined;
  let lastMessage: string | undefined;
  let lastSentAt = 0;
  let lastProgress = 0;

  const send = (message: string, seq?: number): void => {
    if (!notifying) return;
    /**
     * `e.seq` is monotonic per run (`platform/sse.ts:54-56`), which is what
     * satisfies the protocol's strictly-increasing-progress rule. A HEARTBEAT
     * has no seq of its own, so it takes `lastProgress + 1`; the `max` keeps the
     * sequence increasing afterwards even though it then runs slightly ahead of
     * the bus's seq. Reporting a number that never moves would be the actual
     * violation. `total` is omitted on purpose — it is genuinely unknown, and
     * indeterminate progress is legal.
     */
    lastProgress = Math.max(seq ?? 0, lastProgress + 1);
    lastMessage = message;
    lastSentAt = Date.now();
    // A dead client must not abort a paid-for review: a rejected notification is
    // swallowed, and `signal` is the only thing that ends the wait early.
    void ctx.mcpReq
      .notify({
        method: 'notifications/progress',
        params: { progressToken, progress: lastProgress, message },
      })
      .catch(() => undefined);
  };

  const flush = (): void => {
    const next = pending;
    pending = undefined;
    if (next) send(next.msg, next.seq);
  };

  const onEvent = (e: RunEvent): void => {
    if (!notifying) return;
    // `result` / `error` are the informative ones and bypass the throttle.
    // Dropping `pending` with them is not an optimisation: emitting a stale,
    // lower-seq event afterwards would break monotonic progress.
    if (e.kind === 'result' || e.kind === 'error') {
      pending = undefined;
      send(e.msg, e.seq);
      return;
    }
    // Leading edge: the first event goes out immediately (`lastSentAt` is 0)
    // rather than a tick late, and the rest of the burst coalesces behind it.
    if (Date.now() - lastSentAt >= PROGRESS_THROTTLE_MS) {
      send(e.msg, e.seq);
      return;
    }
    pending = e;
  };

  const pump = notifying ? setInterval(flush, PROGRESS_THROTTLE_MS) : undefined;

  /**
   * Re-send the last message when the run has gone quiet.
   *
   * NOT a keep-alive, despite the name — the transport already emits its own
   * `: keepalive` SSE comment every 15 s, measured, unprompted, and independent
   * of anything this handler does, which feeds both client timers on its own.
   * What that keepalive does NOT do is change what the user sees: without this,
   * a run that goes quiet for four minutes leaves the client displaying a
   * progress line from four minutes ago, which reads as stalled.
   *
   * So this is a UI-freshness measure and nothing more. It is ~6 lines and one
   * interval; drop it if that trade stops being worth it — nothing else in the
   * file depends on it.
   */
  const heartbeat = notifying
    ? setInterval(() => {
        if (Date.now() - lastSentAt < PROGRESS_HEARTBEAT_MS) return;
        send(lastMessage ?? `Review ${runId} is still running…`);
      }, PROGRESS_HEARTBEAT_MS)
    : undefined;

  // --- subscription, budget, abort ----------------------------------------
  // Same shape as the SSE consumer at `modules/reviews/routes.ts:56-90`:
  // subscribe first (replays synchronously), then `onDone`.
  const unsubscribe = deps.runBus.subscribe(runId, onEvent);
  const offDone = deps.runBus.onDone(runId, () => settle('done'));

  const budgetTimer = setTimeout(() => settle('timeout'), budgetMs);

  /**
   * THE ABORT PATH IS CURRENTLY INERT, AND THAT IS MEASURED, NOT ASSUMED.
   *
   * With the stateless wiring this module uses — a fresh `McpServer` +
   * `NodeStreamableHTTPServerTransport({sessionIdGenerator: undefined})` per
   * POST — `signal` never fires. Both directions were tested:
   *
   *   - Bare socket close (client `socket.destroy()`): no `abort` event,
   *     `signal.aborted` still `false`, the handler ran its full 90 s. Only
   *     `reply.raw`'s `close` fired.
   *   - An explicit `notifications/cancelled` for the same request id, POSTed
   *     on a second connection: answered `202 Accepted`, still no abort — the
   *     cancel lands on a fresh `McpServer` that never saw the request.
   *   - Positive control: hoist `McpServer` + transport to module scope (one
   *     shared instance) and the identical cancel aborts in ~4 ms. The SDK is
   *     fine; the per-request wiring is what makes the signal unreachable.
   *
   * Making MCP-initiated cancellation real needs a shared transport and owned
   * session state — a routes-level design change, out of scope here. The wiring
   * below is kept because it is free, correct (exercised directly with an
   * `AbortController`), and starts working the day that change lands. Until
   * then `budgetMs` is the only thing that ends a wait early. Do not read this
   * code as "cancellation works".
   */
  const onAbort = (): void => settle('aborted');
  signal.addEventListener('abort', onAbort);
  if (signal.aborted) settle('aborted');

  try {
    const outcome = await ended;

    if (outcome === 'aborted' && CANCEL_ON_ABORT) {
      /**
       * Unreachable today for the reason documented on `onAbort` above — the
       * flag is still correct, it just has no occasion to fire.
       *
       * `reviewRunner.cancelRun`, NEVER `runBus.cancel`. The raw bus call only
       * sets a flag: it leaves the `agent_runs` row `running` forever (only the
       * boot reaper clears it) and never completes the bus, stranding every
       * other subscriber. `ReviewService.cancelRun` signals, marks the row and
       * completes the bus (`modules/reviews/service.ts:85-90`), and
       * `cancelRunIfRunning` is a harmless no-op on an already-finished run.
       */
      await deps.reviewRunner.cancelRun(runId).catch(() => undefined);
    }

    return outcome;
  } finally {
    // Non-negotiable. `runBus` is a module singleton, so a leaked listener
    // outlives the request and accumulates across calls; a leaked interval keeps
    // notifying against a context that is gone.
    unsubscribe();
    offDone();
    clearInterval(pump);
    clearInterval(heartbeat);
    clearTimeout(budgetTimer);
    signal.removeEventListener('abort', onAbort);
  }
}
