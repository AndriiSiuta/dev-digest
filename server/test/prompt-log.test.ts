/**
 * Prompt-assembly logging (`platform/prompt-log.ts`) — the safety property is
 * that the described shape has NO field able to hold section content, so a leak
 * is unrepresentable. The first test is the one that matters: it feeds sentinel
 * strings through every section and asserts none of them survives into the
 * serialized log line. Hermetic — no DB, no container, injected tokenizer.
 */
import { describe, it, expect } from 'vitest';
import type { PromptAssembly } from '@devdigest/shared';
import { describeAssembly, describeIntentPrompt } from '../src/platform/prompt-log.js';
import { loadConfig } from '../src/platform/config.js';

/** Distinctive per-section markers — none may appear in a log line. */
const SENTINELS = {
  system: 'SENTINEL_SYSTEM_PROMPT',
  intent: 'SENTINEL_DERIVED_INTENT',
  skills: 'SENTINEL_SKILL_BODY',
  memory: 'SENTINEL_MEMORY_ITEM',
  specs: 'SENTINEL_SPEC_CHUNK',
  callers: 'SENTINEL_CALLER_SIG',
  repoMap: 'SENTINEL_REPO_MAP',
  prDescription: 'SENTINEL_PR_BODY',
  user: 'SENTINEL_USER_MESSAGE',
};

const fullAssembly: PromptAssembly = {
  system: `You are a reviewer. ${SENTINELS.system}`,
  intent: `intent block ${SENTINELS.intent}`,
  skills: `### rule\n${SENTINELS.skills}`,
  memory: `- ${SENTINELS.memory}`,
  specs: `<untrusted source="spec-0">${SENTINELS.specs}</untrusted>`,
  callers: `- \`foo\` — ${SENTINELS.callers}`,
  repo_map: SENTINELS.repoMap,
  pr_description: SENTINELS.prDescription,
  user: `## Diff to review\n${SENTINELS.user}`,
};

const countChars = (s: string) => s.length;

describe('describeAssembly', () => {
  it('leaks no section content, in either verbose mode', () => {
    for (const verbose of [false, true]) {
      const line = JSON.stringify(
        describeAssembly(fullAssembly, {
          correlationId: 'run-1',
          model: 'gpt-5',
          provider: 'openai',
          verbose,
          count: countChars,
          diffChars: 4096,
        }),
      );
      for (const sentinel of Object.values(SENTINELS)) {
        expect(line, `verbose=${verbose}`).not.toContain(sentinel);
      }
    }
  });

  it('reports every section with its provenance, sizes and the diff row', () => {
    const summary = describeAssembly(fullAssembly, {
      correlationId: 'run-1',
      model: 'gpt-5',
      provider: 'openai',
      verbose: false,
      diffChars: 4096,
    });

    expect(summary.correlation_id).toBe('run-1');
    expect(summary.model).toBe('gpt-5');
    expect(summary.provider).toBe('openai');
    expect(summary.sections.map((s) => s.section)).toEqual([
      'system',
      'intent',
      'skills',
      'memory',
      'specs',
      'callers',
      'repo_map',
      'pr_description',
      'diff',
      'user_total',
    ]);
    expect(summary.sections.find((s) => s.section === 'repo_map')?.source).toBe('repo-intel');
    expect(summary.sections.find((s) => s.section === 'diff')).toEqual({
      section: 'diff',
      source: 'git-diff',
      chars: 4096,
    });
    // Nested sections live inside `user`, so the total is system + user only.
    expect(summary.total_chars).toBe(fullAssembly.system.length + fullAssembly.user.length);
  });

  it('omits absent sections entirely instead of emitting zero rows', () => {
    const summary = describeAssembly(
      { system: 'sys', intent: null, skills: null, memory: null, specs: null, user: 'usr' },
      { correlationId: 'run-1', model: 'gpt-5', verbose: false },
    );
    // No diffChars passed → no diff row either.
    expect(summary.sections.map((s) => s.section)).toEqual(['system', 'user_total']);
    expect(summary.provider).toBeUndefined();
  });

  it('adds tokens, sha and total_tokens only when verbose', () => {
    const opts = {
      correlationId: 'run-1',
      model: 'gpt-5',
      count: countChars,
      diffChars: 10,
    };

    const quiet = describeAssembly(fullAssembly, { ...opts, verbose: false });
    for (const section of quiet.sections) {
      expect(section.tokens).toBeUndefined();
      expect(section.sha).toBeUndefined();
    }
    expect(quiet.total_tokens).toBeUndefined();

    const loud = describeAssembly(fullAssembly, { ...opts, verbose: true });
    const system = loud.sections.find((s) => s.section === 'system');
    expect(system?.tokens).toBe(fullAssembly.system.length);
    expect(system?.sha).toMatch(/^[0-9a-f]{12}$/);
    expect(loud.total_tokens).toBe(fullAssembly.system.length + fullAssembly.user.length);
    // The diff arrives as a length, so it can carry neither a token count nor a
    // fingerprint — this module never sees diff text.
    const diff = loud.sections.find((s) => s.section === 'diff');
    expect(diff?.tokens).toBeUndefined();
    expect(diff?.sha).toBeUndefined();
  });

  it('changes a section fingerprint when that section changes', () => {
    const opts = { correlationId: 'run-1', model: 'gpt-5', verbose: true, count: countChars };
    const a = describeAssembly(fullAssembly, opts);
    const b = describeAssembly({ ...fullAssembly, skills: 'a different skill body' }, opts);
    const sha = (s: ReturnType<typeof describeAssembly>, name: string) =>
      s.sections.find((x) => x.section === name)?.sha;
    expect(sha(b, 'skills')).not.toBe(sha(a, 'skills'));
    expect(sha(b, 'system')).toBe(sha(a, 'system'));
  });
});

describe('describeIntentPrompt', () => {
  it('emits the same shape with classifier provenance and leaks nothing', () => {
    const summary = describeIntentPrompt(
      {
        system: 'SENTINEL_CLASSIFIER_SYSTEM',
        title: 'SENTINEL_PR_TITLE',
        description: 'SENTINEL_PR_DESC',
        issues: ['SENTINEL_ISSUE_BODY'],
        docs: ['SENTINEL_DOC_BODY'],
        fileList: 'SENTINEL_FILE_LIST',
      },
      { correlationId: 'req-7', model: 'gpt-5-mini', provider: 'openai', verbose: true, count: countChars },
    );

    expect(summary.sections.map((s) => [s.section, s.source])).toEqual([
      ['system', 'classifier-prompt'],
      ['title', 'github-pr'],
      ['description', 'github-pr'],
      ['issues', 'github-issue'],
      ['docs', 'repo-doc'],
      ['file_list', 'pr-files'],
    ]);
    const line = JSON.stringify(summary);
    expect(line).not.toMatch(/SENTINEL_/);
  });
});

describe('promptLogVerbose', () => {
  const base = { DATABASE_URL: 'postgres://x/y' };

  it('is on locally when the flag is exactly "true"', () => {
    expect(
      loadConfig({ ...base, NODE_ENV: 'development', PROMPT_LOG_VERBOSE: 'true' }).promptLogVerbose,
    ).toBe(true);
    expect(
      loadConfig({ ...base, NODE_ENV: 'development', PROMPT_LOG_VERBOSE: '1' }).promptLogVerbose,
    ).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).promptLogVerbose).toBe(false);
  });

  it('is inert in production even when the flag is set', () => {
    expect(
      loadConfig({ ...base, NODE_ENV: 'production', PROMPT_LOG_VERBOSE: 'true' }).promptLogVerbose,
    ).toBe(false);
  });
});
