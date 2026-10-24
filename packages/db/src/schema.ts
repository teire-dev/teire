import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const githubId = (name: string) => bigint(name, { mode: "number" });

/** A GitHub App installation (user or organization). The id is GitHub's installation id. */
export const installations = pgTable("installations", {
  id: githubId("id").primaryKey(),
  accountId: githubId("account_id").notNull(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").$type<"User" | "Organization">().notNull(),
  avatarUrl: text("avatar_url"),
  repositorySelection: text("repository_selection").$type<"all" | "selected">().notNull(),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Which signed-in users can see which installations (refreshed from GET /user/installations at sign-in). */
export const userInstallations = pgTable(
  "user_installations",
  {
    userId: text("user_id").notNull(),
    installationId: githubId("installation_id").notNull(),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.installationId] })],
);

export type RepoStatus = "detected" | "onboarding" | "active" | "paused" | "disabled";

/** A repository Teire knows about. The id is GitHub's repository id. Public-scan repos have no installation. */
export const repos = pgTable(
  "repos",
  {
    id: githubId("id").primaryKey(),
    installationId: githubId("installation_id"),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    isPrivate: boolean("is_private").notNull().default(false),
    status: text("status").$type<RepoStatus>().notNull().default("detected"),
    config: jsonb("config"),
    configSource: text("config_source"),
    languages: jsonb("languages").$type<string[]>(),
    lastScannedSha: text("last_scanned_sha"),
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("repos_full_name_idx").on(t.fullName),
    index("repos_installation_idx").on(t.installationId),
  ],
);

/** Index of catalog/providers/*.json (the JSON files are the source of truth). */
export const providers = pgTable("providers", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  record: jsonb("record").notNull(),
  updatedAt: updatedAt(),
});

export type SourceStatus = "ok" | "stale" | "failing";

/** One upstream source Teire reads for a provider (changelog, deprecations page, feed, spec, catalog). */
export const providerSources = pgTable(
  "provider_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerSlug: text("provider_slug").notNull(),
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    status: text("status").$type<SourceStatus>().notNull().default("stale"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    lastHash: text("last_hash"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("provider_sources_url_idx").on(t.url),
    index("provider_sources_provider_idx").on(t.providerSlug),
  ],
);

export type ChangeStatus = "confirmed" | "quarantined";

/** Index of catalog/changes/<provider>/<id>.json. `record` holds the full validated record. */
export const changes = pgTable(
  "changes",
  {
    id: text("id").primaryKey(),
    providerSlug: text("provider_slug").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    deadline: timestamp("deadline", { withTimezone: true }),
    status: text("status").$type<ChangeStatus>().notNull(),
    contentHash: text("content_hash").notNull(),
    record: jsonb("record").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("changes_provider_idx").on(t.providerSlug), index("changes_deadline_idx").on(t.deadline)],
);

export type ScanTrigger = "install" | "push" | "catalog" | "command" | "manual" | "public";
export type JobStatus = "queued" | "running" | "done" | "failed";

export const scans = pgTable(
  "scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: githubId("repo_id").notNull(),
    sha: text("sha"),
    trigger: text("trigger").$type<ScanTrigger>().notNull(),
    requestedBy: text("requested_by"),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    catalogVersion: text("catalog_version"),
    coverage: jsonb("coverage"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("scans_repo_idx").on(t.repoId, t.createdAt)],
);

export type Verdict = "affected" | "not_affected" | "needs_human" | "inconclusive";
export type FindingState = "open" | "ignored" | "fixed" | "dismissed";

/** One change × one repo. Unique per pair so re-scans update in place. */
export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: githubId("repo_id").notNull(),
    changeId: text("change_id").notNull(),
    changeHash: text("change_hash").notNull(),
    scanId: uuid("scan_id"),
    verdict: text("verdict").$type<Verdict>().notNull(),
    state: text("state").$type<FindingState>().notNull().default("open"),
    reason: text("reason"),
    callSites: jsonb("call_sites").notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("findings_repo_change_idx").on(t.repoId, t.changeId),
    index("findings_repo_state_idx").on(t.repoId, t.state),
  ],
);

