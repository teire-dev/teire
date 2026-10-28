import { rm } from "node:fs/promises";
import { matchesTarget, readTeireConfig, type TeireConfig } from "@teire/engine/config";
import { RUNS } from "@teire/engine/constants";
import type { CallSite } from "@teire/engine/contract";
import type { FixRun } from "@teire/engine/fix";
import {
  commitToBranch,
  HumanCommitsError,
  modelName,
  openOrUpdatePullRequest,
  publishCheckRun,
} from "@teire/engine/github";
import type { JvmProject, PyProject, RepoTree, RubyProject, RustProject } from "@teire/engine/inventory";
import { directoryTree, fetchRepoTarball, scopedTree } from "@teire/engine/inventory";
import {
  CreditsExhaustedError,
  createTokenFactory,
  fetchModelPrices,
  tokenFactoryConfigFromEnv,
} from "@teire/engine/llm";
import {
  type AssessedProject,
  type Assessment,
  assessApiChanges,
  assessGoRepo,
  assessJsRepo,
  assessJvmRepo,
  assessPyRepo,
  assessRubyRepo,
  assessRustRepo,
  fixApiChanges,
  fixGoDependency,
  fixJsDependency,
  fixJvmDependency,
  fixPyDependency,
  fixRubyDependency,
  fixRustDependency,
  type GoAssessment,
  repoInstances,
} from "@teire/engine/pipeline";
import { cargoSurfaceDiff, goSurfaceDiff } from "@teire/engine/surface";
import { selectBackend } from "@teire/engine/verify";
import { cachedSurfaceDiff, postgresRegistryCache } from "../caches";
import { markCreditsExhausted, modelWorkBlocked } from "../reliability";
import {
  appendEvent,
  getArtifact,
  getRepo,
  getRun,
  openArtifacts,
  prCounts,
  recordLlmCall,
  recordSandboxExec,
  runEventsOf,
  updateRun,
  upsertArtifact,
} from "../store";
import { readOrgConfig } from "./commands";
import { syncDashboard } from "./dashboard";
import { pageReader, storedProviderChanges } from "./providers";
import { requesterToken } from "./public";
import type { WorkerContext } from "./scan";

/** A run deferred for credits or the daily budget tries again after this long. */
const BUDGET_RETRY_SECONDS = 30 * 60;
const DEFER_SECONDS = 3600;

/** What a fix produced, whatever was fixed (a package upgrade or a provider's API change). */
interface Outcome {
  fix: FixRun;
  pr: { title: string; body: string };
  notesReceipt: { model: string; tokensIn: number; tokensOut: number; costUsd: number; ms: number } | null;
  labels: string[];
  checkTitle: string;
  sites: (CallSite & { message: string })[];
}

type Common = Omit<Parameters<typeof fixJsDependency>[0], "assessment">;

const PACKAGE_ECOSYSTEMS = ["npm", "pypi", "go", "cargo", "rubygems", "maven"] as const;

/** The ecosystem a package group key starts with, or null for a provider group (`models/…`, `api/…`). */
export function packageEcosystemOf(head: string): (typeof PACKAGE_ECOSYSTEMS)[number] | null {
  return (PACKAGE_ECOSYSTEMS as readonly string[]).includes(head)
    ? (head as (typeof PACKAGE_ECOSYSTEMS)[number])
    : null;
}

