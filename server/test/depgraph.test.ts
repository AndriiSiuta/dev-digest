import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DepCruiseGraph } from '../src/adapters/depgraph/index.js';

/**
 * Fixture shaped like an imported repo whose project lives in a nested
 * directory (weather-app layout): no root tsconfig, aliases defined in
 * `app/tsconfig.json` relative to its own baseUrl.
 */
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'depgraph-'));
  await mkdir(join(root, 'app/src/core'), { recursive: true });
  await writeFile(
    join(root, 'app/tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        baseUrl: './src',
        paths: { '@core/*': ['app/core/*'] },
      },
    }),
  );
  await mkdir(join(root, 'app/src/app/core'), { recursive: true });
  await writeFile(join(root, 'app/src/app/core/svc.ts'), 'export const svc = 1;\n');
  await writeFile(
    join(root, 'app/src/app/main.ts'),
    "import { svc } from '@core/svc';\nimport { rel } from './rel';\nexport const m = svc + rel;\n",
  );
  await writeFile(join(root, 'app/src/app/rel.ts'), 'export const rel = 2;\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('DepCruiseGraph.buildEdges', () => {
  it('resolves tsconfig path aliases when tsconfig.json is not at the repo root', async () => {
    const files = [
      'app/src/app/main.ts',
      'app/src/app/rel.ts',
      'app/src/app/core/svc.ts',
    ];
    const edges = await new DepCruiseGraph().buildEdges(root, files);
    // relative import always worked
    expect(edges).toContainEqual({ from: 'app/src/app/main.ts', to: 'app/src/app/rel.ts' });
    // aliased import requires picking up the nested tsconfig
    expect(edges).toContainEqual({ from: 'app/src/app/main.ts', to: 'app/src/app/core/svc.ts' });
  });
});
