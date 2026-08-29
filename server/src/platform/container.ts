import type {
  AuthProvider,
  SecretsProvider,
  GitHubClient,
  GitClient,
  CodeIndex,
  Embedder,
  LLMProvider,
} from '@devdigest/shared';
import type { AppConfig } from './config.js';
import type { Db } from '../db/client.js';
import { JobRunner } from './jobs.js';
import { runBus, type RunBus } from './sse.js';
import { LocalSecretsProvider } from '../adapters/secrets/local.js';
import { LocalNoAuthProvider } from '../adapters/auth/local.js';
import { OctokitGitHubClient } from '../adapters/github/octokit.js';
import { SimpleGitClient } from '../adapters/git/simple-git.js';
import { RipgrepCodeIndex } from '../adapters/codeindex/ripgrep.js';
import { OpenAIProvider } from '../adapters/llm/openai.js';
import { AnthropicProvider } from '../adapters/llm/anthropic.js';
import { OpenAIEmbedder } from '../adapters/embedder/openai.js';
import { OpenRouterProvider } from '@devdigest/reviewer-core';
import { estimateCost } from '../adapters/llm/pricing.js';
import { PriceBook } from './price-book.js';
import { ConfigError } from './errors.js';
import { AgentsRepository } from '../modules/agents/repository.js';
import { ReviewRepository } from '../modules/reviews/repository.js';
import { RepoRepository } from '../modules/repos/repository.js';
import { PullsRepository } from '../modules/pulls/repository.js';
import { ConventionsRepository } from '../modules/conventions/repository.js';
import type { ReviewRunner } from '../modules/reviews/types.js';
import { ReviewService } from '../modules/reviews/service.js';
import type { RepoIntel } from '../modules/repo-intel/types.js';
import { RepoIntelService } from '../modules/repo-intel/service.js';
import type { IntentFacade } from '../modules/intent/types.js';
import { IntentService } from '../modules/intent/service.js';
import type { BlastFacade } from '../modules/blast/types.js';
import { BlastService } from '../modules/blast/service.js';
import type { SmartDiffFacade } from '../modules/smart-diff/types.js';
import { SmartDiffService } from '../modules/smart-diff/service.js';
import type { BriefFacade } from '../modules/brief/types.js';
import { BriefService } from '../modules/brief/service.js';
import { BriefRepository } from '../modules/brief/repository.js';
import type { EvalFacade } from '../modules/eval/types.js';
import { EvalService } from '../modules/eval/service.js';
import { EvalRepository } from '../modules/eval/repository.js';
import type {
  ProjectContextDocs,
  ProjectContextFacade,
} from '../modules/project-context/types.js';
import { ProjectContextService } from '../modules/project-context/service.js';
import { FsProjectContextDocs } from '../adapters/projectcontext/fs.js';
import { SkillsRepository } from '../modules/skills/repository.js';
import { type DepGraph, DepCruiseGraph } from '../adapters/depgraph/index.js';
import { type Tokenizer, TiktokenTokenizer } from '../adapters/tokenizer/index.js';

/**
 * DI container. One per app instance. Holds config, db, the JobRunner,
 * the SSE bus, and lazily-constructed adapters resolved through SecretsProvider.
 *
 * Tests construct a container with `overrides` to inject mock adapters; the
 * Services depend on these interfaces, not the concrete classes.
 */
export interface ContainerOverrides {
  secrets?: SecretsProvider;
  auth?: AuthProvider;
  github?: GitHubClient;
  git?: GitClient;
  codeIndex?: CodeIndex;
  embedder?: Embedder;
  /** Pre-built providers by id (skip key lookup). */
  llm?: Partial<Record<'openai' | 'anthropic' | 'openrouter', LLMProvider>>;
  /** repo-intel facade (T1.1+) — tests inject mock RepoIntel implementations. */
  repoIntel?: RepoIntel;
  /** intent facade — tests inject mock IntentFacade implementations. */
  intent?: IntentFacade;
  /** blast facade — tests inject mock BlastFacade implementations. */
  blast?: BlastFacade;
  /** smart-diff facade — tests inject mock SmartDiffFacade implementations. */
  smartDiff?: SmartDiffFacade;
  /** brief facade — tests inject mock BriefFacade implementations. */
  brief?: BriefFacade;
  /**
   * `pr_brief` persistence — tests inject a recording double to assert on what
   * was (or was not) written. Present because `briefRepo`'s own doc comment
   * promises this seam, and AC-38's "no brief was persisted" assertion is the
   * thing that needs it.
   */
  briefRepo?: BriefRepository;
  /** eval facade — tests inject mock EvalFacade implementations. */
  eval?: EvalFacade;
  /**
   * `eval_cases` + `eval_runs` persistence — tests inject a recording/throwing
   * double (AC-NF-11's "insert throws after k rows" needs this seam; an
   * unwired one would make an inertness assertion pass vacuously —
   * `server/INSIGHTS.md`, 2026-08-28).
   */
  evalRepo?: EvalRepository;
  /** project-context document discovery/read — tests inject MockProjectContextDocs. */
  projectContextDocs?: ProjectContextDocs;
  /** project-context facade — the reviews run-executor resolves through this. */
  projectContext?: ProjectContextFacade;
  /** reviews facade — tests inject mock ReviewRunner implementations. */
  reviewRunner?: ReviewRunner;
  /** repo-intel T3 adapters — only the indexer pipeline reads these. */
  depgraph?: DepGraph;
  tokenizer?: Tokenizer;
}

