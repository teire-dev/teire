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
    /** `@teire ignore` targets (change ids, packages, providers), kept across scans with teire.yml's. */
    ignores: jsonb("ignores").$type<string[]>().notNull().default([]),
    /** The status before `@teire pause`, restored by `resume`. */
    pausedFrom: text("paused_from").$type<RepoStatus>(),
    /** Why the repo is paused when Teire paused it (`opted_out`, `installation_suspended`), not a person. */
    pausedReason: text("paused_reason"),
    /** Scans and the Dashboard issue go on; no fix run starts (`@teire pause-fixes`, D110). */
    fixesPaused: boolean("fixes_paused").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("repos_full_name_idx").on(t.fullName),
    index("repos_installation_idx").on(t.installationId),
  ],
);

/**
 * Which providers each repo's code uses, as of its last scan (D95): when reading a provider's pages
 * turns up a new change, the other active repos that use it are rescanned (provider fan-out).
 */
export const repoProviders = pgTable(
  "repo_providers",
  {
    repoId: githubId("repo_id").notNull(),
    providerSlug: text("provider_slug").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.providerSlug] }),
    index("repo_providers_slug_idx").on(t.providerSlug),
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

export type ChangeStatus = "confirmed" | "candidate" | "quarantined";

/**
 * Every known change. `record` holds the full validated record: schema v1 (provider tables, until
 * S04) or v2 (contract.ts in the engine). Generated records live here; git `catalog/` holds only
 * schemas, curated and contributed records (plan D72).
 */
export const changes = pgTable(
  "changes",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    subjectKind: text("subject_kind").$type<"package" | "api-host" | "model" | "runtime">(),
    ecosystem: text("ecosystem"),
    subjectName: text("subject_name"),
    providerSlug: text("provider_slug"),
    kind: text("kind").notNull(),
    class: text("class"),
    title: text("title").notNull(),
    fromVersion: text("from_version"),
    toVersion: text("to_version"),
    deadline: timestamp("deadline", { withTimezone: true }),
    status: text("status").$type<ChangeStatus>().notNull(),
    visibility: text("visibility").$type<"public" | "private">().notNull().default("public"),
    contentHash: text("content_hash").notNull(),
    record: jsonb("record").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("changes_provider_idx").on(t.providerSlug),
    index("changes_deadline_idx").on(t.deadline),
    index("changes_subject_idx").on(t.ecosystem, t.subjectName),
  ],
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

export type Verdict =
  | "affected"
  | "not_affected"
  | "not_applicable"
  | "needs_human"
  | "inconclusive"
  | "check_by_hand";
/** `gone`: the latest complete scan no longer reports it (dependency moved or removed, target superseded). */
export type FindingState = "open" | "ignored" | "fixed" | "dismissed" | "gone";

/**
 * One change × one dependency × one repo. `dependency_key` (`<ecosystem>:<name>@<workspace>`) is
 * stable across scans, so re-scans update in place.
 */
export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: githubId("repo_id").notNull(),
    changeId: text("change_id").notNull(),
    dependencyKey: text("dependency_key").notNull().default(""),
    changeHash: text("change_hash").notNull(),
    scanId: uuid("scan_id"),
    verdict: text("verdict").$type<Verdict>().notNull(),
    class: text("class"),
    /** Lower runs first: security with a fix, already broken, dated, code-changing majors, plain bumps. */
    priority: integer("priority"),
    reachability: text("reachability"),
    state: text("state").$type<FindingState>().notNull().default("open"),
    reason: text("reason"),
    position: jsonb("position"),
    callSites: jsonb("call_sites").notNull().default([]),
    coverage: jsonb("coverage"),
    groupKey: text("group_key"),
    /**
     * The PR line this belongs to across targets (D111): `npm/zod` (or `npm/zod#security`), and a
     * model or API group's own key. A newer target opens a new PR in the same lineage and
     * supersedes the open one.
     */
    lineageKey: text("lineage_key"),
    catalogVersion: text("catalog_version"),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("findings_repo_change_dep_idx").on(t.repoId, t.changeId, t.dependencyKey),
    index("findings_repo_state_idx").on(t.repoId, t.state),
    index("findings_group_idx").on(t.repoId, t.groupKey),
    index("findings_lineage_idx").on(t.repoId, t.lineageKey),
  ],
);

