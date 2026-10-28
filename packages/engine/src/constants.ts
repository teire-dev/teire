/** Every tunable number in one place. Values come from the build plan's decisions. */

export const TOKENFACTORY = {
  /** OpenAI-compatible base URL (Token Factory quickstart). */
  defaultBaseUrl: "https://api.tokenfactory.nebius.com/v1/",
  /** AI SDK provider name; provider options are keyed by it (providerOptions.tokenfactory). */
  providerName: "tokenfactory",
  /** Attempts per request on 429/5xx/dropped connections (S10), backoff doubling from this. */
  attempts: 4,
  backoffMs: 2000,
  maxRetryAfterMs: 30_000,
  /** A model that keeps failing is skipped for this long; its requests go to the failover model. */
  unhealthyForMs: 10 * 60_000,
} as const;

/** NVIDIA Nemotron settings from the Nemotron 3 Super model card. */
export const NEMOTRON = {
  temperature: 1.0,
  topP: 0.95,
} as const;

/**
 * Model per job, chosen on results, not price (scripts/compare-models.ts, 2026-10-24):
 * agent  — writes and repairs code (Ultra: 3/3 correct fixes vs Super 2/3);
 * reader — extraction and triage, reasoning on (Ultra: 29/29 records on every run);
 * failover — used only while the other model is unavailable (Super).
 */
export const MODEL_ENV = {
  agent: "TEIRE_MODEL_AGENT",
  reader: "TEIRE_MODEL_READER",
  failover: "TEIRE_MODEL_FAILOVER",
} as const;

/** The same choice when its env var is unset (the CLI, run with only a Token Factory key). */
export const MODEL_DEFAULTS: Record<keyof typeof MODEL_ENV, string> = {
  agent: "nvidia/Nemotron-3-Ultra-550b-a55b",
  reader: "nvidia/Nemotron-3-Ultra-550b-a55b",
  failover: "nvidia/nemotron-3-super-120b-a12b",
};

export const FIX = {
  /** Lines kept after an error line, up to the next blank line (a rustc diagnostic with its `help:`). */
  errorContextLines: 30,
  maxErrorLines: 220,
  /** Failed verifications before the agent discards its plan and starts over from the evidence. */
  replanAfterFailures: 2,
  /** Fix attempts at one target version before falling back one major (plan D71). */
  maxAttemptsPerTarget: 4,
  /** How many majors Teire may step back from the latest before stopping with "needs a human". */
  maxTargetFallbacks: 2,
  /** Agent tool-loop step cap per attempt. */
  maxAgentSteps: 24,
  /** Docs text handed to the agent per lookup. */
  maxDocsChars: 12_000,
  /** File text returned per read, and check output returned per run (tool output is data). */
  maxReadChars: 24_000,
  maxCheckOutputChars: 8_000,
  maxSearchHits: 60,
  /** Diff text handed to the review of a passing fix; review rounds before the rest goes under risks. */
  maxReviewDiffChars: 40_000,
  reviewRounds: 1,
  /** Output cap per agent step. */
  maxOutputTokens: 16_000,
} as const;

/**
 * Evidence decides the pull request (spec rule 13), never a model score:
 * only `verified` opens a ready PR; weaker evidence opens a draft that states what was not covered;
 * the rest open a "needs a human" issue with exact steps.
 */
export const PR_MODE_BY_EVIDENCE = {
  verified: "ready",
  typecheck_only: "draft",
  pre_existing_failure: "draft",
  needs_live_access: "draft",
  needs_local_service: "draft",
  environment_mismatch: "draft",
  regression: "issue",
  unverified: "issue",
  timeout: "issue",
} as const;
export type EvidenceKind = keyof typeof PR_MODE_BY_EVIDENCE;