export class Container {
  readonly config: AppConfig;
  readonly db: Db;
  readonly secrets: SecretsProvider;
  readonly auth: AuthProvider;
  readonly jobs: JobRunner;
  readonly runBus: RunBus;

  private _git?: GitClient;
  private _github?: GitHubClient;
  private _codeIndex?: CodeIndex;
  private _embedder?: Embedder;
  private llmCache = new Map<string, LLMProvider>();

  // Shared repositories for cross-cutting entities (agents, reviews/pulls,
  // runs). Constructed here, in the composition root, so consuming modules use
  // `container.agentsRepo` instead of reaching into another module's folder.
  private _agentsRepo?: AgentsRepository;
  private _skillsRepo?: SkillsRepository;
  private _reviewRepo?: ReviewRepository;
  private _reposRepo?: RepoRepository;
  private _pullsRepo?: PullsRepository;
  private _conventionsRepo?: ConventionsRepository;
  private _repoIntel?: RepoIntel;
  private _intent?: IntentFacade;
  private _blast?: BlastFacade;
  private _smartDiff?: SmartDiffFacade;
  private _brief?: BriefFacade;
  private _briefRepo?: BriefRepository;
  private _eval?: EvalFacade;
  private _evalRepo?: EvalRepository;
  private _projectContextDocs?: ProjectContextDocs;
  private _projectContext?: ProjectContextFacade;
  private _reviewRunner?: ReviewRunner;
  private _depgraph?: DepGraph;
  private _tokenizer?: Tokenizer;
  private _priceBook?: PriceBook;

  constructor(config: AppConfig, db: Db, private overrides: ContainerOverrides = {}) {
    this.config = config;
    this.db = db;
    this.secrets = overrides.secrets ?? new LocalSecretsProvider(config.secretsPath);
    this.auth = overrides.auth ?? new LocalNoAuthProvider(db);
    this.runBus = runBus;
    this.jobs = new JobRunner(db);
  }

  get git(): GitClient {
    if (this.overrides.git) return this.overrides.git;
    this._git ??= new SimpleGitClient(this.config.cloneDir);
    return this._git;
  }

  get agentsRepo(): AgentsRepository {
    return (this._agentsRepo ??= new AgentsRepository(this.db));
  }

  /**
   * `skills` + `skill_versions` + `skill_context_docs`. Shared: the skills
   * module owns them, project-context resolution reads them on the run path.
   */
  get skillsRepo(): SkillsRepository {
    return (this._skillsRepo ??= new SkillsRepository(this.db));
  }

  get reviewRepo(): ReviewRepository {
    return (this._reviewRepo ??= new ReviewRepository(this.db));
  }

  /** `repos` table. Shared: workspace/polling read it, repos owns it. */
  get reposRepo(): RepoRepository {
    return (this._reposRepo ??= new RepoRepository(this.db));
  }

  /** `pull_requests` + PR files/commits. Shared: polling imports through it. */
  get pullsRepo(): PullsRepository {
    return (this._pullsRepo ??= new PullsRepository(this.db));
  }

  /** `conventions` table. Shared: conventions owns it, MCP reads it. */
  get conventionsRepo(): ConventionsRepository {
    return (this._conventionsRepo ??= new ConventionsRepository(this.db));
  }

