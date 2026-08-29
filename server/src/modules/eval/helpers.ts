import type {
  CompletionRequest,
  EvalCase,
  LLMProvider,
  StructuredRequest,
  UnifiedDiff,
} from '@devdigest/shared';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';
import type { evalCases } from '../../db/schema.js';

/**
 * Pure helpers for the eval service (side-effect free; operate purely on their
 * arguments — no DB / network / `this`).
 */

/**
 * Wrap the frozen `pr_files.patch` fragment into a parseable one-file unified
 * diff. The three header lines are the exact recipe `diffFromPrFiles` uses
 * (`modules/reviews/diff-loader.ts`), so the same fragment produces the same
 * `UnifiedDiff` — and therefore the same prompt bytes — on every run (AC-04),
 * and the grounding gate gets a real new-side line index to check citations
 * against.
 */
export function caseDiff(file: string, patch: string): UnifiedDiff {
  const raw = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, patch].join(
    '\n',
  );
  return parseUnifiedDiff(raw);
}

/**
 * Render one linked skill as a block of the prompt's `## Skills / rules`
 * section. Deliberately DUPLICATES `modules/reviews/helpers.ts` — importing a
 * sibling module's `helpers.ts` is banned (`no-cross-module-internals`), and a
 * pure row→prompt mapper two modules both need is duplicated on purpose
 * (`server/INSIGHTS.md`, 2026-08-05).
 */
export function toSkillPromptBlock(skill: { name: string; body: string }): string {
  return `### ${skill.name}\n${skill.body.trim()}`;
}

/**
 * Decorate an `LLMProvider` so every call carries the eval pipeline's per-call
 * bounds. `ReviewInput` has no `maxTokens`/`timeoutMs` and widening the engine
 * API for one consumer was rejected (engine purity) — but `StructuredRequest`
 * carries both fields, so injecting them at the provider seam bounds the calls
 * without touching `reviewer-core` (AC-NF-05).
 */
export function withCallLimits(
  llm: LLMProvider,
  limits: { maxTokens: number; timeoutMs: number },
): LLMProvider {
  return {
    id: llm.id,
    listModels: () => llm.listModels(),
    complete: (req: CompletionRequest) =>
      llm.complete({ ...req, maxTokens: limits.maxTokens, timeoutMs: limits.timeoutMs }),
    completeStructured: <T>(req: StructuredRequest<T>) =>
      llm.completeStructured({ ...req, maxTokens: limits.maxTokens, timeoutMs: limits.timeoutMs }),
    embed: (texts: string[]) => llm.embed(texts),
  };
}

/**
 * Map over `items` with at most `limit` calls of `fn` in flight. Results keep
 * input order; the first rejection propagates (AC-NF-11 leans on that — a
 * failed persist aborts the batch rather than being swallowed).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

type EvalCaseRow = typeof evalCases.$inferSelect;

/** Drizzle rows stop at the module edge — map to the wire contract shape. */
export function toEvalCaseDto(row: EvalCaseRow): EvalCase {
  return {
    id: row.id,
    owner_kind: row.ownerKind,
    owner_id: row.ownerId,
    name: row.name,
    input_diff: row.inputDiff ?? '',
    input_files: row.inputFiles,
    input_meta: row.inputMeta,
    expected_output: row.expectedOutput,
    notes: row.notes ?? null,
  };
}
