import type { IntentSource, PrIntentRecord, RepoRef } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import type { PinoLike } from '../../platform/run-logger.js';
import { describeIntentPrompt } from '../../platform/prompt-log.js';
import { resolveFeatureModel } from '../settings/feature-models.js';
import type { PullRow, RepoRow } from '../../db/rows.js';
import { extractDocLinks, extractIssueRefs, renderFileList } from './helpers.js';
import { IntentSchema, SYSTEM_PROMPT, buildUserPrompt, type IntentPromptInput } from './prompt.js';
import {
  CLASSIFY_MAX_TOKENS,
  CLASSIFY_TEMPERATURE,
  CLASSIFY_TIMEOUT_MS,
  MAX_DESCRIPTION_CHARS,
  MAX_DOC_CHARS,
  MAX_DOC_LINKS,
  MAX_FILE_LIST_CHARS,
  MAX_ISSUE_CHARS,
  MAX_LINKED_ISSUES,
  NO_DESCRIPTION_CONFIDENCE_CAP,
} from './constants.js';
import type { IntentFacade } from './types.js';

/** What the gather step hands to the model call, plus its source ledger. */
interface GatheredSources {
  prompt: IntentPromptInput;
  sources: IntentSource[];
}

/**
 * Intent classifier.
 *
 * Gather (code) → one cheap structured call (model) → persist. The model sees
 * the PR's CLAIMS — title, description, linked issue, referenced project docs —
 * and the changed-file list with hunk headers, never diff bodies. Every source
 * is ledgered with a status; anything referenced but not included marks the
 * classification `missing_context` rather than being guessed at.
 */
export class IntentService implements IntentFacade {
  constructor(private container: Container) {}

  /** The persisted intent, or undefined when the PR is not classified yet. */
  async get(workspaceId: string, prId: string): Promise<PrIntentRecord | undefined> {
    const pull = await this.container.pullsRepo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    return this.container.reviewRepo.getIntent(prId);
  }

  /**
   * (Re)classify a PR's intent and persist the result.
   *
   * `correlationId` ties the prompt line below to whatever triggered the call —
   * the review's runId, or the HTTP request id. Optional and last so existing
   * callers compile unchanged; it falls back to the PR id.
   */
  async classify(
    workspaceId: string,
    prId: string,
    logger?: PinoLike,
    correlationId?: string,
  ): Promise<PrIntentRecord> {
    const pull = await this.container.pullsRepo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    const repo = await this.container.pullsRepo.getRepoById(pull.repoId);
    if (!repo) throw new NotFoundError('Repository not found');

    const { prompt, sources } = await this.gather(pull, repo);
    const user = buildUserPrompt(prompt);

    const choice = await resolveFeatureModel(this.container, workspaceId, 'review_intent');
    const llm = await this.container.llm(choice.provider);
    const result = await llm.completeStructured({
      model: choice.model,
      schema: IntentSchema,
      // Matches the fixture key `MockLLMOptions.structuredBySchema` documents
      // for this feature, so a test can target this call by name.
      schemaName: 'IntentClassification',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      temperature: CLASSIFY_TEMPERATURE,
      maxTokens: CLASSIFY_MAX_TOKENS,
      timeoutMs: CLASSIFY_TIMEOUT_MS,
    });

    // No description → the model classified from title + files alone; its
    // self-reported confidence is capped so the UI's low-confidence badge shows.
    const confidence =
      prompt.description.trim().length === 0
        ? Math.min(result.data.confidence, NO_DESCRIPTION_CONFIDENCE_CAP)
        : result.data.confidence;

    await this.container.reviewRepo.upsertIntent(prId, {
      intent: result.data.intent,
      in_scope: result.data.in_scope,
      out_of_scope: result.data.out_of_scope,
      risk_areas: result.data.risk_areas,
      confidence,
      sources,
      model: result.model,
      head_sha: pull.headSha,
    });

    // One structured line per classification. Sizes, provenance labels, source
    // REFS (issue numbers, doc paths) and ids only — never the title, the body,
    // an issue, a doc, or the model's output. Same `sections[]` shape as the
    // review path's `prompt assembled` line, joinable on `correlation_id`.
    logger?.info(
      {
        feature: 'review_intent',
        ...describeIntentPrompt(
          {
            system: SYSTEM_PROMPT,
            title: prompt.title,
            description: prompt.description,
            issues: prompt.issues.map((i) => i.text),
            docs: prompt.docs.map((d) => d.text),
            fileList: prompt.fileList,
          },
          {
            correlationId: correlationId ?? prId,
            model: result.model,
            provider: choice.provider,
            verbose: this.container.config.promptLogVerbose,
            count: (s) => this.container.tokenizer.count(s),
          },
        ),
        sources,
        token_estimate: this.container.tokenizer.count(`${SYSTEM_PROMPT}\n${user}`),
        tokens_in: result.tokensIn,
        tokens_out: result.tokensOut,
        cost_usd: result.costUsd,
      },
      'intent: classified',
    );

    const record = await this.container.reviewRepo.getIntent(prId);
    // The row was just upserted; a miss here is a bug, not a 404.
    if (!record) throw new Error('Intent vanished after upsert');
    return record;
  }

