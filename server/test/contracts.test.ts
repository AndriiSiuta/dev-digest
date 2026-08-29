import { describe, it, expect } from 'vitest';
import {
  Review,
  Finding,
  Intent,
  BlastRadius,
  Risks,
  PrHistory,
  SmartDiff,
  Conformance,
  Onboarding,
  EvalRun,
  MemoryItem,
  RunTrace,
  Settings,
  Repo,
  PrDetail,
  ProjectContextDoc,
  AgentContextDocLink,
  SetContextDocsBody,
  AgentVersionConfig,
  SkillVersion,
  PrBrief,
  PrBriefRecord,
  EvalExpectation,
  EvalRunRecord,
  EvalBatchDetail,
  EvalDashboard,
} from '@devdigest/shared';

/**
 * Contract tests — parse/round-trip the fixtures from data.jsx/data2.jsx
 * so feature agents can rely on the schemas matching the prototype data.
 */
describe('AI contracts parse fixtures', () => {
  it('Review + Finding (data.jsx VERDICT/FINDINGS)', () => {
    const review = Review.parse({
      verdict: 'request_changes',
      summary: 'Two blockers before merge.',
      score: 61,
      findings: [
        {
          id: 'f1',
          severity: 'CRITICAL',
          category: 'security',
          title: 'Hardcoded Stripe secret key in commit',
          file: 'src/config.ts',
          start_line: 12,
          end_line: 12,
          rationale: 'Line 12 contains a literal `sk_live_` Stripe key.',
          suggestion: 'Move to env and rotate.',
          confidence: 0.98,
          kind: 'secret_leak',
        },
      ],
    });
    expect(review.findings).toHaveLength(1);
    expect(review.score).toBe(61);
  });

  it('lethal-trifecta Finding variant', () => {
    const f = Finding.parse({
      id: 'f2',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Lethal trifecta',
      file: 'src/api/public/webhooks.ts',
      start_line: 61,
      end_line: 74,
      rationale: 'all three legs present',
      confidence: 0.79,
      kind: 'lethal_trifecta',
      trifecta_components: ['private_data_access', 'untrusted_input', 'exfil_path'],
      evidence: [{ component: 'untrusted_input', file: 'src/api/public/webhooks.ts', line: 61 }],
    });
    expect(f.trifecta_components).toContain('exfil_path');
  });

  it('Intent / BlastRadius / Risks / PrHistory', () => {
    expect(() =>
      Intent.parse({ intent: 'x', in_scope: ['a'], out_of_scope: ['b'] }),
    ).not.toThrow();
    expect(() =>
      BlastRadius.parse({
        changed_symbols: [{ name: 'rateLimit', file: 'a.ts', kind: 'function' }],
        downstream: [
          {
            symbol: 'rateLimit',
            callers: [{ name: 'publicRouter', file: 'b.ts', line: 23 }],
            endpoints_affected: ['GET /x'],
            crons_affected: ['c'],
          },
        ],
        summary: 's',
      }),
    ).not.toThrow();
    expect(() =>
      Risks.parse({
        risks: [{ kind: 'security', title: 't', explanation: 'e', severity: 'high', file_refs: [] }],
      }),
    ).not.toThrow();
    expect(() =>
      PrHistory.parse({
        history: [
          {
            pr_number: 401,
            title: 't',
            merged_at: '2026-03-18',
            author: 'a',
            files_overlap: [],
            notes: 'n',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('SmartDiff (data.jsx DIFF)', () => {
    const d = SmartDiff.parse({
      groups: [
        {
          role: 'core',
          files: [
            { path: 'a.ts', additions: 84, deletions: 0, finding_lines: [28, 52], findings: [] },
          ],
        },
      ],
      split_suggestion: { too_big: false, total_lines: 285, proposed_splits: [] },
    });
    expect(d.groups[0]!.role).toBe('core');
  });

  it('SmartDiff with findings overlay', () => {
    const d = SmartDiff.parse({
      groups: [
        {
          role: 'core',
          files: [
            {
              path: 'a.ts',
              additions: 84,
              deletions: 0,
              finding_lines: [28, 52],
              findings: [
                {
                  id: 'f1',
                  line: 28,
                  end_line: 28,
                  severity: 'CRITICAL',
                  title: 'Hardcoded secret',
                },
                {
                  id: 'f2',
                  line: 52,
                  end_line: 53,
                  severity: 'SUGGESTION',
                  title: 'Prefer const over let',
                },
              ],
            },
          ],
        },
      ],
      split_suggestion: { too_big: false, total_lines: 285, proposed_splits: [] },
    });
    expect(d.groups[0]!.files[0]!.findings).toHaveLength(2);
    expect(d.groups[0]!.files[0]!.findings[0]!.severity).toBe('CRITICAL');
  });

  it('Conformance / Onboarding / EvalRun / MemoryItem', () => {
    expect(() =>
      Conformance.parse({
        spec_id: 's1',
        spec_title: 'Spec',
        items: [{ requirement: 'r', status: 'implemented' }],
        completeness_pct: 80,
      }),
    ).not.toThrow();
    expect(() =>
      Onboarding.parse({
        sections: [{ kind: 'architecture', title: 'T', body: 'b', links: [] }],
      }),
    ).not.toThrow();
    expect(() =>
      EvalRun.parse({
        recall: 0.82,
        precision: 0.91,
        citation_accuracy: 0.95,
        traces_passed: 17,
        traces_total: 20,
        duration_ms: 12000,
        cost_usd: 0.23,
        per_trace: [{ name: 't01', pass: true, expected: 'x', actual: 'x' }],
      }),
    ).not.toThrow();
    expect(() =>
      MemoryItem.parse({
        content: 'c',
        scope: 'team',
        kind: 'decision',
        confidence: 0.92,
        sources: [{ pr: 401, context: 'ctx' }],
      }),
    ).not.toThrow();
  });

  it('RunTrace (data2.jsx TRACE single-document)', () => {
    const trace = RunTrace.parse({
      config: { agent: 'Security Reviewer', version: 'v7', model: 'gpt-4.1', pr: 482, source: 'local' },
      stats: {
        duration_ms: 8200,
        tokens_in: 14820,
        tokens_out: 1240,
        cost_usd: 0.06,
        findings: 3,
        grounding: '3/3 passed',
      },
      prompt_assembly: { system: 's', user: 'u' },
      tool_calls: [{ tool: 'read_file', args: "'src/config.ts'", meta: '1,240 bytes', ms: 120 }],
      raw_output: '{}',
      memory_pulled: [{ pr: 288, text: 'verified via stripe-signature' }],
      specs_read: [{ path: 'specs/security-baseline.md', tokens: 412, status: 'included' }],
      log: [{ t: '00.00', kind: 'info', msg: 'started' }],
    });
    expect(trace.tool_calls).toHaveLength(1);
    expect(trace.specs_read[0]).toEqual({
      path: 'specs/security-baseline.md',
      tokens: 412,
      status: 'included',
    });
  });
});

describe('project-context contracts', () => {
  it('ProjectContextDoc carries a path, a derived type and a byte size — no body', () => {
    const doc = ProjectContextDoc.parse({ path: 'docs/api/routes.md', type: 'doc', bytes: 2048 });
    expect(doc).toEqual({ path: 'docs/api/routes.md', type: 'doc', bytes: 2048 });
    // The type is derived from the search root, so a custom root parses too.
    expect(ProjectContextDoc.parse({ path: 'adr/0001.md', type: 'adr', bytes: 10 }).type).toBe('adr');
  });

  it('AgentContextDocLink is the (agent, repo, path) triple plus the per-link switch', () => {
    const link = AgentContextDocLink.parse({
      agent_id: 'a1',
      repo_id: 'r1',
      path: 'specs/api.md',
      order: 0,
      enabled: true,
    });
    expect(link.repo_id).toBe('r1');
  });

  it('SetContextDocsBody replaces the set for ONE repo; enabled is optional', () => {
    const body = SetContextDocsBody.parse({
      repo_id: 'r1',
      docs: [{ path: 'specs/api.md' }, { path: 'docs/db.md', enabled: false }],
    });
    expect(body.docs).toHaveLength(2);
    expect(body.docs[1]?.enabled).toBe(false);
    expect(() => SetContextDocsBody.parse({ docs: [] })).toThrow();
  });

  it('context_docs defaults to [] so pre-feature snapshots still parse', () => {
    const cfg = AgentVersionConfig.parse({
      provider: 'openai',
      model: 'gpt-4.1',
      system_prompt: 'p',
      strategy: 'single-pass',
      ci_fail_on: 'critical',
      repo_intel: true,
      skills: [],
    });
    expect(cfg.context_docs).toEqual([]);

    const version = SkillVersion.parse({
      skill_id: 's1',
      version: 1,
      body: 'b',
      created_at: '2026-08-28T00:00:00.000Z',
    });
    expect(version.context_docs).toEqual([]);
  });
});

describe('platform DTOs', () => {
  it('Settings defaults + passthrough', () => {
    const s = Settings.parse({ extra_key: 'x' });
    expect(s.theme).toBe('dark');
    expect((s as Record<string, unknown>).extra_key).toBe('x');
  });

  it('Repo + PrDetail', () => {
    expect(() =>
      Repo.parse({
        id: 'r1',
        workspace_id: 'w1',
        owner: 'acme',
        name: 'payments-api',
        full_name: 'acme/payments-api',
        default_branch: 'main',
        clone_path: null,
        last_polled_at: null,
        created_by: null,
      }),
    ).not.toThrow();
    expect(() =>
      PrDetail.parse({
        number: 482,
        title: 't',
        author: 'a',
        branch: 'b',
        base: 'main',
        head_sha: 'sha',
        additions: 1,
        deletions: 0,
        files_count: 1,
        status: 'open',
        files: [],
        commits: [],
      }),
    ).not.toThrow();
  });
});

describe('PR Brief contracts', () => {
  const record = {
    pr_id: 'pr1',
    brief: {
      what: 'Adds a per-route rate limit to the public API.',
      why: 'Closes #123 — the webhook endpoint was being hammered.',
      risk_level: 'high',
      risks: [
        {
          kind: 'security',
          title: 'Limiter is keyed by IP only',
          explanation: 'A shared NAT would be limited as one client.',
          severity: 'high',
          file_refs: ['src/api/public/webhooks.ts'],
        },
      ],
      review_focus: [
        { file: 'src/api/public/webhooks.ts', line: 61, reason: 'the new limiter key' },
        { file: 'src/config.ts', reason: 'the window default' },
      ],
      degraded: true,
      missing_inputs: [
        { kind: 'intent', status: 'absent' },
        { kind: 'blast', status: 'degraded' },
        { kind: 'project_context', status: 'unreachable' },
      ],
    },
    head_sha: 'abc123',
    pr_head_sha: 'def456',
    model: 'gpt-4.1',
    generated_at: '2026-08-29T00:00:00.000Z',
  };

  it('PrBriefRecord round-trips a fully populated brief', () => {
    const parsed = PrBriefRecord.parse(record);
    expect(parsed.brief.risk_level).toBe('high');
    expect(parsed.brief.review_focus[0]!.line).toBe(61);
    // `line` is optional — a focus item without one still parses.
    expect(parsed.brief.review_focus[1]!.line).toBeUndefined();
    expect(parsed.head_sha).not.toBe(parsed.pr_head_sha);
    expect(parsed.brief.missing_inputs).toHaveLength(3);
  });

  it('rejects a risk_level outside the four values', () => {
    expect(() =>
      PrBriefRecord.parse({ ...record, brief: { ...record.brief, risk_level: 'critical' } }),
    ).toThrow();
  });

  it('rejects a review_focus item with an empty reason', () => {
    expect(() =>
      PrBriefRecord.parse({
        ...record,
        brief: {
          ...record.brief,
          review_focus: [{ file: 'src/a.ts', line: 1, reason: '' }],
        },
      }),
    ).toThrow();
  });

  it('PrBrief still parses its original shape — it is left alone deliberately', () => {
    const brief = PrBrief.parse({
      intent: { intent: 'x', in_scope: ['a'], out_of_scope: ['b'] },
      blast: { changed_symbols: [], downstream: [], summary: 's' },
      risks: { risks: [] },
      history: { history: [] },
    });
    expect(brief.risks.risks).toEqual([]);
  });
});

describe('Eval pipeline contracts', () => {
  const runRecord = {
    id: 'r1',
    case_id: 'c1',
    case_name: 'Hardcoded Stripe secret key in commit',
    batch_id: 'b1',
    agent_version: 3,
    ran_at: '2026-08-29T00:00:00.000Z',
    actual_output: { model: 'gpt-4.1', proposed: 2, surviving: 1 },
    pass: true,
    recall: null,
    precision: null,
    citation_accuracy: 0.5,
    duration_ms: 1200,
    cost_usd: 0.002,
    error: null,
  };

  it('a fully-populated EvalBatchDetail parses', () => {
    const detail = EvalBatchDetail.parse({
      batch_id: 'b1',
      agent_id: 'a1',
      agent_version: 3,
      model: 'gpt-4.1',
      ran_at: '2026-08-29T00:00:00.000Z',
      cases_total: 2,
      cases_errored: 1,
      cases_passed: 1,
      recall: 1,
      precision: 0.5,
      citation_accuracy: 0.545,
      duration_ms: 2400,
      cost_usd: null,
      results: [
        runRecord,
        {
          ...runRecord,
          id: 'r2',
          case_id: 'c2',
          pass: null,
          citation_accuracy: null,
          duration_ms: null,
          cost_usd: null,
          error: 'provider timed out',
        },
      ],
    });
    expect(detail.results).toHaveLength(2);
    expect(detail.results[1]!.error).toBe('provider timed out');
  });

  it('an EvalExpectation with an unknown kind fails', () => {
    expect(() =>
      EvalExpectation.parse({ kind: 'maybe_find', file: 'src/a.ts', start_line: 1, end_line: 2 }),
    ).toThrow();
    expect(() =>
      EvalExpectation.parse({ kind: 'must_not_flag', file: 'src/a.ts', start_line: 1, end_line: 2 }),
    ).not.toThrow();
  });

  it('an EvalRunRecord without batch_id fails', () => {
    const { batch_id: _dropped, ...withoutBatch } = runRecord;
    expect(() => EvalRunRecord.parse(withoutBatch)).toThrow();
  });

  it('the pre-staged EvalRun / EvalDashboard still parse their original shapes', () => {
    // The left-alone guarantee: the unused L06 contracts are untouched.
    expect(() =>
      EvalRun.parse({
        recall: 0.82,
        precision: 0.91,
        citation_accuracy: 0.95,
        traces_passed: 17,
        traces_total: 20,
        duration_ms: 12000,
        cost_usd: 0.23,
        per_trace: [],
      }),
    ).not.toThrow();
    expect(() =>
      EvalDashboard.parse({
        owner_kind: 'agent',
        owner_id: 'a1',
        cases_total: 8,
        current: {
          recall: 0.8,
          precision: 0.9,
          citation_accuracy: 0.95,
          traces_passed: 7,
          traces_total: 8,
          cost_usd: null,
        },
        delta: { recall: 0, precision: 0, citation_accuracy: 0 },
        trend: [],
        recent_runs: [runRecord],
        alert: null,
      }),
    ).not.toThrow();
  });
});
