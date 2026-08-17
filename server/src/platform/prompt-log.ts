import { createHash } from 'node:crypto';
import type { PromptAssembly } from '@devdigest/shared';

/**
 * Safe structured logging of prompt assembly.
 *
 * Everything a run logs about its prompt goes through here, and the safety
 * property is STRUCTURAL rather than disciplinary: the returned types have no
 * field that can hold section content, so a leak is unrepresentable rather than
 * merely discouraged. Section TEXT is read to derive a length, a token count and
 * a fingerprint, and is never stored, returned or re-emitted.
 *
 * This matters because a run's log is not just stdout: RunLogger publishes every
 * line to the SSE Live Log AND buffers it into the persisted `run_traces.log`
 * document. A diff, a PR body or a spec chunk logged here would be streamed to
 * every viewer and stored in the database.
 *
 * What may appear in a line: section names, provenance labels, character counts,
 * token counts, fingerprints and ids. Never: secrets, diff text, PR/issue/spec
 * bodies, prompt section text, or model output.
 *
 * Pure by construction — the tokenizer arrives as an injected `count` function,
 * so this module reaches neither the container nor process.env.
 */

/** One prompt section, described by size and provenance only. */
export type PromptSectionLog = {
  /**
   * Section name. For a review prompt: 'system' | 'intent' | 'skills' |
   * 'memory' | 'specs' | 'callers' | 'repo_map' | 'pr_description' | 'diff' |
   * 'user_total'. Other producers (the intent classifier) use their own slots.
   */
  section: string;
  /** Where the section's content came from — see SECTION_SOURCE. */
  source: string;
  chars: number;
  /** Verbose only: estimated tokens, via the injected counter. */
  tokens?: number;
  /**
   * Verbose only: first 12 hex of the section's sha256. Enough to tell whether a
   * section changed between two runs; not enough to recover anything from it.
   */
  sha?: string;
};

/** One `prompt assembled` log line. */
export type PromptLogSummary = {
  /** Joins this line to the rest of the operation: a runId, or a request id. */
  correlation_id: string;
  model: string;
  provider?: string;
  sections: PromptSectionLog[];
  /** Wire size of the prompt — nested sections are counted once, not twice. */
  total_chars: number;
  /** Verbose only. Same nesting rule as total_chars. */
  total_tokens?: number;
};

/**
 * A section as its producer knows it, before description.
 *
 * Exactly one of `text` / `chars` is given: `text` when the caller may hand the
 * content over (it is read, never retained), `chars` when it may not — the diff
 * is passed by LENGTH so this module never handles diff text at all.
 */
export type PromptSectionInput = {
  section: string;
  source: string;
  /** Section content. Null/undefined means "section absent" → no row is emitted. */
  text?: string | null;
  /** Length of a section whose text must not travel here. */
  chars?: number;
  /**
   * True when these chars are already counted inside another row (every review
   * section lives inside `user_total`). Such rows are excluded from the totals so
   * `total_chars` stays the prompt's real size instead of a double count.
   */
  nested?: boolean;
};

export type DescribeOptions = {
  correlationId: string;
  model: string;
  provider?: string;
  /** Adds `tokens` + `sha` per section and `total_tokens`. Local-only — see AppConfig. */
  verbose: boolean;
  /** Token estimator (container.tokenizer.count). Omit and no tokens are reported. */
  count?: (s: string) => number;
};

/** Provenance per review-prompt section — which subsystem produced the content. */
const SECTION_SOURCE = {
  system: 'agent-config',
  intent: 'intent-classifier',
  skills: 'skills-module',
  memory: 'memory-rag',
  specs: 'project-context',
  callers: 'repo-intel',
  repo_map: 'repo-intel',
  pr_description: 'github-pr',
  diff: 'git-diff',
  user_total: 'assembled',
} as const;

/** Provenance per intent-classification slot. */
const INTENT_SECTION_SOURCE = {
  system: 'classifier-prompt',
  title: 'github-pr',
  description: 'github-pr',
  issues: 'github-issue',
  docs: 'repo-doc',
  file_list: 'pr-files',
} as const;

/** First 12 hex of the sha256 — a change detector, not a reversible reference. */
function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Describe an arbitrary set of sections. The one place that turns content into
 * numbers, shared by every producer so all prompt lines have the same shape and
 * join on `correlation_id`.
 */
