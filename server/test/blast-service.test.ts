/**
 * BlastService — composed against in-line fakes of its two narrow ports
 * (`BlastPullsRepo` / `BlastRepoIntel`), which is the point of the port
 * pattern: no DB, no container, no mocks framework.
 */
import { describe, it, expect } from 'vitest';
import { BlastPanel } from '@devdigest/shared';
import { NotFoundError } from '../src/platform/errors.js';
import { BlastService } from '../src/modules/blast/service.js';
import type { BlastPullsRepo, BlastRepoIntel } from '../src/modules/blast/types.js';
import type { BlastResult } from '../src/modules/repo-intel/types.js';

const PULL = { id: 'pr-1', repoId: 'repo-1', headSha: 'abc123' };

const RESULT: BlastResult = {
  changedSymbols: [{ name: 'parse', file: 'src/parse.ts', kind: 'function' }],
  callers: [{ file: 'src/app.ts', symbol: 'boot', viaSymbol: 'parse', line: 5, rank: 1 }],
  impactedEndpoints: ['GET /parse'],
  factsByFile: { 'src/app.ts': { endpoints: ['GET /parse'], crons: [] } },
};

function makeRepo(over: Partial<BlastPullsRepo> = {}): BlastPullsRepo {
  return {
    getPull: async () => PULL,
    getFiles: async () => [{ path: 'src/parse.ts' }, { path: 'src/app.ts' }],
    listOverlapping: async () => [
      {
        pull: {
          number: 12,
          title: 'Earlier change',
          author: 'octocat',
          status: 'merged',
          updatedAt: new Date('2026-08-10T00:00:00.000Z'),
        },
        overlap: ['src/app.ts'],
      },
    ],
    ...over,
  };
}

function makeIntel(result: BlastResult = RESULT): BlastRepoIntel {
  return { getBlastRadius: async () => result };
}

describe('BlastService.get', () => {
  it('rejects an unknown pull with NotFoundError', async () => {
    const service = new BlastService(makeRepo({ getPull: async () => undefined }), makeIntel());
    await expect(service.get('ws-1', 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('composes {blast, history, degraded, head_sha} that parses against the shared schema', async () => {
    const service = new BlastService(makeRepo(), makeIntel());
    const panel = await service.get('ws-1', 'pr-1');

    const parsed = BlastPanel.parse(panel);
    expect(parsed.head_sha).toBe('abc123');
    expect(parsed.degraded).toBe(false);
    expect(parsed.blast.downstream[0]?.symbol).toBe('parse');
    expect(parsed.history.history[0]?.pr_number).toBe(12);
  });

  it('mirrors result.degraded', async () => {
    const service = new BlastService(
      makeRepo(),
      makeIntel({ ...RESULT, factsByFile: undefined, degraded: true }),
    );
    expect((await service.get('ws-1', 'pr-1')).degraded).toBe(true);
  });

  it('passes (repoId, prId, paths, 5) to listOverlapping', async () => {
    let seen: unknown[] = [];
    const service = new BlastService(
      makeRepo({
        listOverlapping: async (...args) => {
          seen = args;
          return [];
        },
      }),
      makeIntel(),
    );
    await service.get('ws-1', 'pr-1');
    expect(seen).toEqual(['repo-1', 'pr-1', ['src/parse.ts', 'src/app.ts'], 5]);
  });
});
