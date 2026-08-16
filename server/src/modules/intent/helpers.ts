/**
 * Pure helpers for the intent classifier (side-effect free; operate purely on
 * their arguments — no DB / network / `this`).
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `@@ … @@` hunk header lines of a unified-diff patch — and ONLY those.
 * Body lines start with `+`/`-`/space, so headers are the one shape that can
 * tell the model *where* a file changed without leaking any diff content.
 */
export function hunkHeadersFromPatch(patch: string | null | undefined): string[] {
  if (!patch) return [];
  return patch.split('\n').filter((line) => line.startsWith('@@'));
}

/**
 * Issue numbers referenced by a PR body: `#123`, `closes #123`, and same-repo
 * issue URLs. Cross-repo references are ignored (v1 stays within the repo).
 */
export function extractIssueRefs(body: string, repoFullName: string): number[] {
  const out = new Set<number>();
  for (const m of body.matchAll(/(?:^|[\s([])#(\d+)\b/g)) out.add(Number(m[1]));
  const urlRe = new RegExp(
    `https://github\\.com/${escapeRegExp(repoFullName)}/issues/(\\d+)`,
    'g',
  );
  for (const m of body.matchAll(urlRe)) out.add(Number(m[1]));
  return [...out];
}

export interface DocLinks {
  /** Repo-relative markdown paths we can read from the clone. */
  paths: string[];
  /** Absolute URLs v1 does not follow — flagged as missing context. */
  unsupported: string[];
}

/**
 * Doc/spec links in a PR body: repo-relative `.md` paths (`docs/specs/x.md`)
 * and same-repo `blob` URLs resolve to readable paths; same-repo issue URLs
 * are the issue extractor's business; every OTHER absolute URL is
 * `unsupported` — v1 never fetches arbitrary external content.
 */
export function extractDocLinks(body: string, repoFullName: string): DocLinks {
  const paths = new Set<string>();
  const unsupported = new Set<string>();

  const blobRe = new RegExp(
    `^https://github\\.com/${escapeRegExp(repoFullName)}/blob/[^/]+/(.+?)(?:#.*)?$`,
  );
  const issueRe = new RegExp(
    `^https://github\\.com/${escapeRegExp(repoFullName)}/issues/\\d+$`,
  );

  // URLs first, blanked out of the text so a URL's path segment can never be
  // re-matched as a repo-relative path below.
  let rest = body;
  for (const url of body.match(/https?:\/\/[^\s)>\]'"`]+/g) ?? []) {
    rest = rest.replace(url, ' ');
    const blob = url.match(blobRe);
    if (blob?.[1]) {
      paths.add(blob[1]);
      continue;
    }
    if (issueRe.test(url)) continue; // a linked issue, not a doc
    unsupported.add(url);
  }

  for (const m of rest.matchAll(/(?:^|[\s(`'"[])((?:[\w.-]+\/)+[\w.-]+\.md)\b/g)) {
    if (m[1]) paths.add(m[1]);
  }

  return { paths: [...paths], unsupported: [...unsupported] };
}

/**
 * Render the changed-file list for the prompt: one line per file with its
 * +/- counts, then that file's hunk headers indented beneath it. Truncated at
 * `maxChars` so a thousand-file PR cannot blow the budget.
 */
export function renderFileList(
  files: { path: string; additions: number; deletions: number; patch: string | null }[],
  maxChars: number,
): string {
  const lines: string[] = [];
  for (const f of files) {
    lines.push(`${f.path} (+${f.additions}/-${f.deletions})`);
    for (const header of hunkHeadersFromPatch(f.patch)) lines.push(`  ${header}`);
  }
  const rendered = lines.join('\n');
  if (rendered.length <= maxChars) return rendered;
  return `${rendered.slice(0, maxChars)}\n… (file list truncated)`;
}
