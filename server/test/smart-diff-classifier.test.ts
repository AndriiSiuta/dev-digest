/**
 * Smart Diff path classification (`modules/smart-diff/classifier.ts`) — the
 * pure lock-file / boilerplate / wiring / core rules, table-driven.
 */
import { describe, it, expect } from 'vitest';
import { classifyPath, isTestPath } from '../src/modules/smart-diff/classifier.js';

describe('classifyPath — lock files', () => {
  const lockfiles = [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'bun.lock',
    'cargo.lock',
    'poetry.lock',
    'pipfile.lock',
    'pdm.lock',
    'uv.lock',
    'go.sum',
    'gemfile.lock',
    'composer.lock',
    'mix.lock',
    'pubspec.lock',
    'packages.lock.json',
    'flake.lock',
    'podfile.lock',
    'gradle.lockfile',
    'deno.lock',
  ];

  it.each(lockfiles)('%s at the root is boilerplate', (name) => {
    expect(classifyPath(name)).toBe('boilerplate');
  });

  it.each(lockfiles)('%s nested several directories deep is boilerplate', (name) => {
    expect(classifyPath(`packages/api/deep/nested/${name}`)).toBe('boilerplate');
  });

  it('matches lock-file basenames case-insensitively', () => {
    expect(classifyPath('Yarn.LOCK')).toBe('boilerplate');
    expect(classifyPath('PNPM-LOCK.YAML')).toBe('boilerplate');
  });
});

describe('classifyPath — boilerplate wins over the barrel (wiring) rule', () => {
  it('dist/index.js is boilerplate, not wiring', () => {
    expect(classifyPath('dist/index.js')).toBe('boilerplate');
  });

  it('build output at any depth is boilerplate', () => {
    expect(classifyPath('packages/web/build/static/js/main.js')).toBe('boilerplate');
  });

  it('a snapshot file is boilerplate', () => {
    expect(classifyPath('src/__snapshots__/Card.test.tsx.snap')).toBe('boilerplate');
  });

  it('a minified bundle is boilerplate', () => {
    expect(classifyPath('public/vendor.min.js')).toBe('boilerplate');
  });

  it('a generated migration snapshot is boilerplate', () => {
    expect(classifyPath('src/db/migrations/meta/0017_snapshot.json')).toBe('boilerplate');
  });

  it('a protobuf-generated file is boilerplate', () => {
    expect(classifyPath('gen/api.pb.go')).toBe('boilerplate');
  });

  it('a binary asset is boilerplate', () => {
    expect(classifyPath('assets/logo.png')).toBe('boilerplate');
  });
});

describe('classifyPath — wiring', () => {
  it('a plain barrel file is wiring', () => {
    expect(classifyPath('src/modules/foo/index.ts')).toBe('wiring');
  });

  it('a build-tool config file is wiring', () => {
    expect(classifyPath('vite.config.ts')).toBe('wiring');
  });

  it('package.json is wiring', () => {
    expect(classifyPath('package.json')).toBe('wiring');
  });

  it('a migration .sql file is wiring (per the confirmed decision)', () => {
    expect(classifyPath('src/db/migrations/0017_uneven_golden_guardian.sql')).toBe('wiring');
  });

  it('a markdown doc is wiring', () => {
    expect(classifyPath('README.md')).toBe('wiring');
  });

  it('anything under docs/ is wiring', () => {
    expect(classifyPath('docs/specs/conventions.md')).toBe('wiring');
  });

  it('a GitHub Actions workflow is wiring', () => {
    expect(classifyPath('.github/workflows/ci.yml')).toBe('wiring');
  });

  it('a .d.ts declaration file is wiring', () => {
    expect(classifyPath('src/types/global.d.ts')).toBe('wiring');
  });
});

describe('classifyPath — core', () => {
  it('an ordinary source file is core', () => {
    expect(classifyPath('src/modules/smart-diff/helpers.ts')).toBe('core');
  });

  it('a test file is still core (test-ness is a sort signal, not a role)', () => {
    expect(classifyPath('src/modules/smart-diff/helpers.test.ts')).toBe('core');
  });

  it('strips a-/b- diff prefixes before classifying', () => {
    expect(classifyPath('a/src/config.ts')).toBe('core');
    expect(classifyPath('b/src/config.ts')).toBe('core');
  });
});

describe('isTestPath', () => {
  it('flags *.test.* and *.spec.* files', () => {
    expect(isTestPath('src/foo.test.ts')).toBe(true);
    expect(isTestPath('src/foo.spec.ts')).toBe(true);
  });

  it('flags __tests__/, tests/ and fixtures/ directories', () => {
    expect(isTestPath('src/__tests__/foo.ts')).toBe(true);
    expect(isTestPath('tests/foo.ts')).toBe(true);
    expect(isTestPath('src/fixtures/foo.json')).toBe(true);
  });

  it('is false for an ordinary source file', () => {
    expect(isTestPath('src/foo.ts')).toBe(false);
  });
});