  get codeIndex(): CodeIndex {
    if (this.overrides.codeIndex) return this.overrides.codeIndex;
    this._codeIndex ??= new RipgrepCodeIndex(this.git);
    return this._codeIndex;
  }

  /**
   * The repo-intel facade (T1.1). All higher-level features (reviews,
   * blast/onboarding migrations, phantom-gate) code against this interface.
   * Tests inject a mock via `ContainerOverrides.repoIntel`.
   */
  get repoIntel(): RepoIntel {
    if (this.overrides.repoIntel) return this.overrides.repoIntel;
    this._repoIntel ??= new RepoIntelService(this);
    return this._repoIntel;
  }

  /**
   * The intent facade. The review run-executor resolves a PR's derived intent
   * through this interface; tests inject a mock via `ContainerOverrides.intent`.
   */
  get intent(): IntentFacade {
    if (this.overrides.intent) return this.overrides.intent;
    this._intent ??= new IntentService(this);
    return this._intent;
  }

  /**
   * The blast facade. The route and any cross-module reader (the brief) resolve
   * the Blast Radius panel through this interface rather than constructing the
   * service; tests inject a mock via `ContainerOverrides.blast`.
   */
  get blast(): BlastFacade {
    if (this.overrides.blast) return this.overrides.blast;
    this._blast ??= new BlastService(this.pullsRepo, this.repoIntel);
    return this._blast;
  }

  /**
   * The smart-diff facade. Same shape as `blast`: the route and any
   * cross-module reader go through this interface; tests inject a mock via
   * `ContainerOverrides.smartDiff`.
   */
  get smartDiff(): SmartDiffFacade {
    if (this.overrides.smartDiff) return this.overrides.smartDiff;
    this._smartDiff ??= new SmartDiffService(this.pullsRepo, this.reviewRepo);
    return this._smartDiff;
  }

  /**
   * `pr_brief`. The brief module owns the table; the repository is constructed
   * here rather than inside `BriefService` so the hermetic harness has a seam to
   * inject a recording double through (an unwired one would make an
   * "is the feature inert?" assertion pass vacuously — `server/INSIGHTS.md`,
   * 2026-08-28).
   */
  get briefRepo(): BriefRepository {
    if (this.overrides.briefRepo) return this.overrides.briefRepo;
    return (this._briefRepo ??= new BriefRepository(this.db));
  }

  /**
   * The brief facade. The routes and the AC-38 inertness test reach the PR
   * Brief through this interface; tests inject a mock via
   * `ContainerOverrides.brief`.
   */
  get brief(): BriefFacade {
    if (this.overrides.brief) return this.overrides.brief;
    this._brief ??= new BriefService(this);
    return this._brief;
  }

  /**
   * `eval_cases` + `eval_runs`. The eval module owns the tables; the
   * repository is constructed here (the `briefRepo` precedent) so the test
   * harness has a seam for a recording/throwing double.
   */
  get evalRepo(): EvalRepository {
    if (this.overrides.evalRepo) return this.overrides.evalRepo;
    return (this._evalRepo ??= new EvalRepository(this.db));
  }

  /**
   * The eval facade. Routes and tests reach the eval pipeline through this
   * interface; tests inject a mock via `ContainerOverrides.eval`. The getter
   * memoizes ONE instance per app — the service's per-agent in-flight lock
   * (AC-29) depends on that.
   */
  get eval(): EvalFacade {
    if (this.overrides.eval) return this.overrides.eval;
    this._eval ??= new EvalService(this);
    return this._eval;
  }

  /**
   * The reviews facade. Callers outside the reviews module start, watch, cancel
   * and read review runs through this interface; tests inject a mock via
   * `ContainerOverrides.reviewRunner`.
   */
  get reviewRunner(): ReviewRunner {
    if (this.overrides.reviewRunner) return this.overrides.reviewRunner;
    this._reviewRunner ??= new ReviewService(this);
    return this._reviewRunner;
  }

  /**
   * Project-context document discovery over the repository checkout. The clone
   * location comes from the git client so it stays defined in one place.
   */
  get projectContextDocs(): ProjectContextDocs {
    if (this.overrides.projectContextDocs) return this.overrides.projectContextDocs;
    this._projectContextDocs ??= new FsProjectContextDocs((repo) => this.git.clonePathFor(repo));
    return this._projectContextDocs;
  }