export type RunKind = "fix" | "dry_run";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** Mirrors PR_MODE_BY_EVIDENCE in the engine: evidence, not a score, decides the PR (rule 13). */
export type EvidenceKind =
  | "verified"
  | "typecheck_only"
  | "pre_existing_failure"
  | "needs_live_access"
  | "needs_local_service"
  | "environment_mismatch"
  | "regression"
  | "unverified"
  | "timeout";

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id"),
    repoId: githubId("repo_id").notNull(),
    /** Null for grouped upgrade runs, which carry `group_key` and cover several changes. */
    changeId: text("change_id"),
    groupKey: text("group_key"),
    /**
     * The PR line this belongs to across targets (D111): `npm/zod` (or `npm/zod#security`), and a
     * model or API group's own key. A newer target opens a new PR in the same lineage and
     * supersedes the open one.
     */
    lineageKey: text("lineage_key"),
    kind: text("kind").$type<RunKind>().notNull(),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    step: text("step"),
    fromVersion: text("from_version"),
    targetVersion: text("target_version"),
    attempt: integer("attempt").notNull().default(1),
    replannedAt: timestamp("replanned_at", { withTimezone: true }),
    evidenceKind: text("evidence_kind").$type<EvidenceKind>(),
    /** Unused since rule 13 (evidence decides the PR); kept until a later migration drops them. */
    outcome: text("outcome"),
    confidence: real("confidence"),
    prMode: text("pr_mode").$type<"ready" | "draft" | "issue">(),
    backend: text("backend"),
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    lockBeforeHash: text("lock_before_hash"),
    lockAfterHash: text("lock_after_hash"),
    diff: text("diff"),
    verification: jsonb("verification"),
    testCounts: jsonb("test_counts"),
    egressDenied: jsonb("egress_denied"),
    envDifferences: jsonb("env_differences").$type<string[]>(),
    modelsUsed: jsonb("models_used"),
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
    phase: text("phase")
      .$type<"install_baseline" | "baseline" | "upgrade" | "install_after" | "after" | "retry">()
      .notNull(),
    sandboxId: text("sandbox_id"),
    jobId: text("job_id"),
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
    /**
     * The PR line this belongs to across targets (D111): `npm/zod` (or `npm/zod#security`), and a
     * model or API group's own key. A newer target opens a new PR in the same lineage and
     * supersedes the open one.
     */
    lineageKey: text("lineage_key"),
    number: integer("number"),
    branch: text("branch"),
    headSha: text("head_sha"),
    state: text("state").$type<"open" | "closed" | "merged">().notNull().default("open"),
    url: text("url"),
    runId: uuid("run_id"),
    /** Head sha whose failing CI Teire already tried to repair (one attempt per head, C6). */
    ciRepairSha: text("ci_repair_sha"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("artifacts_repo_kind_change_idx").on(t.repoId, t.kind, t.changeKey),
    index("artifacts_lineage_idx").on(t.repoId, t.lineageKey),
  ],
);

/**
 * Operational state the worker keeps (plan S10): `credits` (Token Factory 402 seen, cleared when a
 * ping succeeds), `worker` (heartbeat), `models` (failover in use), `redelivery` (last sweep).
 * The /trust page reads it.
 */
export const systemState = pgTable("system_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

/** `@teire wrong <reason>`: a finding someone says is a false positive or negative (C7). */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: githubId("repo_id").notNull(),
    changeId: text("change_id"),
    groupKey: text("group_key"),
    login: text("login").notNull(),
    reason: text("reason").notNull(),
    url: text("url"),
    createdAt: createdAt(),
  },
  (t) => [index("feedback_repo_idx").on(t.repoId, t.createdAt)],
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
    /** The worker's progress (C9): a private or missing repo fails before any scan row exists. */
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    error: text("error"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("public_scans_requester_idx").on(t.requestedBy, t.createdAt)],
);