  /** Facade for the review path: existing record, else best-effort classify. */
  async getOrClassify(
    workspaceId: string,
    pull: PullRow,
    correlationId?: string,
    logger?: PinoLike,
  ): Promise<PrIntentRecord | undefined> {
    const existing = await this.container.reviewRepo.getIntent(pull.id);
    if (existing) return existing;
    return this.classify(workspaceId, pull.id, logger, correlationId);
  }

  /**
   * Gather every input with a per-source ledger entry. Fetch failures are
   * `unreachable`, external URLs `unsupported` — both reach the model only as
   * "referenced but not included" refs, never as guessed content.
   */
  private async gather(pull: PullRow, repo: RepoRow): Promise<GatheredSources> {
    const ref: RepoRef = { owner: repo.owner, name: repo.name };
    const repoFullName = repo.fullName;
    const body = pull.body ?? '';
    const sources: IntentSource[] = [];

    sources.push({ kind: 'pr_title', ref: 'title', status: 'included', chars: pull.title.length });

    const description = body.slice(0, MAX_DESCRIPTION_CHARS);
    sources.push({
      kind: 'pr_description',
      ref: 'body',
      status: description.trim().length > 0 ? 'included' : 'empty',
      chars: description.length,
    });

    // Linked issues — a failed fetch (no token, network, deleted issue) is a
    // ledger entry, not an error.
    const issues: { ref: string; text: string }[] = [];
    const issueRefs = extractIssueRefs(body, repoFullName).slice(0, MAX_LINKED_ISSUES);
    for (const n of issueRefs) {
      try {
        const gh = await this.container.github();
        const issue = await gh.getIssue(ref, n);
        const text = `${issue.title}\n\n${issue.body ?? ''}`.slice(0, MAX_ISSUE_CHARS);
        issues.push({ ref: `#${n}`, text });
        sources.push({ kind: 'linked_issue', ref: `#${n}`, status: 'included', chars: text.length });
      } catch {
        sources.push({ kind: 'linked_issue', ref: `#${n}`, status: 'unreachable', chars: null });
      }
    }

    // Referenced docs — read from the local clone; a repo that was never
    // cloned (or a path that does not exist) is `unreachable`.
    const docs: { path: string; text: string }[] = [];
    const links = extractDocLinks(body, repoFullName);
    for (const path of links.paths.slice(0, MAX_DOC_LINKS)) {
      try {
        const raw = await this.container.git.readFile(ref, path);
        const text = raw.slice(0, MAX_DOC_CHARS);
        docs.push({ path, text });
        sources.push({ kind: 'doc_link', ref: path, status: 'included', chars: text.length });
      } catch {
        sources.push({ kind: 'doc_link', ref: path, status: 'unreachable', chars: null });
      }
    }
    for (const url of links.unsupported) {
      sources.push({ kind: 'doc_link', ref: url, status: 'unsupported', chars: null });
    }

    // Changed files: paths + hunk headers only. No persisted files → `empty`;
    // we deliberately do NOT fetch the diff for a classification.
    const files = await this.container.pullsRepo.getFiles(pull.id);
    const fileList = files.length > 0 ? renderFileList(files, MAX_FILE_LIST_CHARS) : '';
    sources.push({
      kind: 'file_list',
      ref: `${files.length} file(s)`,
      status: files.length > 0 ? 'included' : 'empty',
      chars: fileList.length,
    });

    const missingRefs = sources
      .filter((s) => s.status === 'unreachable' || s.status === 'unsupported')
      .map((s) => s.ref);

    return {
      prompt: {
        repoFullName,
        prNumber: pull.number,
        title: pull.title,
        description,
        issues,
        docs,
        fileList,
        missingRefs,
      },
      sources,
    };
  }
}