/** A package group (`npm/openai/7.38.0`): re-assess that package, then upgrade and fix it. */
async function packageOutcome(
  ctx: WorkerContext,
  run: { groupKey: string; targetVersion: string; fromVersion: string | null },
  repoDir: string,
  tree: RepoTree,
  config: TeireConfig,
  token: string | undefined,
  common: Common,
): Promise<Outcome | null> {
  // A package group key is `<ecosystem>/<name>/<target>` with the contract's ecosystem names.
  const head = run.groupKey.split("/")[0] ?? "";
  const ecosystem = packageEcosystemOf(head);
  if (!ecosystem) throw new Error(`run ${run.groupKey}: not a package group`);
  const packageName = run.groupKey.split("/").slice(1, -1).join("/");
  const cache = postgresRegistryCache(ctx.db);
  const assessOptions = {
    cache,
    cooldownDays: config.upgrades.cooldownDays,
    onlyPackage: packageName,
    ...(token ? { githubToken: token } : {}),
    surfaceDiff: (n: string, f: string, t: string) =>
      cachedSurfaceDiff(ctx.db, ecosystem, n, f, t, { cache }),
  };
  const { assessments } =
    ecosystem === "pypi"
      ? await assessPyRepo(repoDir, tree, assessOptions)
      : ecosystem === "go"
        ? await assessGoRepo(repoDir, tree, {
            ...assessOptions,
            surfaceDiff: (oldPath, f, newPath, t) =>
              cachedSurfaceDiff(ctx.db, "go", oldPath, f, t, { cache }, () =>
                goSurfaceDiff(oldPath, f, newPath, t),
              ),
          })
        : ecosystem === "cargo"
          ? await assessRustRepo(repoDir, tree, {
              ...assessOptions,
              surfaceDiff: (n: string, f: string, t: string) =>
                cachedSurfaceDiff(ctx.db, "cargo", n, f, t, { cache }, async () =>
                  cargoSurfaceDiff(n, f, t, { backend: (await selectBackend()).backend }),
                ),
            })
          : ecosystem === "rubygems"
            ? await assessRubyRepo(repoDir, tree, assessOptions)
            : ecosystem === "maven"
              ? await assessJvmRepo(repoDir, tree, assessOptions)
              : await assessJsRepo(repoDir, tree, assessOptions);
  // Every lockfile root that declares the package at this target. The most urgent leads; the run
  // names the others (one PR per package per repo, D94; the resolver edits them all from S15).
  const matching = (assessments as Assessment<AssessedProject>[])
    .filter((a) => a.decision?.kind === "upgrade" && a.decision.to === run.targetVersion)
    // `@teire ignore` and teire.yml `ignore` apply to the run as they do to the scan (C8).
    .filter(
      (a) => !a.findings.length || a.findings.some((f) => !config.ignore.some((t) => matchesTarget(t, f))),
    )
    .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));
  const assessment = matching[0];
  if (!assessment) return null;
  const roots = [...new Set(matching.map((a) => a.project.root))];
  if (roots.length > 1)
    common.onEvent?.({
      step: "transaction",
      detail: `${roots.length} lockfile roots declare ${packageName} at ${run.targetVersion} (${roots.join(", ")}); this run edits ${assessment.project.root}`,
    });
  const result =
    ecosystem === "pypi"
      ? await fixPyDependency({ ...common, assessment: assessment as unknown as Assessment<PyProject> })
      : ecosystem === "go"
        ? await fixGoDependency({ ...common, assessment: assessment as unknown as GoAssessment })
        : ecosystem === "cargo"
          ? await fixRustDependency({
              ...common,
              assessment: assessment as unknown as Assessment<RustProject>,
            })
          : ecosystem === "rubygems"
            ? await fixRubyDependency({
                ...common,
                assessment: assessment as unknown as Assessment<RubyProject>,
              })
            : ecosystem === "maven"
              ? await fixJvmDependency({
                  ...common,
                  assessment: assessment as unknown as Assessment<JvmProject>,
                })
              : await fixJsDependency({ ...common, assessment: assessment as unknown as Assessment });
  return {
    fix: result.run,
    pr: result.pr,
    notesReceipt: result.notesReceipt,
    labels: [
      ecosystem,
      assessment.purpose === "security"
        ? "security"
        : assessment.decision?.kind === "upgrade" && assessment.decision.isMajor
          ? "major"
          : "upgrade",
    ],
    checkTitle: `${packageName} ${run.fromVersion} → ${run.targetVersion}`,
    sites: (assessment.summary?.breaking ?? []).flatMap((f) =>
      f.callSites.map((s) => ({
        ...s,
        message: `${f.changeKind.replace(/-/g, " ")} in ${packageName} ${run.targetVersion}: ${s.snippet.trim().slice(0, 200)}`,
      })),
    ),
  };
}

