import type { SmartDiffRole } from '@devdigest/shared';
import {
  BOILERPLATE_PATH_PATTERNS,
  LOCKFILE_BASENAMES,
  TEST_PATH_PATTERNS,
  WIRING_PATH_PATTERNS,
} from './constants.js';

/**
 * Pure path classification. No DB, no IO, no `this` — unit-tests directly.
 */

/** Strip a leading `./`, `a/`, or `b/` (unified-diff path prefixes). */
export function normalizePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^[ab]\//, '');
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/**
 * Classify one PR file path into a Smart Diff role. Checked in order:
 * lock-file basename → boilerplate pattern → wiring pattern → else `core`.
 * A lock-file or a generated/build-output path always wins over the barrel
 * (`index.*`) rule — `dist/index.js` is `boilerplate`, not `wiring`.
 */
export function classifyPath(path: string): SmartDiffRole {
  const normalized = normalizePath(path);
  const base = basename(normalized).toLowerCase();

  if (LOCKFILE_BASENAMES.has(base)) return 'boilerplate';
  if (BOILERPLATE_PATH_PATTERNS.some((re) => re.test(normalized))) return 'boilerplate';
  if (WIRING_PATH_PATTERNS.some((re) => re.test(normalized))) return 'wiring';
  return 'core';
}

/** Secondary sort signal only — a test file stays classified `core`. */
export function isTestPath(path: string): boolean {
  const normalized = normalizePath(path);
  return TEST_PATH_PATTERNS.some((re) => re.test(normalized));
}
