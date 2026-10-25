import { rm } from "node:fs/promises";
import { readTeireConfig } from "@teire/engine/config";
import {
  commitToBranch,
  HumanCommitsError,
  modelName,
  openOrUpdatePullRequest,
  publishCheckRun,
} from "@teire/engine/github";
import { directoryTree, fetchRepoTarball } from "@teire/engine/inventory";
import { createTokenFactory, fetchModelPrices, tokenFactoryConfigFromEnv } from "@teire/engine/llm";
import { assessJsRepo, fixJsDependency } from "@teire/engine/pipeline";
import { selectBackend } from "@teire/engine/verify";
import { cachedNpmSurfaceDiff, postgresRegistryCache } from "../caches";
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
import type { WorkerContext } from "./scan";

const DEFER_SECONDS = 3600;

export async function fixRun(ctx: WorkerContext, runId: string) {
  const { db, gh } = ctx;
  const run = await getRun(db, runId);
  if (!run || run.status === "succeeded" || run.status === "cancelled") return { skipped: true };
  const repo = await getRepo(db, run.repoId);
  if (!repo?.installationId || !run.groupKey || !run.targetVersion || !run.baseSha)
    throw new Error(`run ${runId} is incomplete`);
  const [owner = "", name = ""] = repo.fullName.split("/");
  const packageName = run.groupKey.split("/").slice(1, -1).join("/");
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
  await event("assess", "started", { package: packageName, target: run.targetVersion });
  const token = await installation.token();
  let dir: string | null = null;
  try {
    const checkout = await fetchRepoTarball(owner, name, run.baseSha, { token });
    dir = checkout.dir;
    const tree = directoryTree(checkout.dir);
    const cache = postgresRegistryCache(db);
    const repoConfig = readTeireConfig(tree);
    const { assessments } = await assessJsRepo(checkout.dir, tree, {
      cache,
      cooldownDays: repoConfig.upgrades.cooldownDays,
      onlyPackage: packageName,
      githubToken: token,
      surfaceDiff: (n, f, t) => cachedNpmSurfaceDiff(db, n, f, t, { cache }),
    });
    const assessment = assessments.find(
      (a) => a.decision?.kind === "upgrade" && a.decision.to === run.targetVersion,
    );
    if (!assessment) {
      await updateRun(db, runId, {
        status: "cancelled",
        step: "target no longer applies",
        finishedAt: new Date(),
      });
      await event("assess", "cancelled", { reason: "the target is no longer chosen for this repo" });
      return { cancelled: true };
    }

    const tf = createTokenFactory(tokenFactoryConfigFromEnv());
    const prices = await fetchModelPrices().catch(() => undefined);
    const { backend, note } = await selectBackend();
    await updateRun(db, runId, { step: "fix", backend: backend.name });
    const result = await fixJsDependency({
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
      assessment,
      options: { cache, githubToken: token, context7Key: process.env.CONTEXT7_API_KEY },
      onEvent: (e) => {
        void event(e.step, "log", e);
        void updateRun(db, runId, { step: e.step });
      },
    });
    const fix = result.run;

    // Receipts: every model call and every sandbox command.
    if (result.notesReceipt)
      await recordLlmCall(db, {
        runId,
        purpose: "notes",
        step: "notes",
        model: result.notesReceipt.model,
        tokensIn: result.notesReceipt.tokensIn,
        tokensOut: result.notesReceipt.tokensOut,
        costUsd: result.notesReceipt.costUsd.toFixed(6),
        latencyMs: result.notesReceipt.ms,
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
    const models = [
      ...new Set([result.notesReceipt?.model, ...fix.attempts.map((a) => a.model)].filter(Boolean)),
    ];
    const common = {
      evidenceKind: fix.evidence.kind,
      prMode,
      verification: { baseline: fix.baseline.checks, after: fix.after.checks, reasons: fix.evidence.reasons },
      testCounts: { baseline: fix.evidence.baseline, after: fix.evidence.after },
      egressDenied: fix.after.deniedHosts,
      diff: fix.files.map((f) => f.patch).join("\n"),
      modelsUsed: models.map((m) => ({ id: m, name: modelName(m ?? "") })),
      costUsd: (fix.costUsd + (result.notesReceipt?.costUsd ?? 0)).toFixed(6),
      attempt: Math.max(1, fix.attempts.length),
    };

    if (prMode === "issue") {
      // No usable result: a "needs a human" issue with the evidence and the best diff.
      const existing = await getArtifact(db, repo.id, "issue", run.groupKey);
      const body = `${result.pr.body}\n\n<sub>Teire stopped: ${fix.evidence.reasons.join("; ")}</sub>`;
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
              title: `Teire needs a human: ${result.pr.title.toLowerCase()}`,
              body,
              labels: ["teire"],
            })
          ).data;
      await upsertArtifact(db, {
        repoId: repo.id,
        kind: "issue",
        changeKey: run.groupKey,
        number: issue.number,
        state: "open",
        url: issue.html_url,
        runId,
      });
      await updateRun(db, runId, {
        ...common,
        status: "failed",
        step: "needs a human",
        finishedAt: new Date(),
      });
      await event("pr", "issue", { url: issue.html_url, evidence: fix.evidence.kind });
      return { issue: issue.html_url };
    }

    const branch = `teire/${run.groupKey}`;
    const files = [
      ...fix.files.map((f) => ({ path: f.path, content: f.after })),
      ...(fix.lockfile ? [{ path: fix.lockfile.path, content: fix.lockfile.after }] : []),
    ];
    const commit = await commitToBranch({
      octokit: installation.octokit,
      owner,
      repo: name,
      branch,
      baseSha: run.baseSha,
      botLogin: gh.botLogin,
      headline: result.pr.title,
      body: `${fix.evidence.kind === "verified" ? "Verified" : "Draft"}: ${fix.evidence.reasons.join("; ")}`,
      files,
    });
    const pr = await openOrUpdatePullRequest({
      octokit: installation.octokit,
      owner,
      repo: name,
      branch,
      base: repo.defaultBranch,
      title: result.pr.title,
      body: result.pr.body,
      draft: prMode === "draft",
      labels: [
        "teire",
        "npm",
        assessment.decision?.kind === "upgrade" && assessment.decision.isMajor ? "major" : "upgrade",
      ],
    });
    const sites = (assessment.summary?.breaking ?? []).flatMap((f) =>
      f.callSites.map((s) => ({
        ...s,
        message: `${f.changeKind.replace(/-/g, " ")} in ${packageName} ${run.targetVersion}: ${s.snippet.trim().slice(0, 200)}`,
      })),
    );
    await publishCheckRun({
      octokit: installation.octokit,
      owner,
      repo: name,
      headSha: commit.oid,
      conclusion: fix.evidence.kind === "verified" ? "success" : "neutral",
      title: `${fix.evidence.kind.replace(/_/g, " ")}: ${packageName} ${run.fromVersion} → ${run.targetVersion}`,
      summary: fix.evidence.reasons.join("; "),
      ...(ctx.webUrl ? { detailsUrl: `${ctx.webUrl}/runs/${runId}` } : {}),
      sites,
    }).catch((error) => event("pr", "check-run-failed", { error: String(error) }));
    await upsertArtifact(db, {
      repoId: repo.id,
      kind: "pr",
      changeKey: run.groupKey,
      number: pr.number,
      branch,
      headSha: commit.oid,
      state: "open",
      url: pr.url,
      runId,
    });
    await updateRun(db, runId, {
      ...common,
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
