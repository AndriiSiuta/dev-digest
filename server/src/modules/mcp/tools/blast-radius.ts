/**
 * `devdigest_get_blast_radius` — LIVE (the planned one-line swap happened once
 * the blast lesson landed a consumer for the facade).
 *
 * The repository resolves against the workspace, `files` is validated, and the
 * answer is `projectBlast` over `repoIntel.getBlastRadius`. Calls written
 * against the earlier stub keep working unchanged — args and misses are the
 * same; only the payload went from `{implemented:false, next}` to real data.
 *
 * `projectBlast` is what guarantees `factsByFile` (an internal per-file read
 * model) and the full `callers[]` list never reach a client — the projection
 * emits only `{ changed_symbols, impacted_endpoints, caller_count }`.
 */

import { coerceString } from '../identifiers.js';
import { guidance, projectBlast } from '../projections.js';
import type { GetBlastRadiusInput } from '../schemas.js';
import type { McpGuidance } from '../types.js';
import { resolveRepo, type ToolEnv } from './shared.js';

/** The shape the implementation returns. */
export type BlastRadiusResult = ReturnType<typeof projectBlast>;

/** Mirrors `maxItems` on `GET_BLAST_RADIUS_JSON_SCHEMA.properties.files`. */
const MAX_FILES = 50;

export async function getBlastRadius(
  env: ToolEnv,
  args: GetBlastRadiusInput,
): Promise<BlastRadiusResult | McpGuidance> {
  const repo = await resolveRepo(env, args.repo);
  if (!repo.ok) return repo.payload;

  const files = coerceFiles(args.files);
  if ('error' in files) {
    return guidance(
      'files_required',
      `${files.error} Pass files as repository-relative paths, e.g. ["src/app.ts"].`,
      `retry with repo="${repo.value.fullName}" and files set to the changed paths (1-${MAX_FILES})`,
      { repo: repo.value.fullName },
    );
  }

  return projectBlast(await env.deps.repoIntel.getBlastRadius(repo.value.id, files.paths));
}

/**
 * `files` → a clean path list. Tolerates a single string (a model sending one
 * path unwrapped is common) and drops blank entries; anything else is a miss
 * answered with guidance, never a throw.
 */
function coerceFiles(input: unknown): { paths: string[] } | { error: string } {
  const raw = Array.isArray(input) ? input : input === undefined ? [] : [input];
  if (raw.length === 0) return { error: 'Which files changed?' };

  const paths: string[] = [];
  for (const item of raw) {
    const s = coerceString(item);
    if (s !== undefined) paths.push(s);
  }
  if (paths.length === 0) return { error: 'None of the entries in files is a path.' };
  if (paths.length > MAX_FILES) {
    return { error: `${paths.length} files is more than the ${MAX_FILES} this tool takes.` };
  }
  return { paths };
}
