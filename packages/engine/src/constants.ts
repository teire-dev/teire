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
  /** Confidence at or above this opens a PR; below it opens a "needs a human" issue. */
  prThreshold: 0.7,
  /** Failed verifications before the agent discards its plan and starts over from the evidence. */
  replanAfterFailures: 2,
  /** Hard cap on fix attempts per run. */
  maxAttempts: 4,
  /** Agent tool-loop step cap per attempt. */
  maxAgentSteps: 24,
} as const;

/** Ceilings applied to model confidence by what verification proved (Patch's confidence model). */
export const CONFIDENCE_CEILING = {
  verified: 1,
  typecheck_only: 0.75,
  pre_existing_failure: 0.6,
  unverified: 0.4,
  regression: 0.25,
} as const;

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