export const PULL_REQUESTS = {
  /** Compare-and-swap attempts when a refreshed branch moved under Teire (review R4). */
  refSwapAttempts: 3,
  maxOpenPerRepo: 5,
  maxNewPerHour: 2,
  /** New "needs a human" issues one scan may open; the Dashboard issue lists the rest. */
  maxHumanIssuesPerScan: 3,
  /** GitHub's PR body limit. */
  bodyMaxChars: 65_536,
  /** GitHub check-run annotations per request. */
  annotationsPerCall: 50,
  branchPrefix: "teire",
  /** Base64 payload above which a commit goes through the Git Data API instead of GraphQL. */
  maxGraphqlCommitBytes: 5 * 1024 * 1024,
  /** Call sites shown per finding in a PR body before "and N more". */
  maxSitesPerFinding: 12,
  labels: ["teire"],
} as const;

export const RUNS = {
  /** Runs without a heartbeat for this long are failed by the reaper. */
  staleAfterMs: 10 * 60 * 1000,
  /** Another worker may take a running run only once its heartbeat is this old (review R13). */
  leaseMs: 2 * 60 * 1000,
  /** How long a worker that found the run held waits before looking again. */
  leaseRetrySeconds: 60,
  heartbeatEveryMs: 15 * 1000,
  /**
   * Fix runs the worker takes at once, each from a different repository (the queue keeps one per
   * repository in order). Each holds two sandboxes (Token Factory allows 50 per project) and up to
   * about 1 GB of the worker's 4 GB while it diffs an API; the resolver service queues its own jobs.
   */
  fixConcurrency: 3,
  /** The run page polls this often while a run is active. */
  pollEveryMs: 1000,
} as const;

export const SCAN = {
  /** Largest repository tarball Teire will extract. */
  maxTarballBytes: 200 * 1024 * 1024,
  maxFiles: 20_000,
  /** Largest single file extracted from any archive (repos, package tarballs, wheels). */
  maxFileBytes: 50 * 1024 * 1024,
  /** Total bytes written when extracting one archive. */
  maxExtractedBytes: 1024 * 1024 * 1024,
  /** Sources older than this make verdicts "inconclusive" instead of "not affected". */
  staleSourceAfterMs: 14 * 24 * 60 * 60 * 1000,
} as const;

export const PUBLIC_LIMITS = {
  scansPerUserPerDay: 3,
  dryRunsPerUserPerDay: 1,
  /** GitHub's `size` (KB) above which a public scan is refused: the tarball and its install would not fit. */
  maxRepoKb: 300 * 1024,
} as const;

export const GITHUB = {
  /** Installation tokens last 1 h; refresh before that. */
  tokenRefreshMarginMs: 5 * 60 * 1000,
  /** Secondary rate limit: content-creating requests per minute. */
  contentWritesPerMinute: 80,
  webhookRedeliveryWindowMs: 3 * 24 * 60 * 60 * 1000,
} as const;

export const CATALOG = {
  userAgent: "TeireBot/0.1 (+https://teire.vercel.app; provider change sources)",
  fetchTimeoutMs: 20_000,
  /**
   * A provider's change sources are read when a scanned repo uses the provider, and reused by every
   * repo for this long (D82); nothing is read on a schedule.
   */
  freshForMs: 6 * 60 * 60 * 1000,
  /** A source that has not been read successfully for this long is shown as stale. */
  staleAfterMs: 24 * 60 * 60 * 1000,
  /** Verdicts depending on a stale source become "inconclusive" after this long (capability card C2). */
  inconclusiveAfterMs: 14 * 24 * 60 * 60 * 1000,
  /** Linked pages (Stripe change details, Token Factory notices) fetched at once per provider. */
  linkedFetchConcurrency: 6,
  /** Oldest Stripe API version whose breaking changes are catalogued. */
  stripeSince: "2019-01-01",
} as const;

/**
 * Providers with no reader (plan S04, D82): found from what the repo uses (an API host in its code,
 * an installed SDK's own base URL), their notice pages nominated by llms.txt and Tavily, read by
 * Nemotron 3 Ultra behind the quote gate.
 */
