import { rm } from "node:fs/promises";
import { readTeireConfig } from "@teire/engine/config";
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
import { directoryTree, fetchRepoTarball } from "@teire/engine/inventory";
import { createTokenFactory, fetchModelPrices, tokenFactoryConfigFromEnv } from "@teire/engine/llm";
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
import {
  appendEvent,
  getArtifact,
  getRepo,
  getRun,
  prCounts,
  recordLlmCall,
  recordSandboxExec,
  updateRun,
  upsertArtifact,
} from "../store";
import { pageReader, storedProviderChanges } from "./providers";
import type { WorkerContext } from "./scan";

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

/** A package group (`npm/openai/7.38.0`): re-assess that package, then upgrade and fix it. */
async function packageOutcome(
  ctx: WorkerContext,
  run: { groupKey: string; targetVersion: string; fromVersion: string | null },
  repoDir: string,
  tree: RepoTree,
  token: string,
  common: Common,
): Promise<Outcome | null> {
  const head = run.groupKey.split("/")[0];
  const ecosystem =
    head === "pypi"
      ? "pypi"
      : head === "go"
        ? "go"
        : head === "cargo"
          ? "cargo"
          : head === "gem"
            ? "rubygems"
            : head === "maven"
              ? "maven"
              : "npm";
  const packageName = run.groupKey.split("/").slice(1, -1).join("/");
  const cache = postgresRegistryCache(ctx.db);
  const assessOptions = {
    cache,
    cooldownDays: readTeireConfig(tree).upgrades.cooldownDays,
    onlyPackage: packageName,
    githubToken: token,
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
  const assessment = (assessments as Assessment<AssessedProject>[]).find(
    (a) => a.decision?.kind === "upgrade" && a.decision.to === run.targetVersion,
  );
  if (!assessment) return null;
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
    declared: readTeireConfig(tree).sources,
  });
  const group = findings.filter((f) => f.groupKey === run.groupKey);
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
  const repo = await getRepo(db, run.repoId);
  if (!repo?.installationId || !run.groupKey || !run.targetVersion || !run.baseSha)
    throw new Error(`run ${runId} is incomplete`);
  const groupKey = run.groupKey;
  const isApi = /^(models|api)\//.test(groupKey);
  const [owner = "", name = ""] = repo.fullName.split("/");
  const installation = await gh.installation(repo.installationId);
  const event = (step: string, type: string, payload: object) => appendEvent(db, runId, step, type, payload);

  // Noise controls before any work (D70): per-repo open PRs and new PRs per hour.
  const config = (repo.config as ReturnType<typeof readTeireConfig> | null) ?? null;
  const limits = config?.pullRequests ?? { limit: 5, perHour: 2 };
  const counts = await prCounts(db, repo.id);
  if (counts.open >= limits.limit || counts.lastHour >= limits.perHour) {
    await updateRun(db, runId, { status: "queued", step: "waiting for the PR limit" });
    await event("queue", "deferred", { open: counts.open, lastHour: counts.lastHour, limits });
    await ctx.enqueueFix(runId, repo.id, DEFER_SECONDS);
    return { deferred: true };
  }

  await updateRun(db, runId, { status: "running", step: "assess", startedAt: new Date() });
  await event("assess", "started", { group: groupKey, from: run.fromVersion, target: run.targetVersion });
  const token = await installation.token();
  let dir: string | null = null;
  try {
    const checkout = await fetchRepoTarball(owner, name, run.baseSha, { token });
    dir = checkout.dir;
    const tree = directoryTree(checkout.dir);
    const tf = createTokenFactory(tokenFactoryConfigFromEnv());
    const prices = await fetchModelPrices().catch(() => undefined);
    const { backend, note } = await selectBackend();
    const common: Common = {
      tf,
      prices,
      backend,
      backendNote: note,
      runId,
      ...(ctx.webUrl ? { runUrl: `${ctx.webUrl}/runs/${runId}` } : {}),
      repoDir: checkout.dir,
      tree,
      repo: { owner, repo: name, baseSha: run.baseSha },
      tarball: { url: `https://api.github.com/repos/${owner}/${name}/tarball/${run.baseSha}`, token },
      options: {
        cache: postgresRegistryCache(db),
        githubToken: token,
        context7Key: process.env.CONTEXT7_API_KEY,
      },
      onEvent: (e: { step: string }) => {
        void event(e.step, "log", e);
        void updateRun(db, runId, { step: e.step });
      },
    };
    await updateRun(db, runId, { step: "fix", backend: backend.name });
    const outcome = isApi
      ? await apiOutcome(ctx, { groupKey }, checkout.dir, tree, common)
      : await packageOutcome(
          ctx,
          { groupKey, targetVersion: run.targetVersion, fromVersion: run.fromVersion },
          checkout.dir,
          tree,
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
      headline: composed.title,
      body: `${fix.evidence.kind === "verified" ? "Verified" : "Draft"}: ${fix.evidence.reasons.join("; ")}`,
      files,
    });
    const pr = await openOrUpdatePullRequest({
      octokit: installation.octokit,
      owner,
      repo: name,
      branch,
      base: repo.defaultBranch,
      title: composed.title,
      body: composed.body,
      draft: prMode === "draft",
      labels: [
        "teire",
        ...outcome.labels,
        // A draft says why in its label too: needs-live-access, typecheck-only, …
        ...(prMode === "draft" ? [fix.evidence.kind.replace(/_/g, "-")] : []),
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
    return { pr: pr.url };
  } catch (error) {
    const message =
      error instanceof HumanCommitsError
        ? `stopped: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    await updateRun(db, runId, { status: "failed", error: message, finishedAt: new Date() });
    await event("run", "failed", { error: message });
    if (!(error instanceof HumanCommitsError)) throw error;
    return { stopped: message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