export function describeSections(
  inputs: PromptSectionInput[],
  opts: DescribeOptions,
): PromptLogSummary {
  const sections: PromptSectionLog[] = [];
  let totalChars = 0;
  let totalTokens = 0;

  for (const input of inputs) {
    // Absent (null/undefined) sections produce no row at all — a prompt without
    // skills should read as "no skills section", not as "skills: 0 chars".
    const hasText = input.text !== null && input.text !== undefined;
    if (!hasText && input.chars === undefined) continue;

    const text = hasText ? (input.text as string) : undefined;
    const chars = text !== undefined ? text.length : (input.chars as number);
    const row: PromptSectionLog = { section: input.section, source: input.source, chars };

    // Tokens and fingerprints need the text, so a chars-only section (the diff)
    // reports neither even in verbose mode.
    if (opts.verbose && text !== undefined) {
      if (opts.count) row.tokens = opts.count(text);
      row.sha = fingerprint(text);
    }

    sections.push(row);
    if (!input.nested) {
      totalChars += chars;
      totalTokens += row.tokens ?? 0;
    }
  }

  return {
    correlation_id: opts.correlationId,
    model: opts.model,
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    sections,
    total_chars: totalChars,
    ...(opts.verbose && opts.count ? { total_tokens: totalTokens } : {}),
  };
}

/**
 * Describe an assembled review prompt.
 *
 * `PromptAssembly` carries no diff field — the diff is embedded inside `user` by
 * `assemblePrompt` — so the caller passes `diffChars` (it has the diff in
 * scope). The diff TEXT is deliberately not a parameter.
 *
 * Only `system` and `user_total` count toward the totals; every other section is
 * a slice of `user`.
 */
export function describeAssembly(
  assembly: PromptAssembly,
  opts: DescribeOptions & { diffChars?: number },
): PromptLogSummary {
  const { diffChars, ...describeOpts } = opts;
  return describeSections(
    [
      { section: 'system', source: SECTION_SOURCE.system, text: assembly.system },
      { section: 'intent', source: SECTION_SOURCE.intent, text: assembly.intent, nested: true },
      { section: 'skills', source: SECTION_SOURCE.skills, text: assembly.skills, nested: true },
      { section: 'memory', source: SECTION_SOURCE.memory, text: assembly.memory, nested: true },
      { section: 'specs', source: SECTION_SOURCE.specs, text: assembly.specs, nested: true },
      { section: 'callers', source: SECTION_SOURCE.callers, text: assembly.callers, nested: true },
      { section: 'repo_map', source: SECTION_SOURCE.repo_map, text: assembly.repo_map, nested: true },
      {
        section: 'pr_description',
        source: SECTION_SOURCE.pr_description,
        text: assembly.pr_description,
        nested: true,
      },
      { section: 'diff', source: SECTION_SOURCE.diff, chars: diffChars, nested: true },
      { section: 'user_total', source: SECTION_SOURCE.user_total, text: assembly.user },
    ],
    describeOpts,
  );
}

/** The intent classifier's slots, in prompt order. Each is independent (not nested). */
export type IntentPromptSizes = {
  system: string;
  title: string;
  description: string;
  /** Fetched linked-issue bodies; described as one `issues` row. */
  issues: string[];
  /** Referenced doc contents; described as one `docs` row. */
  docs: string[];
  fileList: string;
};

/**
 * Describe the intent classifier's prompt with the same `sections[]` shape as a
 * review prompt, so both lines are joinable by `correlation_id` and readable by
 * the same eye. Multi-item slots (issues, docs) collapse to one row each.
 */
export function describeIntentPrompt(
  parts: IntentPromptSizes,
  opts: DescribeOptions,
): PromptLogSummary {
  return describeSections(
    [
      { section: 'system', source: INTENT_SECTION_SOURCE.system, text: parts.system },
      { section: 'title', source: INTENT_SECTION_SOURCE.title, text: parts.title },
      { section: 'description', source: INTENT_SECTION_SOURCE.description, text: parts.description },
      { section: 'issues', source: INTENT_SECTION_SOURCE.issues, text: parts.issues.join('\n') },
      { section: 'docs', source: INTENT_SECTION_SOURCE.docs, text: parts.docs.join('\n') },
      { section: 'file_list', source: INTENT_SECTION_SOURCE.file_list, text: parts.fileList },
    ],
    opts,
  );
}