export const DISCOVERY = {
  /** A provider's discovered notice pages are reused this long before the search runs again. */
  freshForMs: 7 * 24 * 60 * 60 * 1000,
  /** …and this long when no deprecations page was found (search ranking varies between runs). */
  partialFreshForMs: 24 * 60 * 60 * 1000,
  /** Last resort for the deprecations page: these paths on the provider's busiest docs hosts. */
  probePaths: ["/docs/deprecations", "/deprecations"],
  probeHosts: 3,
  /** Direct dependencies whose published files are read for a default API base URL, per scan. */
  maxSdkPackages: 40,
  sdkConcurrency: 4,
  /** Per package: files and bytes of JS/Python read when looking for base URLs. */
  sdkMaxFiles: 12_000,
  sdkMaxBytes: 48 * 1024 * 1024,
  /** Notice pages read per provider (deprecations first, then changelogs). */
  maxPagesPerProvider: 3,
  tavily: {
    url: "https://api.tavily.com",
    searchDepth: "basic",
    maxResults: 8,
    timeoutMs: 30_000,
  },
  /** Text sent to Nemotron per call; longer pages are read in heading-aligned chunks. */
  chunkChars: 32_000,
  maxChunks: 4,
  readerMaxOutputTokens: 16_000,
  /** A page whose own text is shorter than this is rendered by script: Tavily extract reads it. */
  minPageChars: 1_500,
  /** Ambiguous model-ID sites (wrappers, registries) Nemotron traces per scan. */
  maxTriageSites: 24,
  triageMaxChars: 40_000,
} as const;

/**
 * OpenAPI diffs for APIs a repo calls over HTTP (plan S04, research cross-cutting.md §5). oasdiff is
 * pinned: its output differs materially between versions (v1.33.0 vs v1.34.1 on the same specs).
 */
export const OPENAPI = {
  oasdiff: { version: "1.34.1" },
  /** Checks that repeat one change through every expansion path (Stripe: 19,999 enum additions). */
  silenced: [
    "response-property-enum-value-added",
    "response-property-max-length-unset",
    "response-property-any-of-added",
  ],
  /** oasdiff levels: 3 ERR, 2 WARN; INFO never becomes a finding. */
  minLevel: 2,
  maxSpecBytes: 48 * 1024 * 1024,
  timeoutMs: 120_000,
  /** Repositories in the SDK owner's organisation that hold its API description. */
  repoQuery: "openapi OR oai OR api-description OR api-spec OR swagger in:name",
  /** A spec repository's discovery is reused this long. */
  repoFreshForMs: 7 * 24 * 60 * 60 * 1000,
  maxItemsPerOperation: 20,
  /** Response property paths deeper than this are expansions, not fields code reads. */
  maxResponseDepth: 3,
} as const;

/** Runtime end of life (endoflife.date). */
export const RUNTIMES = {
  /** A release line this close to its end of life is flagged ahead of the date. */
  warnDays: 180,
} as const;

/** Go (plan S05, research generic/go.md). */
export const GO = {
  /** Modules come from the proxy only (GOVCS=*:off): no git/hg/svn against hosts a go.mod names. */
  proxy: "https://proxy.golang.org",
  commandTimeoutMs: 180_000,
  helperTimeoutMs: 600_000,
  /** Bump when packages/helpers/go changes, so development rebuilds the cached binary. */
  helperVersion: "3",
  /** Highest major probed above the installed one (`/v5`, `/v6`, …) on the proxy. */
  maxMajorProbe: 6,
  /** govulncheck for advisory reachability (research go.md Job 9: v1.8.0 tested). */
  govulncheckVersion: "v1.8.0",
  /** golang.org/x/exp pseudo-version the helper pins (apidiff). */
  apidiffVersion: "v0.0.0-20261007192929-f45ad48fbe92",
  /** The sandbox image's Go: checks run with this toolchain (`GOTOOLCHAIN=local`). */
  sandboxGo: "1.27.2",
  /** The fix agent's `lookup_docs` answer from the target module's exported declarations. */
  docsLookupMaxItems: 25,
  docsLookupMaxChars: 7000,
  /** Lines of a struct or interface body shown with its declaration. */
  docsBodyLines: 18,
} as const;

