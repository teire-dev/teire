/** Every tunable number in one place. Values come from the build plan's decisions. */

export const TOKENFACTORY = {
  /** OpenAI-compatible base URL (Token Factory quickstart). */
  defaultBaseUrl: "https://api.tokenfactory.nebius.com/v1/",
  /** AI SDK provider name; provider options are keyed by it (providerOptions.tokenfactory). */
  providerName: "tokenfactory",
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

export const FIX = {
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
  maxOpenPerRepo: 5,
  maxNewPerHour: 2,
  /** GitHub's PR body limit. */
  bodyMaxChars: 65_536,
  /** GitHub check-run annotations per request. */
  annotationsPerCall: 50,
  branchPrefix: "teire",
} as const;

export const RUNS = {
  /** Runs without a heartbeat for this long are failed by the reaper. */
  staleAfterMs: 10 * 60 * 1000,
  heartbeatEveryMs: 15 * 1000,
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
} as const;

export const GITHUB = {
  /** Installation tokens last 1 h; refresh before that. */
  tokenRefreshMarginMs: 5 * 60 * 1000,
  /** Secondary rate limit: content-creating requests per minute. */
  contentWritesPerMinute: 80,
  webhookRedeliveryWindowMs: 3 * 24 * 60 * 60 * 1000,
} as const;

export const CATALOG = {
  userAgent: "TeireBot/0.1 (+https://teire.vercel.app; catalog ingestion)",
  fetchTimeoutMs: 20_000,
  /** How often each provider source is checked. */
  checkEveryMs: 3 * 60 * 60 * 1000,
  /** A source that has not been read successfully for this long is shown as stale. */
  staleAfterMs: 24 * 60 * 60 * 1000,
  /** Verdicts depending on a stale source become "inconclusive" after this long (capability card C2). */
  inconclusiveAfterMs: 14 * 24 * 60 * 60 * 1000,
  /** Linked pages (Stripe change details, Token Factory notices) fetched at once per provider. */
  linkedFetchConcurrency: 6,
  /** Oldest Stripe API version whose breaking changes are catalogued. */
  stripeSince: "2019-01-01",
} as const;

/** Teire's sandbox service (apps/sandbox). Timeouts are set from context/11-build-notes/sandbox-measurements.md. */
export const SANDBOX = {
  /** Lifetime of a signed per-sandbox token. */
  tokenTtlSeconds: 15 * 60,
  /** One HTTP call to the service (start includes the tarball fetch). */
  requestTimeoutMs: 6 * 60 * 1000,
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
} as const;

/** Registry access and the target-version policy (plan D71). */
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
  },
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
  toolVersion: "1+typescript@6.0.3",
  noiseFilterVersion: "1",
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