  /**
   * The project-context facade. The review run-executor resolves an agent's
   * attached documents through this interface rather than importing the
   * project-context module's service; tests inject a mock via
   * `ContainerOverrides.projectContext`.
   */
  get projectContext(): ProjectContextFacade {
    if (this.overrides.projectContext) return this.overrides.projectContext;
    this._projectContext ??= new ProjectContextService(this);
    return this._projectContext;
  }

  /** Import-graph builder (dependency-cruiser). T3 indexer pipeline only. */
  get depgraph(): DepGraph {
    if (this.overrides.depgraph) return this.overrides.depgraph;
    this._depgraph ??= new DepCruiseGraph();
    return this._depgraph;
  }

  /** Token counter (js-tiktoken) for the repo-map budget search. */
  get tokenizer(): Tokenizer {
    if (this.overrides.tokenizer) return this.overrides.tokenizer;
    this._tokenizer ??= new TiktokenTokenizer();
    return this._tokenizer;
  }

  /**
   * Live OpenRouter pricing for cost attribution. The lister builds a bare
   * OpenRouter provider just for `/models` (no estimator needed) and degrades to
   * `[]` when no key is configured; the static `estimateCost` table is the
   * fallback for OpenAI/Anthropic and a cold/cold-failed cache.
   */
  get priceBook(): PriceBook {
    this._priceBook ??= new PriceBook(async () => {
      try {
        const key = await this.secrets.get('OPENROUTER_API_KEY');
        if (!key) return [];
        return await new OpenRouterProvider(key).listModels();
      } catch {
        return [];
      }
    }, estimateCost);
    return this._priceBook;
  }

  async github(): Promise<GitHubClient> {
    if (this.overrides.github) return this.overrides.github;
    if (this._github) return this._github;
    const token = await this.secrets.get('GITHUB_TOKEN');
    if (!token) throw new ConfigError('GITHUB_TOKEN is not configured');
    this._github = new OctokitGitHubClient(token);
    return this._github;
  }

  /** Resolve an LLM provider by id; constructs from the secret key, cached. */
  async llm(id: 'openai' | 'anthropic' | 'openrouter'): Promise<LLMProvider> {
    const injected = this.overrides.llm?.[id];
    if (injected) return injected;
    const cached = this.llmCache.get(id);
    if (cached) return cached;
    const provider = await this.buildLlm(id);
    this.llmCache.set(id, provider);
    return provider;
  }

  private async buildLlm(id: 'openai' | 'anthropic' | 'openrouter'): Promise<LLMProvider> {
    if (id === 'openai') {
      const key = await this.secrets.get('OPENAI_API_KEY');
      if (!key) throw new ConfigError('OPENAI_API_KEY is not configured');
      return new OpenAIProvider(key);
    }
    if (id === 'openrouter') {
      // Single OpenRouter provider lives in reviewer-core (shared with the CI
      // runner); inject the PriceBook so cost attribution uses LIVE OpenRouter
      // prices (with the static table as a fallback) rather than a hardcoded one.
      const key = await this.secrets.get('OPENROUTER_API_KEY');
      if (!key) throw new ConfigError('OPENROUTER_API_KEY is not configured');
      return new OpenRouterProvider(key, {
        estimateCost: (model, tokensIn, tokensOut) =>
          this.priceBook.estimate(model, tokensIn, tokensOut),
      });
    }
    const key = await this.secrets.get('ANTHROPIC_API_KEY');
    if (!key) throw new ConfigError('ANTHROPIC_API_KEY is not configured');
    return new AnthropicProvider(key);
  }

  async embedder(): Promise<Embedder> {
    // Injected embedders (tests) always win. Otherwise embeddings are gated by
    // config: when disabled we throw BEFORE constructing the OpenAI client, so
    // the app makes ZERO OpenAI requests. All callers wrap this in try/catch and
    // degrade gracefully (memory/RAG simply returns no hits).
    if (this.overrides.embedder) return this.overrides.embedder;
    if (!this.config.embeddingsEnabled) {
      throw new ConfigError('Embeddings are disabled (set EMBEDDINGS_ENABLED=true to enable memory/RAG)');
    }
    if (this._embedder) return this._embedder;
    const openai = await this.llm('openai');
    this._embedder = new OpenAIEmbedder(openai);
    return this._embedder;
  }

  /**
   * Drop cached provider clients so the next resolve picks up changed secrets.
   * Call after persisting a new API key/PAT via SecretsProvider.set.
   */
  invalidateSecretCaches(): void {
    this.llmCache.clear();
    this._github = undefined;
    this._embedder = undefined;
  }
}