/** Rust (plan S06, research generic/rust.md). */
export const RUST = {
  /** crates.io asks every client to identify itself (403 without a User-Agent). */
  userAgent: "TeireBot/0.1 (+https://teire.vercel.app; dependency upgrades)",
  semverChecksVersion: "0.51.0",
  /** rustdoc JSON format versions cargo-semver-checks 0.51.0 reads ("supported formats are v57, v60, v61"). */
  rustdocFormats: [57, 60, 61] as number[],
  maxRustdocBytes: 256 * 1024 * 1024,
  /** The fix agent's `lookup_docs` answer from the target's rustdoc JSON. */
  docsLookupMaxItems: 25,
  docsLookupMaxChars: 7000,
  semverChecksTimeoutMs: 300_000,
  /** Route B compiles both versions and their dependency graphs (research: 109 s for async-openai). */
  routeBTimeoutSec: 1200,
  /** The sandbox's stable toolchain; checks never let rustup install another (RUSTUP_AUTO_INSTALL=0). */
  sandboxRust: "1.99.1",
} as const;

/** Ruby (plan S07, research generic/ruby.md). */
export const RUBY = {
  /** Version of Teire's Prism surface extractor; bump when its rules change (cached diffs). */
  extractorVersion: "2",
  maxGemBytes: 64 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  /** The sandbox image's Ruby: the version an upgrade must run on when the repo pins none. */
  sandboxRuby: "4.0.9",
  /** The fix agent's `lookup_docs` answer from the target gem. */
  docsLookupMaxChars: 7000,
  /** A gem's version list is reused for this long within one worker process. */
  registryMemoMs: 10 * 60_000,
  /** `/api/v1/versions/<gem>.json` (one entry per platform; aws-sdk-core is ~2 MB). */
  maxVersionListBytes: 16 * 1024 * 1024,
} as const;

/** Java and Kotlin (plan S08, research jvm.md). */
export const JVM = {
  japicmpVersion: "0.26.3",
  japicmpUrl:
    "https://repo1.maven.org/maven2/com/github/siom79/japicmp/japicmp/0.26.3/japicmp-0.26.3-jar-with-dependencies.jar",
  japicmpSha1: "2452e6844f44657acd680656f78641205001bca0",
  japicmpTimeoutMs: 180_000,
  /** The fix agent's `lookup_docs` answer (API changes + the target's sources jar). */
  docsLookupMaxChars: 7000,
  maxJarBytes: 128 * 1024 * 1024,
  /** Central first, then Google's mirror of it (Sonatype rate-limits shared egress with 429s). */
  mavenMirrors: [
    "https://repo1.maven.org/maven2",
    "https://maven-central.storage-download.googleapis.com/maven2",
  ],
} as const;

/** Teire's sandbox service (apps/sandbox). Timeouts are set from context/11-build-notes/sandbox-measurements.md. */
export const SANDBOX = {
  /** Lifetime of a signed per-sandbox token. */
  tokenTtlSeconds: 15 * 60,
  /** One HTTP call to the service (start includes the tarball fetch). */
  requestTimeoutMs: 6 * 60 * 1000,
  /** Calls to the service retried on Cloudflare's transient Durable Object errors and dropped connections. */
  requestAttempts: 3,
  retryBackoffMs: 1500,
  /** How often a running job is polled for status and new log bytes. */
  pollIntervalMs: 2000,
} as const;

/** The guarded fetch routine (net/fetch.ts). */
export const NET = {
  userAgent: "TeireBot/0.1 (+https://teire.vercel.app)",
  timeoutMs: 30_000,
  maxRedirects: 5,
  /** Default cap for one response; package tarballs pass their own larger cap. */
  maxResponseBytes: 32 * 1024 * 1024,
  /** A dropped connection or DNS hiccup is retried; an HTTP status never is (the caller decides). */
  networkRetries: 2,
  networkRetryMs: 750,
} as const;

/** Registry access and the target-version policy (plan D71). */
/** String-literal scan for model IDs and API hosts (ast-grep 0.50 plus config files). */
export const LITERALS = {
  timeoutMs: 120_000,
  maxOutputBytes: 64 * 1024 * 1024,
  /** Config files above this size (generated JSON, fixtures) are not searched. */
  maxConfigBytes: 512 * 1024,
} as const;

