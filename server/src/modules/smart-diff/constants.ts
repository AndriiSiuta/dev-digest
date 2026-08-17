/**
 * Smart Diff — every threshold and pattern the classifier / sort / split logic
 * uses lives here, nothing inline in `classifier.ts` or `helpers.ts`.
 *
 * Smart Diff makes NO model call: it is a pure recombination of already
 * -imported PR files (`pr_files`) and already-computed review findings.
 */

/** Groups are always emitted in this order, even when a group is empty. */
export const ROLE_ORDER = ['core', 'wiring', 'boilerplate'] as const;

/**
 * Lockfile basenames, matched case-insensitively against the basename at any
 * depth — a lockfile is always `boilerplate` regardless of where it lives.
 */
export const LOCKFILE_BASENAMES = new Set<string>([
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
]);

/**
 * Generated / build-output / vendored paths — never worth a reviewer's time.
 * Checked BEFORE the wiring patterns, so `dist/index.js` classifies
 * `boilerplate` even though it also looks like a barrel file.
 */
export const BOILERPLATE_PATH_PATTERNS: RegExp[] = [
  // Build output / vendored / generated directories, at any depth.
  /(^|\/)(dist|build|out|target|coverage|vendor|third_party|node_modules|__generated__|generated|__snapshots__)(\/|$)/,
  /\.snap$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  // `foo.generated.ts`, `foo.gen.ts`, `foo.g.dart`, `foo.pb.go`, …
  /\.(generated|gen|g|pb)\.[^./]+$/,
  /_pb2\.py$/,
  /(^|\/)migrations\/meta\/[^/]*_snapshot\.json$/,
  // Binary / asset extensions.
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|tar|gz|tgz|rar|7z|woff2?|ttf|eot|otf|mp3|mp4|mov|avi|wasm|exe|dll|so|dylib|class|jar|bin)$/i,
  /(^|\/)changelog(\.[^/]+)?$/i,
  /(^|\/)license(\.[^/]+)?$/i,
];

/**
 * Config / infra / docs — real but not reviewer-attention-worthy. Checked
 * after the boilerplate patterns, so a generated-output file never lands here.
 */
export const WIRING_PATH_PATTERNS: RegExp[] = [
  // Barrel re-export files.
  /(^|\/)index\.[^/]+$/,
  /\.config\.[^/]+$/,
  // rc-files: `.eslintrc`, `.eslintrc.js`, `.npmrc`, `.nvmrc`, …
  /(^|\/)\.[^/]*rc(\.[^/]+)?$/,
  /(^|\/)\.env($|\.)/,
  /(^|\/)(dockerfile|makefile|procfile)(\.[^/]+)?$/i,
  /(^|\/)docker-compose(\.[^/]+)*\.ya?ml$/i,
  /(^|\/)\.(github|gitlab|circleci)\//,
  /\.(yaml|yml|toml|ini|properties)$/,
  /(^|\/)package\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)go\.mod$/,
  /(^|\/)gemfile(\.[^/]+)?$/i,
  /(^|\/)pom\.xml$/,
  /(^|\/)build\.gradle[^/]*$/,
  /\.(csproj|sln)$/,
  /(^|\/)migrations\/[^/]+\.sql$/,
  /(^|\/)migrations\/meta\/_journal\.json$/,
  /\.d\.ts$/,
  // Docs.
  /\.(md|mdx|rst|txt)$/i,
  /(^|\/)docs\//i,
  // Any other dotfile not already matched above (`.editorconfig`, `.gitignore`, …).
  /(^|\/)\.[^/]+$/,
];

/**
 * Secondary sort signal only — a test file is still classified `core`. Used
 * for the "source before tests" tiebreak within a group.
 */
export const TEST_PATH_PATTERNS: RegExp[] = [
  /\.(test|spec)\.[^/]+$/,
  /(^|\/)(__tests__|tests)\//,
  /(^|\/)fixtures\//,
];

/** Higher rank sorts first. */
export const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 3,
  WARNING: 2,
  SUGGESTION: 1,
};

/** Split-suggestion thresholds, over `core` + `wiring` files only. */
export const SPLIT_TOO_BIG_LINES = 400;
export const SPLIT_TOO_BIG_FILES = 20;
/** Group files by their top N path segments. */
export const SPLIT_KEY_DEPTH = 2;
/** Fewer distinct keys than this and a split isn't a meaningful suggestion. */
export const SPLIT_MIN_KEYS = 2;
