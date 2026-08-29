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