export const REGISTRY = {
  /** A version must be at least this old before Teire proposes it (repos may lower or raise it). */
  cooldownDays: 7,
  /** Largest package tarball Teire downloads for an API-surface diff. */
  maxTarballBytes: 100 * 1024 * 1024,
  /** deps.dev sends no ETag, only `cache-control: max-age=3600`; Teire reuses its answer this long. */
  depsDevTtlMs: 60 * 60 * 1000,
  /** npm's full package document ("over 10MB uncompressed" for some packages), fallback only. */
  maxPackumentBytes: 96 * 1024 * 1024,
  /** How many skipped newer versions a target decision lists per reason. */
  maxSkippedListed: 5,
  hosts: {
    depsDev: "api.deps.dev",
    npm: "registry.npmjs.org",
    endoflife: "endoflife.date",
  },
  /** endoflife.date data changes when a release line is announced or retired; a day is fresh enough. */
  endoflifeTtlMs: 24 * 60 * 60 * 1000,
} as const;

/** API-surface diffs (plan S02a task 5; emend's measured bounds, refs/emend/src/surface.ts). */
export const SURFACE = {
  /** Where verified package tarballs are unpacked; one directory per name/version. */
  cacheDir: process.env.TEIRE_PACKAGE_CACHE ?? `${process.env.TMPDIR ?? "/tmp"}/teire-packages`,
  /** googleapis, the measured worst case, is 400,630 symbols; a cut-short walk never reports removals. */
  maxSymbols: 600_000,
  maxDepth: 12,
  maxSignatureChars: 4000,
  /** Longest alias expansion substituted into signatures before comparing. */
  maxAliasExpansion: 200,
  /** Type dependencies followed so re-exported declarations resolve (playwright → playwright-core). */
  typeDepDepth: 6,
  typeDepTotalCap: 500,
  typeDepFileCap: 4000,
  /** Wildcard `exports` entries expand to at most this many subpaths for existence checks. */
  maxWildcardFiles: 5000,
  /** Signature text kept per symbol inside a change record; the full diff stays in `surface_diffs`. */
  recordSignatureChars: 600,
  tool: "teire-dts-walker",
  toolVersion: "2+typescript@6.0.3",
  noiseFilterVersion: "2",
} as const;

/** Baseline-vs-after verification (card C5), from context/11-build-notes/sandbox-measurements.md. */
export const VERIFY = {
  workDir: "/work",
  installTimeoutSec: 600,
  checkTimeoutSec: 300,
  /** Output kept per command for the classifier and the PR body. */
  outputTailChars: 20_000,
} as const;

/** Release notes read by Nemotron 3 Ultra (S02a task 8). */
export const NOTES = {
  /** Total text sent to the model per upgrade (~20k tokens). */
  maxCharsToModel: 80_000,
  maxCharsPerDocument: 30_000,
  maxOutputTokens: 16_000,
  maxRemovedApisInPrompt: 60,
} as const;

/** Advisory matching (cross-cutting.md §2): OSV batch limit verified live (1,001 → HTTP 400). */
export const ADVISORIES = {
  osvBatchSize: 1000,
  detailConcurrency: 8,
  /** Packages per GHSA `affects` query, under URL length limits. */
  ghsaPackagesPerCall: 100,
  maxResponseBytes: 32 * 1024 * 1024,
  /** ruby-advisory-db as one tarball (~600 KB), reused for an hour (research ruby.md Job 9). */
  rubysecTarball: "https://codeload.github.com/rubysec/ruby-advisory-db/tar.gz/refs/heads/master",
  rubysecMaxBytes: 16 * 1024 * 1024,
  rubysecTtlMs: 60 * 60_000,
} as const;

/** Teire's Python helper (S03): the interpreter and pins it runs with outside the worker image. */
export const PYTHON = {
  version: "3.12",
  packages: ["packaging==26.3", "griffe==2.4.1", "jedi==0.20.1"],
  helperTimeoutMs: 180_000,
  /** Version of Teire's griffe step (join keys, guards); with griffe's own version it keys cached diffs. */
  surfaceTool: { name: "griffe", version: "2.4.1+teire2" },
} as const;

/**
 * The PR queue's order (D70, S15.9): security (0) → already broken (1) → dated within 90 days (2) →
 * majors with located use (3) → other majors (4) → plain bumps last (5).
 */
export const PRIORITY = {
  plainBump: 5,
} as const;
