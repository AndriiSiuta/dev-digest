import type {
  Brief,
  BlastPanel,
  BriefMissingInput,
  PrBriefRecord,
  PrIntentRecord,
  RepoRef,
  SmartDiffResponse,
} from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import { describeSections } from '../../platform/prompt-log.js';
import type { PinoLike } from '../../platform/run-logger.js';
import { DEFAULT_SEARCH_ROOTS } from '../project-context/constants.js';
import { resolveFeatureModel } from '../settings/feature-models.js';
import {
  BRIEF_MAX_TOKENS,
  BRIEF_SCHEMA_NAME,
  BRIEF_SECTION_SOURCE,
  BRIEF_TEMPERATURE,
  BRIEF_TIMEOUT_MS,
} from './constants.js';
import { groundBrief } from './grounding.js';
import {
  computeRiskLevel,
  endpointsOf,
  selectSpecDocs,
  toDegraded,
  toMissingInputs,
} from './helpers.js';
import { BriefDraftSchema, SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import type { StoredBrief } from './repository.js';
import type {
  BriefFacade,
  BriefFacts,
  BriefPull,
  BriefPullsRepo,
  BriefRepo,
  BriefReposRepo,
  BriefReviewRepo,
} from './types.js';

/**
 * PR Brief — gather (code) → ONE structured model call → ground (code) →
 * persist. Nothing here recomputes an input: the intent record, the blast
 * panel, the Smart Diff classification and the repository's spec documents are
 * all read from the systems that already own them (AC-02).
 *
 * It takes the whole `Container`, as `IntentService` and `ProjectContextService`
 * do. `onion-architecture` prefers narrow dependencies for a NEW service and
 * that is the better default — but `resolveFeatureModel(container, …)` takes a
 * `Container` by signature (`modules/settings/feature-models.ts:51`), and this
 * service legitimately touches eight capabilities. A narrow port set would be
 * eight interfaces plus a second seam for the model resolver, for no testing
 * gain over `ContainerOverrides`. The repository reads still go through this
 * module's own narrow ports (`types.ts`), so no sibling data layer is named.
 */
export class BriefService implements BriefFacade {
  constructor(private container: Container) {}

  private get pullsRepo(): BriefPullsRepo {
    return this.container.pullsRepo;
  }

  private get reviewRepo(): BriefReviewRepo {
    return this.container.reviewRepo;
  }

  private get reposRepo(): BriefReposRepo {
    return this.container.reposRepo;
  }

  /** The stored brief, if any. Never makes a model call (AC-40). */
  async get(workspaceId: string, prId: string): Promise<PrBriefRecord | undefined> {
    const pull = await this.requirePull(workspaceId, prId);
    const stored = await this.container.briefRepo.getBrief(prId);
    if (!stored) return undefined;
    return toRecord(prId, pull, stored);
  }

  /**
   * Generate the PR's brief, or return the cached one.
   *
   * `logger` is required — see `BriefFacade`. A throw anywhere before
   * `saveBrief` leaves a previously persisted brief untouched (AC-15), because
   * the write is the last thing that happens and there is only one of it.
   */
  async generate(
    workspaceId: string,
    prId: string,
    opts: { force: boolean; logger: PinoLike; correlationId?: string },
  ): Promise<PrBriefRecord> {
    const pull = await this.requirePull(workspaceId, prId);
    const repo = await this.pullsRepo.getRepoById(pull.repoId);
    if (!repo) throw new NotFoundError('Repository not found');

    // AC-11 — a stored brief at the current head is returned as it stands, with
    // no model call, unless regeneration was asked for explicitly (AC-12).
    const stored = await this.container.briefRepo.getBrief(prId);
    if (!opts.force && stored && stored.headSha === pull.headSha) {
      return toRecord(prId, pull, stored);
    }

    // AC-14 — a PR with no recorded files must cost NOTHING, so this guard sits
    // ahead of blast, intent, Smart Diff and the documents rather than after
    // any of them. The changed-path list is read as `{ path }` only; `patch` is
    // never named, which is what makes AC-03 structural.
    const changedPaths = (await this.pullsRepo.getFiles(prId)).map((f) => f.path);
    if (changedPaths.length === 0) {
      return {
        pr_id: prId,
        brief: {
          what: 'This pull request has no recorded file changes.',
          why: '',
          risk_level: 'none',
          risks: [],
          review_focus: [],
          // Nothing was unavailable — the PR simply has no files, which is a
          // fact about it rather than a degraded input (AC-32).
          degraded: false,
          missing_inputs: [],
        },
        head_sha: pull.headSha,
        pr_head_sha: pull.headSha,
        model: null,
        generated_at: new Date().toISOString(),
      };
    }

    const facts = await this.gather(workspaceId, pull, repo, changedPaths);
    const { user, kept, droppedPriorities } = buildUserPrompt(facts);

    const choice = await resolveFeatureModel(this.container, workspaceId, 'risk_brief');
    const llm = await this.container.llm(choice.provider);
    const result = await llm.completeStructured({
      model: choice.model,
      schema: BriefDraftSchema,
      schemaName: BRIEF_SCHEMA_NAME,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      temperature: BRIEF_TEMPERATURE,
      maxTokens: BRIEF_MAX_TOKENS,
      timeoutMs: BRIEF_TIMEOUT_MS,
    });

    // Gate FIRST, level second: the level is the maximum severity over the
    // risks that survived, and the model's own `risk_level` is never read
    // (AC-30, AC-31). Grounding runs against the PR's FULL changed-path list,
    // not the Smart Diff path set — Smart Diff may legitimately omit a changed
    // file (binary, oversized, unparseable), and grounding against its output
    // would drop a risk citing a real-but-unclassified file (AC-06, AC-07).
    const grounded = groundBrief(result.data, {
      files: new Set(changedPaths),
      endpoints: endpointsOf(facts.blast),
    });
    const missing = toMissingInputs(facts.missing);
    const brief: Brief = {
      what: result.data.what,
      why: result.data.why,
      risk_level: computeRiskLevel(grounded.risks),
      risks: grounded.risks,
      review_focus: grounded.reviewFocus,
      degraded: toDegraded(missing),
      missing_inputs: missing,
    };

    await this.container.briefRepo.saveBrief(prId, {
      brief,
      headSha: pull.headSha,
      model: result.model,
    });

    // One structured line per generation. Sizes, provenance labels, refs and
    // ids only — never a title, a body, an issue, a document, a prompt section
    // or model output (AC-NF-02); `describeSections`' return types have no
    // field able to hold section content, so that half is structural.
    //
    // `dropped` carries the FULL {target, ref, reason} records rather than a
    // count: a count says something was caught but not what, which defeats
    // AC-09's purpose. A `ref` is a file path, an endpoint string, a focus-item
    // file or a risk's ordinal — identifiers, the same class `IntentSource.ref`
    // already logs — and a `reason` is one of a fixed set of gate strings. Do
    // not "fix" this back to counts.
    opts.logger.info(
      {
        feature: 'risk_brief',
        ...describeSections(
          [
            { section: 'system', source: BRIEF_SECTION_SOURCE.system, text: SYSTEM_PROMPT },
            ...kept.map((s) => ({
              section: s.section,
              source: BRIEF_SECTION_SOURCE[s.section],
              text: s.text,
            })),
          ],
          {
            correlationId: opts.correlationId ?? prId,
            model: result.model,
            provider: choice.provider,
            verbose: this.container.config.promptLogVerbose,
            count: (s) => this.container.tokenizer.count(s),
          },
        ),
        missing_inputs: missing,
        dropped_section_priorities: droppedPriorities,
        dropped: grounded.dropped,
        token_estimate: this.container.tokenizer.count(`${SYSTEM_PROMPT}\n${user}`),
        tokens_in: result.tokensIn,
        tokens_out: result.tokensOut,
        cost_usd: result.costUsd,
      },
      'brief: generated',
    );

    const saved = await this.container.briefRepo.getBrief(prId);
    // The row was just written; a miss here is a bug, not a 404.
    if (!saved) throw new Error('Brief vanished after upsert');
    return toRecord(prId, pull, saved);
  }

  /** AC-13 / AC-NF-01 — a PR outside the requesting workspace is a 404. */
  private async requirePull(workspaceId: string, prId: string): Promise<BriefPull> {
    const pull = await this.pullsRepo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    return pull;
  }

  /**
   * Every remaining input, best-effort: a failure becomes a `missing_inputs`
   * entry rather than a throw, so the brief degrades instead of failing (AC-32).
   * Each source is called EXACTLY ONCE per generate (AC-02).
   */
  private async gather(
    workspaceId: string,
    pull: BriefPull,
    repo: BriefRepo,
    changedPaths: string[],
  ): Promise<BriefFacts> {
    const missing: BriefMissingInput[] = [];

    // Classification and diff STATISTICS only — `SmartDiffResponse` carries no
    // patch field, so there is nothing here to leak into the prompt.
    let smartDiff: SmartDiffResponse | undefined;
    try {
      smartDiff = await this.container.smartDiff.get(workspaceId, pull.id);
    } catch {
      missing.push({ kind: 'smart_diff', status: 'unreachable' });
    }

    // The persisted record, read directly. `container.intent.getOrClassify` is
    // never called from here and the intent facade is never imported — that is
    // what keeps "one model call" literally true (AC-29). `IntentService.get`
    // is itself this same read (`modules/intent/service.ts:46`), so nothing is
    // duplicated.
    let intent: PrIntentRecord | undefined;
    try {
      intent = await this.reviewRepo.getIntent(pull.id);
      if (!intent) missing.push({ kind: 'intent', status: 'absent' });
    } catch {
      missing.push({ kind: 'intent', status: 'unreachable' });
    }

    let blast: BlastPanel | undefined;
    try {
      blast = await this.container.blast.get(workspaceId, pull.id);
      if (blast.degraded) missing.push({ kind: 'blast', status: 'degraded' });
    } catch {
      missing.push({ kind: 'blast', status: 'unreachable' });
    }

    // The WHOLE document step sits inside one try, `getSearchRoots` included:
    // an unwrapped roots lookup that throws would fail the entire generate and
    // break the best-effort contract AC-32 rests on. An EMPTY result with no
    // throw records nothing at all (AC-36).
    let docs: { path: string; text: string }[] = [];
    try {
      const roots =
        (await this.reposRepo.getSearchRoots(workspaceId, pull.repoId)) ?? [...DEFAULT_SEARCH_ROOTS];
      const ref: RepoRef = { owner: repo.owner, name: repo.name };
      const listed = await this.container.projectContextDocs.list(ref, roots);
      for (const doc of selectSpecDocs(listed)) {
        docs.push({
          path: doc.path,
          text: await this.container.projectContextDocs.read(ref, roots, doc.path),
        });
      }
    } catch {
      docs = [];
      missing.push({ kind: 'project_context', status: 'unreachable' });
    }

    return { pull, repo, changedPaths, intent, blast, smartDiff, docs, missing };
  }
}

/** The wire envelope: what the brief was generated against, plus the PR's head. */
function toRecord(prId: string, pull: BriefPull, stored: StoredBrief): PrBriefRecord {
  return {
    pr_id: prId,
    brief: stored.brief,
    head_sha: stored.headSha,
    pr_head_sha: pull.headSha,
    model: stored.model,
    generated_at: stored.generatedAt.toISOString(),
  };
}