/** A provider group (`models/nebius-token-factory`): re-scan against the stored catalog, then swap and fix. */
async function apiOutcome(
  ctx: WorkerContext,
  run: { groupKey: string },
  repoDir: string,
  tree: RepoTree,
  config: TeireConfig,
  common: Common,
): Promise<Outcome | null> {
  const {
    findings,
    records: read,
    providers,
  } = await assessApiChanges(repoDir, tree, await repoInstances(repoDir, tree), {
    changes: storedProviderChanges(ctx.db),
    discover: { cache: postgresRegistryCache(ctx.db) },
    triage: await pageReader(ctx.db),
    openapi: {
      cache: postgresRegistryCache(ctx.db),
      githubToken: common.options.githubToken,
      repo: { owner: common.repo.owner, name: common.repo.repo, sha: common.repo.baseSha },
    },
    declared: config.sources,
  });
  const group = findings
    .filter((f) => f.groupKey === run.groupKey)
    .filter((f) => !config.ignore.some((t) => matchesTarget(t, f)));
  if (!group.some((f) => f.verdict === "affected")) return null;
  const records = read.filter((r) => group.some((f) => f.changeId === r.id));
  const slug = records[0]?.subject.provider;
  const result = await fixApiChanges({
    ...common,
    findings: group,
    records,
    related: read.filter((r) => r.subject.provider === slug),
    providerName: providers.find((p) => p.provider.slug === slug)?.provider.name,
  });
  return {
    fix: result.run,
    pr: result.pr,
    notesReceipt: null,
    labels: [run.groupKey.startsWith("models/") ? "model-retirement" : "api-change", ...(slug ? [slug] : [])],
    checkTitle: result.pr.title,
    sites: group
      .filter((f) => f.verdict === "affected")
      .flatMap((f) => f.callSites.map((s) => ({ ...s, message: f.reason }))),
  };
}