export type RunKind = "fix" | "dry_run";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type VerifyOutcome =
  | "verified"
  | "typecheck_only"
  | "regression"
  | "pre_existing_failure"
  | "unverified";

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id"),
    repoId: githubId("repo_id").notNull(),
    changeId: text("change_id").notNull(),
    kind: text("kind").$type<RunKind>().notNull(),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    step: text("step"),
    outcome: text("outcome").$type<VerifyOutcome>(),
    confidence: real("confidence"),
    backend: text("backend"),
    diff: text("diff"),
    verification: jsonb("verification"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    idempotencyKey: text("idempotency_key").notNull(),
    isPublic: boolean("is_public").notNull().default(false),
    requestedBy: text("requested_by"),
    error: text("error"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("runs_idempotency_idx").on(t.idempotencyKey),
    index("runs_status_idx").on(t.status, t.updatedAt),
    index("runs_repo_idx").on(t.repoId, t.createdAt),
  ],
);

/** Append-only event log per run; the run page reads `seq > after`. */
export const runEvents = pgTable(
  "run_events",
  {
    runId: uuid("run_id").notNull(),
    seq: integer("seq").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    step: text("step").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

/** Every Token Factory call: receipts per step and the daily cost cap both read this. */
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id"),
    purpose: text("purpose").notNull(),
    step: text("step"),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    tokensCached: integer("tokens_cached").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("llm_calls_run_idx").on(t.runId), index("llm_calls_created_idx").on(t.createdAt)],
);

export const sandboxExecs = pgTable(
  "sandbox_execs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    backend: text("backend").notNull(),
    phase: text("phase").$type<"install" | "baseline" | "after">().notNull(),
    command: text("command").notNull(),
    exitCode: integer("exit_code"),
    timedOut: boolean("timed_out").notNull().default(false),
    durationMs: integer("duration_ms"),
    stdoutTail: text("stdout_tail"),
    stderrTail: text("stderr_tail"),
    createdAt: createdAt(),
  },
  (t) => [index("sandbox_execs_run_idx").on(t.runId)],
);

export type ArtifactKind = "pr" | "issue" | "dashboard" | "onboarding";

/** Every GitHub object Teire creates. `changeKey` is '' for per-repo artifacts so uniqueness holds. */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: githubId("repo_id").notNull(),
    kind: text("kind").$type<ArtifactKind>().notNull(),
    changeKey: text("change_key").notNull().default(""),
    number: integer("number"),
    branch: text("branch"),
    headSha: text("head_sha"),
    state: text("state").$type<"open" | "closed" | "merged">().notNull().default("open"),
    url: text("url"),
    runId: uuid("run_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("artifacts_repo_kind_change_idx").on(t.repoId, t.kind, t.changeKey)],
);

/** Outbox for GitHub webhooks: the web route inserts, the worker claims. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    guid: text("guid").primaryKey(),
    event: text("event").notNull(),
    action: text("action"),
    installationId: githubId("installation_id"),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("webhook_deliveries_pending_idx").on(t.processedAt, t.receivedAt)],
);

/** Cache for Context7, Tavily and provider docs lookups, keyed by source + query. */
export const docsCache = pgTable("docs_cache", {
  key: text("key").primaryKey(),
  source: text("source").$type<"context7" | "tavily" | "provider">().notNull(),
  body: text("body").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Public scans started from /scan (sign-in required to start, report is public). */
export const publicScans = pgTable(
  "public_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoFullName: text("repo_full_name").notNull(),
    repoId: githubId("repo_id"),
    scanId: uuid("scan_id"),
    requestedBy: text("requested_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("public_scans_requester_idx").on(t.requestedBy, t.createdAt)],
);