/** Every dependency a scan found, per workspace/module (plan D44, D56). */
export const dependencyInstances = pgTable(
  "dependency_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scanId: uuid("scan_id").notNull(),
    repoId: githubId("repo_id").notNull(),
    dependencyKey: text("dependency_key").notNull(),
    ecosystem: text("ecosystem").notNull(),
    name: text("name").notNull(),
    aliasName: text("alias_name"),
    version: text("version"),
    declaredRange: text("declared_range"),
    direct: boolean("direct").notNull(),
    scope: text("scope").notNull(),
    workspace: text("workspace").notNull(),
    manifestPath: text("manifest_path").notNull(),
    lockfilePath: text("lockfile_path"),
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    resolvedBy: text("resolved_by").notNull(),
    unresolvedReason: text("unresolved_reason"),
    environment: jsonb("environment"),
  },
  (t) => [
    uniqueIndex("dependency_instances_scan_key_idx").on(t.scanId, t.dependencyKey, t.version),
    index("dependency_instances_repo_idx").on(t.repoId),
    index("dependency_instances_pkg_idx").on(t.ecosystem, t.name, t.version),
  ],
);

/** Registry metadata per package, revalidated with ETags. */
export const registryCache = pgTable(
  "registry_cache",
  {
    ecosystem: text("ecosystem").notNull(),
    name: text("name").notNull(),
    etag: text("etag"),
    lastModified: text("last_modified"),
    bodyHash: text("body_hash").notNull(),
    data: jsonb("data").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ecosystem, t.name] })],
);

/** One API-surface diff per package version pair and tool, reused by every repo on the same jump. */
export const surfaceDiffs = pgTable(
  "surface_diffs",
  {
    ecosystem: text("ecosystem").notNull(),
    name: text("name").notNull(),
    fromVersion: text("from_version").notNull(),
    toVersion: text("to_version").notNull(),
    tool: text("tool").notNull(),
    toolVersion: text("tool_version").notNull(),
    noiseFilterVersion: text("noise_filter_version").notNull(),
    result: jsonb("result").notNull(),
    symbolCount: integer("symbol_count").notNull(),
    truncated: boolean("truncated").notNull().default(false),
    durationMs: integer("duration_ms"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.ecosystem, t.name, t.fromVersion, t.toVersion, t.tool, t.toolVersion, t.noiseFilterVersion],
    }),
  ],
);

/** Advisory ids per exact package version (OSV + GitHub Advisory DB), refreshed daily. */
export const advisoryCache = pgTable(
  "advisory_cache",
  {
    ecosystem: text("ecosystem").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    ids: jsonb("ids").$type<string[]>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ecosystem, t.name, t.version] })],
);

/** Release notes and changelog files by repository, ref and path, sliced by version. */
export const notesCache = pgTable(
  "notes_cache",
  {
    repoUrl: text("repo_url").notNull(),
    ref: text("ref").notNull(),
    path: text("path").notNull(),
    etag: text("etag"),
    contentHash: text("content_hash").notNull(),
    slices: jsonb("slices").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.repoUrl, t.ref, t.path] })],
);

/** Nemotron extraction results, so the same notes are never read twice. */
export const extractionCache = pgTable("extraction_cache", {
  key: text("key").primaryKey(),
  model: text("model").notNull(),
  records: jsonb("records").notNull(),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  createdAt: createdAt(),
});

/** Optional container snapshots per repo and lockfile (Cloudflare public beta; never shared across repos). */
export const sandboxSnapshots = pgTable(
  "sandbox_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: githubId("repo_id").notNull(),
    lockfileHash: text("lockfile_hash").notNull(),
    imageDigest: text("image_digest").notNull(),
    backend: text("backend").notNull(),
    ref: text("ref").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastRestoredAt: timestamp("last_restored_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("sandbox_snapshots_key_idx").on(t.repoId, t.lockfileHash, t.imageDigest, t.backend)],
);
