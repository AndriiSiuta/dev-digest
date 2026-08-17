import { z } from 'zod';
import { wrapUntrusted } from '../../platform/prompt.js';
import { MAX_RISK_AREAS } from './constants.js';

/**
 * The classification call. One cheap structured request over the PR's own
 * claims (title, description, linked issue/docs) plus the changed-file list
 * with hunk headers — never diff bodies. Everything author-controlled is
 * wrapped as untrusted data.
 */

export const IntentSchema = z.object({
  /** One or two sentences: what this PR is for, in the maintainer's voice. */
  intent: z.string(),
  /** Short imperative phrases naming what the PR deliberately changes. */
  in_scope: z.array(z.string()),
  /** Short imperative phrases naming adjacent work the PR deliberately does NOT touch. */
  out_of_scope: z.array(z.string()),
  /**
   * Field ORDER is generation order in a structured response, so the risk
   * areas and the score come LAST, after the intent and scope are written —
   * declared earlier, the model commits to them before knowing what it is
   * scoring (see the conventions extractor's field-order note).
   */
  risk_areas: z.array(z.string()).max(MAX_RISK_AREAS),
  confidence: z.number().min(0).max(1),
});
export type IntentClassification = z.infer<typeof IntentSchema>;

export const SYSTEM_PROMPT = `You derive a pull request's INTENT AND SCOPE: what the author set out to do, so a reviewer can tell purposeful changes from scope creep.

You are given the PR's title, description, any linked issue or referenced project docs, and the list of changed files with their hunk headers. You never see diff bodies — judge the claims, not the code.

INTENT
- One or two sentences stating what the PR is for. Ground it in what the sources actually say; do not embellish.

IN SCOPE / OUT OF SCOPE
- Short imperative phrases (e.g. "add retry to the GitHub adapter"), not sentences.
- in_scope: the changes the PR deliberately makes, per its stated goal and its file list.
- out_of_scope: adjacent work the sources explicitly exclude, or that the stated goal clearly does not cover. Only list exclusions you can justify from the sources; an empty list is a valid answer.

MISSING CONTEXT — do not invent it
- Some referenced sources may be marked unreachable or unsupported. NEVER guess what they contain; derive only from the content you were given, and lower your confidence accordingly.

RISK AREAS — after the scope, name at most ${MAX_RISK_AREAS} short phrases for where this change is most likely to break something (e.g. "auth token refresh path"). Only areas the file list or sources support; fewer is better.

CONFIDENCE — last, 0 to 1
- 0.8+: a clear description or linked issue states the goal outright.
- 0.5-0.8: the goal is inferable from title + files but not stated.
- Below 0.5: sources are thin, contradictory, or mostly unreachable.`;

export interface IntentPromptInput {
  repoFullName: string;
  prNumber: number;
  title: string;
  /** Capped description; empty string when the PR has no body. */
  description: string;
  /** Fetched linked issues (capped bodies). */
  issues: { ref: string; text: string }[];
  /** Read referenced docs (capped contents). */
  docs: { path: string; text: string }[];
  /** Rendered changed-file list (paths + hunk headers); empty when no files. */
  fileList: string;
  /** Refs of sources that could NOT be included (unreachable/unsupported). */
  missingRefs: string[];
}

/** Assemble the user message. Every author-controlled block is delimiter-wrapped. */
export function buildUserPrompt(input: IntentPromptInput): string {
  const sections: string[] = [
    `Pull request #${input.prNumber} in ${input.repoFullName}`,
    `## Title\n${wrapUntrusted('pr-title', input.title)}`,
  ];
  if (input.description.trim().length > 0) {
    sections.push(`## Description\n${wrapUntrusted('pr-description', input.description)}`);
  } else {
    sections.push('## Description\n(The PR has no description.)');
  }
  for (const issue of input.issues) {
    sections.push(`## Linked issue ${issue.ref}\n${wrapUntrusted('linked-issue', issue.text)}`);
  }
  for (const doc of input.docs) {
    sections.push(`## Referenced doc ${doc.path}\n${wrapUntrusted('doc-link', doc.text)}`);
  }
  if (input.missingRefs.length > 0) {
    sections.push(
      `## Referenced but NOT included (do not guess their content)\n${input.missingRefs
        .map((r) => `- ${r}`)
        .join('\n')}`,
    );
  }
  sections.push(
    input.fileList.trim().length > 0
      ? `## Changed files (hunk headers only — no diff content)\n${wrapUntrusted('file-list', input.fileList)}`
      : '## Changed files\n(No changed-file list is available for this PR.)',
  );
  return sections.join('\n\n');
}