export async function fixRun(ctx: WorkerContext, runId: string) {
  const { db, gh } = ctx;
  const run = await getRun(db, runId);
  if (!run || run.status === "succeeded" || run.status === "cancelled") return { skipped: true };
  // A run the reaper failed (its worker stopped) is retried by its queue: it starts over cleanly.
  // Any other failure stays failed until someone asks again (`@teire recreate`).
  if (run.status === "failed" && run.step !== "interrupted") return { skipped: true };
  if (run.status === "failed" || run.status === "running")
    await updateRun(db, runId, { status: "queued", attempt: run.attempt + 1, error: null });
  const repo = await getRepo(db, run.repoId);
  // A dry run (C9) works on any public repo: no installation, no GitHub writes, no PR caps.
  const dry = run.kind === "dry_run";
  if (!repo || (!dry && !repo.installationId) || !run.groupKey || !run.targetVersion || !run.baseSha) {
    // Recorded on the run, so it shows as failed instead of waiting in the queue forever.
    await updateRun(db, runId, {
      status: "failed",
      step: "incomplete",
      error: `run ${runId} is incomplete: ${!repo ? "the repository is gone" : !dry && !repo.installationId ? "Teire is no longer installed on it" : "it has no group, target or base commit"}`,
      finishedAt: new Date(),
    });
    throw new Error(`run ${runId} is incomplete`);
  }
  const groupKey = run.groupKey;
  const isApi = /^(models|api)\//.test(groupKey);
  const [owner = "", name = ""] = repo.fullName.split("/");
  // A paused repo gets no PRs ("no scans or PRs until resume"), whatever started the run.
  if (!dry && repo.status === "paused") {
    await updateRun(db, runId, { status: "cancelled", step: "repository paused", finishedAt: new Date() });
    await appendEvent(db, runId, "queue", "cancelled", {
      reason: "the repository is paused; resume it to fix",
    });
    return { cancelled: "paused" };
  }
  // Fixes paused (`@teire pause-fixes`, D110): scans and the Dashboard issue go on, no run does.
  if (!dry && repo.fixesPaused) {
    await updateRun(db, runId, { status: "cancelled", step: "fixes paused", finishedAt: new Date() });
    await appendEvent(db, runId, "queue", "cancelled", {
      reason: "fixes are paused for this repository; `@teire resume-fixes` to fix",
    });
    return { cancelled: "fixes paused" };
  }
  const installation = repo.installationId && !dry ? await gh.installation(repo.installationId) : null;
  const event = (step: string, type: string, payload: object) => appendEvent(db, runId, step, type, payload);

  // Noise controls before any work (D70): per-repo open PRs and new PRs per hour.
  const config = (repo.config as ReturnType<typeof readTeireConfig> | null) ?? null;
  const limits = config?.pullRequests ?? { limit: 5, perHour: 2 };
  const counts = dry ? { open: 0, lastHour: 0 } : await prCounts(db, repo.id);
  if (counts.open >= limits.limit || counts.lastHour >= limits.perHour) {
    await updateRun(db, runId, { status: "queued", step: "waiting for the PR limit" });
    await event("queue", "deferred", { open: counts.open, lastHour: counts.lastHour, limits });
    await ctx.enqueueFix(runId, repo.id, DEFER_SECONDS);
    return { deferred: true };
  }

  // Money and the model service decide whether model work may start (S10).
  const blocked = await modelWorkBlocked(db);
  if (blocked) {
    await updateRun(db, runId, { status: "queued", step: "waiting for the model budget" });
    await event("queue", "deferred", { reason: blocked });
    await ctx.enqueueFix(runId, repo.id, BUDGET_RETRY_SECONDS);
    return { deferred: blocked };
  }

  await updateRun(db, runId, { status: "running", step: "assess", startedAt: new Date() });
  // A heartbeat while the run works, so the reaper can tell a long sandbox step from a dead worker.
  const heartbeat = setInterval(
    () => void updateRun(db, runId, {}).catch(() => undefined),
    RUNS.heartbeatEveryMs,
  );
  await event("assess", "started", { group: groupKey, from: run.fromVersion, target: run.targetVersion });
  // A dry run reads GitHub as the person who asked (their own rate limit), anonymously without it.
  const token = installation ? await installation.token() : await requesterToken(db, run.requestedBy);
  let dir: string | null = null;
  try {
    const checkout = await fetchRepoTarball(owner, name, run.baseSha, token ? { token } : {});
    dir = checkout.dir;
    // The scan's own config: the repo's file over `<org>/teire-config` over defaults, plus
    // `@teire ignore` targets, and the same scoped tree (C8).
    const orgText = installation ? await readOrgConfig(installation.octokit, owner) : null;
    const runConfig = readTeireConfig(
      directoryTree(checkout.dir),
      orgText ? { orgText, orgFile: `${owner}/teire-config/teire.yml` } : {},
    );
    runConfig.ignore = [...new Set([...runConfig.ignore, ...((repo.ignores as string[] | null) ?? [])])];
    const tree = scopedTree(directoryTree(checkout.dir), runConfig);
    const tf = createTokenFactory(tokenFactoryConfigFromEnv());
    const prices = await fetchModelPrices().catch(() => undefined);
    const { backend, note } = await selectBackend();
    // A CI repair starts from what the repo's own CI said about the PR (C6: one repair attempt).
    const ci = run.requestedBy?.startsWith("ci-repair:")
      ? ((await runEventsOf(db, runId, "ci"))[0]?.payload as
          | { checks?: { name: string; url: string; log: string }[] }
          | undefined)
      : undefined;
    const extraNotes = (ci?.checks ?? []).map((c) => ({
      summary: `The repository's own CI check "${c.name}" failed on Teire's PR; fix what it reports (its log is the quote).`,
      apis: [],
      replacement: null,
      quote: c.log,
      url: c.url,
    }));
    const common: Common = {
      ...(extraNotes.length ? { extraNotes } : {}),
      ...(config?.verify?.length ? { verify: config.verify } : {}),
      tf,
      prices,
      backend,
      backendNote: note,
      runId,
      ...(ctx.webUrl ? { runUrl: `${ctx.webUrl}/runs/${runId}` } : {}),
      repoDir: checkout.dir,
      tree,
      repo: { owner, repo: name, baseSha: run.baseSha },
      tarball: {
        url: `https://api.github.com/repos/${owner}/${name}/tarball/${run.baseSha}`,
        ...(token ? { token } : {}),
      },
      options: {
        cache: postgresRegistryCache(db),
        ...(token ? { githubToken: token } : {}),
        context7Key: process.env.CONTEXT7_API_KEY,
      },
      onEvent: (e: { step: string }) => {
        void event(e.step, "log", e);
        void updateRun(db, runId, { step: e.step });
      },
    };
    await updateRun(db, runId, { step: "fix", backend: backend.name });
    const outcome = isApi
      ? await apiOutcome(ctx, { groupKey }, checkout.dir, tree, runConfig, common)
      : await packageOutcome(
          ctx,
          { groupKey, targetVersion: run.targetVersion, fromVersion: run.fromVersion },
          checkout.dir,
          tree,
          runConfig,
          token,
          common,
        );
    if (!outcome) {
      await updateRun(db, runId, { status: "cancelled", step: "no longer applies", finishedAt: new Date() });
      await event("assess", "cancelled", { reason: "the change no longer applies to this repo" });
      return { cancelled: true };
    }
    const { fix, pr: composed, notesReceipt } = outcome;

    // Receipts: every model call and every sandbox command.
    if (notesReceipt)
      await recordLlmCall(db, {
        runId,
        purpose: "notes",
        step: "notes",
        model: notesReceipt.model,
        tokensIn: notesReceipt.tokensIn,
        tokensOut: notesReceipt.tokensOut,
        costUsd: notesReceipt.costUsd.toFixed(6),
        latencyMs: notesReceipt.ms,
      });
    for (const s of fix.agentSteps)
      await recordLlmCall(db, {
        runId,
        purpose: "fix",
        step: s.tools.map((t) => t.name).join(",") || "answer",
        model: s.model,
        tokensIn: s.tokensIn,
        tokensCached: s.tokensCached,
        tokensOut: s.tokensOut,
        costUsd: s.costUsd.toFixed(6),
        latencyMs: s.ms,
      });
    if (fix.review)
      await recordLlmCall(db, {
        runId,
        purpose: "review",
        step: "review",
        model: fix.review.model,
        tokensIn: fix.review.tokensIn,
        tokensOut: fix.review.tokensOut,
        costUsd: fix.review.costUsd.toFixed(6),
        latencyMs: fix.review.ms,
      });
    for (const [phase, side] of [
      ["baseline", fix.baseline],
      ["after", fix.after],
    ] as const) {
      await recordSandboxExec(db, {
        runId,
        backend: backend.name,
        phase: phase === "baseline" ? "install_baseline" : "install_after",
        command: "install",
        exitCode: side.install.exitCode,
        durationMs: side.install.ms,
        stdoutTail: side.install.output.slice(-4000),
      });
      for (const c of side.checks)
        await recordSandboxExec(db, {
          runId,
          backend: backend.name,
          phase,
          command: c.argv.join(" "),
          exitCode: c.exitCode,
          timedOut: c.timedOut,
          durationMs: c.ms,
          stdoutTail: c.output.slice(-4000),
        });
    }

    const prMode = fix.evidence.prMode;
    const models = [...new Set([notesReceipt?.model, ...fix.attempts.map((a) => a.model)].filter(Boolean))];
    const runFields = {
      evidenceKind: fix.evidence.kind,
      prMode,
      verification: { baseline: fix.baseline.checks, after: fix.after.checks, reasons: fix.evidence.reasons },
      testCounts: { baseline: fix.evidence.baseline, after: fix.evidence.after },
      egressDenied: fix.after.deniedHosts,
      diff: fix.files.map((f) => f.patch).join("\n"),
      modelsUsed: models.map((m) => ({ id: m, name: modelName(m ?? "") })),
      costUsd: (fix.costUsd + (notesReceipt?.costUsd ?? 0)).toFixed(6),
      attempt: Math.max(1, fix.attempts.length),
    };

    if (dry) {
      // The PR Teire would open, kept on the run for the report page; nothing is written to GitHub.
      await updateRun(db, runId, {
        ...runFields,
        status: prMode === "issue" ? "failed" : "succeeded",
        step: prMode === "issue" ? "needs a human" : "dry run complete",
        finishedAt: new Date(),
      });
      await event("pr", "dry-run", {
        title: composed.title,
        body: composed.body,
        mode: prMode,
        labels: outcome.labels,
        evidence: fix.evidence.kind,
      });
      return { dryRun: prMode };
    }
    if (!installation) throw new Error(`run ${runId}: no installation`);

    if (prMode === "issue") {
      // No usable result: a "needs a human" issue with the evidence and the best diff.
      const existing = await getArtifact(db, repo.id, "issue", groupKey);
      const body = `${composed.body}\n\n<sub>Teire stopped: ${fix.evidence.reasons.join("; ")}</sub>`;
      const issue = existing?.number
        ? (
            await installation.octokit.rest.issues.update({
              owner,
              repo: name,
              issue_number: existing.number,
              body,
            })
          ).data
        : (
            await installation.octokit.rest.issues.create({
              owner,
              repo: name,
              title: `Teire needs a human: ${composed.title.toLowerCase()}`,
              body,
              labels: ["teire"],
            })
          ).data;
      await upsertArtifact(db, {
        repoId: repo.id,
        kind: "issue",
        changeKey: groupKey,
        number: issue.number,
        state: "open",
        url: issue.html_url,
        runId,
      });
      await updateRun(db, runId, {
        ...runFields,
        status: "failed",
        step: "needs a human",
        finishedAt: new Date(),
      });
      await event("pr", "issue", { url: issue.html_url, evidence: fix.evidence.kind });
      // The Dashboard issue links "Needs a human" issues, and this group no longer offers "Fix now".
      await syncDashboard(ctx, repo.id).catch(() => undefined);
      return { issue: issue.html_url };
    }

    const branch = `teire/${groupKey}`;
    // The lock and any manifest the package manager rewrote are among the run's files already.
    const files = fix.files.map((f) => ({ path: f.path, content: f.after }));
    const commit = await commitToBranch({
      octokit: installation.octokit,
      owner,
      repo: name,
      branch,
      baseSha: run.baseSha,
      botLogin: gh.botLogin,
      headline: `${config?.pullRequests?.commitMessage?.prefix ?? ""}${composed.title}`,
      body: `${fix.evidence.kind === "verified" ? "Verified" : "Draft"}: ${fix.evidence.reasons.join("; ")}`,
      files,
    });
    const pr = await openOrUpdatePullRequest({
      octokit: installation.octokit,
      owner,
      repo: name,
      branch,
      base: config?.pullRequests?.targetBranch || repo.defaultBranch,
      title: composed.title,
      body: composed.body,
      draft: prMode === "draft",
      labels: [
        "teire",
        ...outcome.labels,
        // A draft says why in its label too: needs-live-access, typecheck-only, …
        ...(prMode === "draft" ? [fix.evidence.kind.replace(/_/g, "-")] : []),
        ...(config?.pullRequests?.labels ?? []),
      ],
    });
    await publishCheckRun({
      octokit: installation.octokit,
      owner,
      repo: name,
      headSha: commit.oid,
      conclusion: fix.evidence.kind === "verified" ? "success" : "neutral",
      title: `${fix.evidence.kind.replace(/_/g, " ")}: ${outcome.checkTitle}`,
      summary: fix.evidence.reasons.join("; "),
      ...(ctx.webUrl ? { detailsUrl: `${ctx.webUrl}/runs/${runId}` } : {}),
      sites: outcome.sites,
    }).catch((error) => event("pr", "check-run-failed", { error: String(error) }));
    await upsertArtifact(db, {
      repoId: repo.id,
      kind: "pr",
      changeKey: groupKey,
      number: pr.number,
      branch,
      headSha: commit.oid,
      state: "open",
      url: pr.url,
      runId,
    });
    await updateRun(db, runId, {
      ...runFields,
      status: "succeeded",
      step: "done",
      headSha: commit.oid,
      finishedAt: new Date(),
    });
    await event("pr", pr.created ? "opened" : "updated", {
      url: pr.url,
      number: pr.number,
      draft: prMode === "draft",
    });
    // A newer target for the same package supersedes its older PR (C6).
    // Only a package has versions to supersede: `models/openai` and `models/anthropic` are separate PRs.
    const family = packageEcosystemOf(groupKey.split("/")[0] ?? "")
      ? groupKey.split("/").slice(0, -1).join("/")
      : null;
    for (const old of family ? await openArtifacts(db, repo.id) : [])
      if (
        old.kind === "pr" &&
        old.changeKey !== groupKey &&
        old.changeKey.startsWith(`${family}/`) &&
        old.number
      ) {
        await installation.octokit.rest.issues
          .createComment({
            owner,
            repo: name,
            issue_number: old.number,
            body: `Superseded by #${pr.number} (${groupKey.split("/").pop()}).`,
          })
          .catch(() => undefined);
        await installation.octokit.rest.pulls
          .update({ owner, repo: name, pull_number: old.number, state: "closed" })
          .catch(() => undefined);
        await upsertArtifact(db, { ...old, state: "closed" });
      }
    await syncDashboard(ctx, repo.id).catch((error) =>
      event("dashboard", "failed", { error: String(error) }),
    );
    return { pr: pr.url };
  } catch (error) {
    if (error instanceof CreditsExhaustedError) {
      // Not this run's fault: it waits, and every other run waits, until credits are back.
      await markCreditsExhausted(db, error.message);
      await updateRun(db, runId, {
        status: "queued",
        step: "waiting for Token Factory credits",
        error: error.message,
      });
      await event("queue", "deferred", { reason: error.message });
      await ctx.enqueueFix(runId, repo.id, BUDGET_RETRY_SECONDS);
      return { deferred: error.message };
    }
    const message =
      error instanceof HumanCommitsError
        ? `stopped: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    await updateRun(db, runId, { status: "failed", error: message, finishedAt: new Date() });
    await event("run", "failed", { error: message });
    if (error instanceof HumanCommitsError) {
      // C6: a person pushed to Teire's branch; their commits are never overwritten.
      const open = await getArtifact(db, repo.id, "pr", groupKey);
      if (open?.number && open.state === "open")
        await installation?.octokit.rest.issues
          .createComment({
            owner,
            repo: name,
            issue_number: open.number,
            body: `Teire stopped updating this branch: ${error.message}. Your commits stay; comment \`@teire recreate\` to start over from the current base.`,
          })
          .catch(() => undefined);
    }
    if (!(error instanceof HumanCommitsError)) throw error;
    return { stopped: message };
  } finally {
    clearInterval(heartbeat);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
