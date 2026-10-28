import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { RunCancelledError, withCancel } from "@teire/engine/cancel";
import { personMayStart, readTeireConfig } from "@teire/engine/config";
import { PULL_REQUESTS, RUNS, SCAN } from "@teire/engine/constants";
import { lineageKey } from "@teire/engine/contract";
import {
  filesFromDiff,
  type OtherProject,
  unchecked,
  verifyProjects,
  weakestEvidence,
} from "@teire/engine/fix";
import {
  branchFor,
  commitToBranch,
  fitBody,
  forGitHub,
  openOrUpdatePullRequest,
  publishCheckRun,
  setPullRequestEvidence,
} from "@teire/engine/github";
import { directoryTree, fetchRepoTarball, scopedTree } from "@teire/engine/inventory";
import {
  type CheckableProject,
  cancellableBackend,
  checkableProjects,
  fileEcosystem,
  projectOf,
  selectBackend,
} from "@teire/engine/verify";
import {
  appendEvent,
  cancelRequest,
  claimRunLease,
  fixModeOf,
  getArtifact,
  getRepo,
  getRun,
  holdsRun,
  prCounts,
  recordSandboxExec,
  renewLease,
  setRepo,
  settleRunActions,
  updateHeldRun,
  upsertArtifact,
  WORKER_ID,
} from "../store";
import { fixesOffReply, readOrgConfig } from "./commands";
import { syncDashboard } from "./dashboard";
import { githubRepoNow, LeaseLostError, saidOnGitHub } from "./fix";
import type { WorkerContext } from "./scan";

type Octokit = Awaited<ReturnType<WorkerContext["gh"]["installation"]>>["octokit"];
type Repo = NonNullable<Awaited<ReturnType<typeof getRepo>>>;
type Outcome = {
  status: "done" | "refused" | "failed";
  result: string;
  links?: { label: string; href: string }[];
};

const EVIDENCE_LABEL: Record<string, string> = {
  verified: "Verified",
  typecheck_only: "Typecheck only",
  pre_existing_failure: "Already failing before",
  needs_live_access: "Needs live access",
  needs_local_service: "Needs a local service",
  environment_mismatch: "Not checked everywhere",
  regression: "Regression",
  unverified: "Not proven",
  timeout: "Timed out",
};

/** One file of a compare as the run page's diff reads it (the same shape as a fix run's patches). */
function fileDiff(f: { filename: string; status: string; previous_filename?: string; patch?: string }) {
  const from = f.status === "added" ? "/dev/null" : `a/${f.previous_filename ?? f.filename}`;
  const to = f.status === "removed" ? "/dev/null" : `b/${f.filename}`;
  return f.patch
    ? `===================================================================\n--- ${from}\n+++ ${to}\n${f.patch}\n`
    : `Binary files ${from} and ${to} differ\n`;
}

/**
 * Re-verify (U2): an open Teire PR checked again as it stands, both sides, its code unchanged. The
 * baseline is the merge base and the after side is the PR's head itself, so what is checked is
 * exactly what would merge, a person's commits on the branch included. Every project the PR's files
 * touch is checked with its own commands; the weakest evidence decides. The result goes on the PR:
 * a check run on the head, the draft state and evidence label, and a comment. A run of its own, so
 * its page shows it live and Cancel stops it like any run.
 */
export async function reverifyRun(ctx: WorkerContext, runId: string) {
  const { db, gh } = ctx;
  const run = await getRun(db, runId);
  if (!run || run.kind !== "reverify" || run.status === "succeeded" || run.status === "cancelled")
    return { skipped: true };
  // A run the reaper failed (its worker stopped) starts over; any other failure stays.
  if (run.status === "failed" && run.step !== "interrupted") return { skipped: true };
  if (!(await claimRunLease(db, runId, RUNS.leaseMs))) return { skipped: "another worker holds this run" };
  const abort = new AbortController();
  let leaseLost = false;
  let published = false;
  let cancelledBy: string | null = null;
  let lastStep = "assess";
  const update = async (fields: Parameters<typeof updateHeldRun>[2]) => {
    if (leaseLost) throw new LeaseLostError();
    if (await updateHeldRun(db, runId, fields)) return;
    const now = await getRun(db, runId);
    if (now?.workerId === WORKER_ID && now.status === "cancelled") {
      abort.abort();
      throw new RunCancelledError();
    }
    leaseLost = true;
    throw new LeaseLostError();
  };
  const holdLease = async () => {
    if (leaseLost || !(await renewLease(db, runId))) {
      leaseLost = true;
      throw new LeaseLostError();
    }
  };
  const event = (step: string, type: string, payload: object) => {
    if (leaseLost) throw new LeaseLostError();
    lastStep = step;
    return appendEvent(db, runId, step, type, payload, true);
  };
  const settle = (fields: { status: "done" | "refused" | "failed"; result: string }) =>
    settleRunActions(db, runId, ["reverify-run"], fields);
  const stop = async (step: string, reason: string) => {
    await update({ status: "failed", step, error: reason, finishedAt: new Date() });
    await event("queue", "refused", { reason });
    await settle({ status: "refused", result: reason });
    return { refused: reason };
  };
  const by = run.requestedBy?.replace(/^reverify:/, "") ?? "a person";

  const repo = await getRepo(db, run.repoId);
  const groupKey = run.groupKey;
  if (!repo?.installationId || !groupKey)
    return stop("incomplete", "Teire is no longer installed on this repository");
  if (repo.status === "paused") return stop("repository paused", "The repository is paused; resume it first");
  const artifact = await getArtifact(db, repo.id, "pr", groupKey);
  if (artifact?.state !== "open" || !artifact.number)
    return stop("not open", "Re-verify works on an open Teire pull request");
  const [owner = "", name = ""] = repo.fullName.split("/");
  const installation = await gh.installation(repo.installationId);
  const { octokit } = installation;

  await update({ status: "running", step: "assess", startedAt: new Date(), error: null });
  const watchCancel = setInterval(
    () =>
      void cancelRequest(db, runId)
        .then((c) => {
          if (c && !abort.signal.aborted && !published) {
            cancelledBy = c.by;
            abort.abort();
            void appendEvent(db, runId, "run", "stopping", { by: c.by, during: lastStep }).catch(
              () => undefined,
            );
          }
        })
        .catch(() => undefined),
    RUNS.cancelPollMs,
  );
  const heartbeat = setInterval(
    () =>
      void renewLease(db, runId)
        .then((held) => {
          if (!held && !leaseLost) {
            leaseLost = true;
            abort.abort();
          }
        })
        .catch(() => undefined),
    RUNS.heartbeatEveryMs,
  );
  let dir: string | null = null;
  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: artifact.number });
    if (pr.state !== "open") return await stop("not open", `#${pr.number} is no longer open`);
    const head = pr.head.sha;
    const { data: cmp } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo: name,
      basehead: `${pr.base.sha}...${head}`,
    });
    const base = cmp.merge_base_commit.sha;
    const changed = cmp.files ?? [];
    if (!changed.length) return await stop("nothing to check", `#${pr.number} changes no files`);
    await update({ step: "verify", baseSha: base, headSha: head, diff: changed.map(fileDiff).join("\n") });
    await event("assess", "started", {
      detail: `#${pr.number} at ${head.slice(0, 7)}: ${changed.length} file${changed.length === 1 ? "" : "s"} over ${base.slice(0, 7)}`,
    });

    // The backend follows the repository's visibility now (D107, review R1); its size as for a fix run.
    const now = await githubRepoNow(owner, name, octokit, null);
    if (now.isPrivate !== null && now.isPrivate !== repo.isPrivate)
      await setRepo(db, repo.id, { isPrivate: now.isPrivate });
    if (now.sizeKb !== null && now.sizeKb > SCAN.maxRepoKb)
      return await stop(
        "too large",
        `${repo.fullName} is ${Math.round(now.sizeKb / 1024)} MB; Teire verifies repositories up to ${SCAN.maxRepoKb / 1024} MB`,
      );
    const token = await installation.token();
    const checkout = await withCancel(abort.signal, () => fetchRepoTarball(owner, name, head, { token }));
    dir = checkout.dir;
    // The PR's own files decide the projects and their commands (a toolchain the PR raised included).
    const orgText = await readOrgConfig(octokit, owner);
    const config = readTeireConfig(
      directoryTree(checkout.dir),
      orgText ? { orgText, orgFile: `${owner}/teire-config/teire.yml` } : {},
    );
    const tree = scopedTree(directoryTree(checkout.dir), config);
    const paths = changed.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
    const touched = new Map<string, CheckableProject>();
    const unowned: string[] = [];
    let listFailure: string | null = null;
    try {
      const projects = await checkableProjects(checkout.dir, tree);
      for (const path of paths) {
        const project = projectOf(projects, path);
        if (project) touched.set(`${project.ecosystem}:${project.root}`, project);
        else unowned.push(path);
      }
    } catch (error) {
      listFailure = forGitHub(String(error), 160);
    }
    const said = (list: string[]) =>
      list
        .slice(0, 3)
        .map((p) => `\`${p}\``)
        .join(", ");
    // Fail closed, as a fix run does (review R2): a file no project holds is unchecked, never fine.
    const orphans: OtherProject[] = listFailure
      ? [
          unchecked(
            ".",
            fileEcosystem(paths[0] ?? "") ?? "npm",
            `couldn't list the projects behind ${said(paths)} (${listFailure})`,
          ),
        ]
      : unowned.length
        ? [
            unchecked(
              ".",
              fileEcosystem(unowned[0] ?? "") ?? "npm",
              `no project Teire can check holds ${said(unowned)}`,
            ),
          ]
        : [];

    let reading: Promise<boolean> | null = null;
    const stillPublic = () => {
      reading ??= githubRepoNow(owner, name, octokit, null)
        .then(async (r) => {
          if (r.isPrivate === true && !repo.isPrivate) await setRepo(db, repo.id, { isPrivate: true });
          return r.isPrivate === false;
        })
        .finally(() => {
          reading = null;
        });
      return reading;
    };
    const selected = await selectBackend(process.env, { isPrivate: now.isPrivate ?? true, stillPublic });
    const backend = cancellableBackend(selected.backend, abort.signal);
    await update({ backend: backend.name });
    await event("verify", "backend", { detail: selected.note });
    const tarball = (sha: string) => ({
      url: `https://api.github.com/repos/${owner}/${name}/tarball/${sha}`,
      token,
    });
    const checked = touched.size
      ? await withCancel(abort.signal, () =>
          verifyProjects({
            backend,
            runId,
            tarball: tarball(base),
            after: { tarball: tarball(head) },
            projects: [...touched.values()],
            ...(config.verify.length ? { verify: config.verify } : {}),
            why: `on #${pr.number} as it stands`,
            onEvent: (e) => {
              if (leaseLost) return;
              lastStep = e.step;
              void appendEvent(db, runId, e.step, "log", e, true).catch(() => undefined);
            },
          }),
        )
      : [];
    if (abort.signal.aborted) throw new RunCancelledError();
    const all = [...checked, ...orphans];
    // The lead is the project in the run's own ecosystem (`npm/zod/4.1.0` → npm), else the first.
    const lead = all.find((p) => p.ecosystem === groupKey.split("/")[0]) ?? all[0];
    if (!lead) return await stop("nothing to check", `no project in #${pr.number} could be checked`);
    const others = all.filter((p) => p !== lead);
    const evidence = weakestEvidence(lead.evidence, others);

    // Receipts, written only while this worker holds the run (U1 review).
    await holdLease();
    await db.transaction(async (tx) => {
      if (!(await holdsRun(tx, runId))) throw new LeaseLostError();
      for (const project of all)
        for (const [phase, side] of [
          ["baseline", project.baseline],
          ["after", project.after],
        ] as const) {
          const folder = project === lead ? "" : `[${project.root === "." ? "/" : project.root}] `;
          if (side.install.ms || side.install.output)
            await recordSandboxExec(tx, {
              runId,
              backend: backend.name,
              phase: phase === "baseline" ? "install_baseline" : "install_after",
              command: `${folder}install`,
              exitCode: side.install.exitCode,
              durationMs: side.install.ms,
              stdoutTail: side.install.output.slice(-4000),
            });
          for (const c of side.checks)
            await recordSandboxExec(tx, {
              runId,
              backend: backend.name,
              phase,
              command: `${folder}${c.argv.join(" ")}`,
              exitCode: c.exitCode,
              timedOut: c.timedOut,
              durationMs: c.ms,
              stdoutTail: c.output.slice(-4000),
            });
        }
    });

    // The result on GitHub: nothing after a cancel; from here a cancel is too late.
    if (abort.signal.aborted) throw new RunCancelledError();
    await holdLease();
    published = true;
    const label = EVIDENCE_LABEL[evidence.kind] ?? evidence.kind;
    const runUrl = ctx.webUrl ? `${ctx.webUrl}/runs/${runId}` : null;
    await publishCheckRun({
      octokit,
      owner,
      repo: name,
      headSha: head,
      conclusion: evidence.kind === "verified" ? "success" : "neutral",
      title: `${label}: re-verified at ${head.slice(0, 7)}`,
      summary: saidOnGitHub(evidence.reasons),
      ...(runUrl ? { detailsUrl: runUrl } : {}),
      sites: [],
    }).catch((error) => event("pr", "check-run-failed", { error: String(error) }));
    await holdLease();
    const state = await setPullRequestEvidence({
      octokit,
      owner,
      repo: name,
      number: pr.number,
      evidence: evidence.kind,
    });
    const moved = state.draft === state.was ? "" : state.draft ? " Now a draft." : " Ready for review.";
    await holdLease();
    await octokit.rest.issues.createComment({
      owner,
      repo: name,
      issue_number: pr.number,
      body: `Re-verified at \`${head.slice(0, 7)}\` for @${by}: **${label}**. ${saidOnGitHub(evidence.reasons)}${moved}${runUrl ? `\n\n[The run](${runUrl})` : ""}`,
    });
    // The PR's evidence is this run's now: its rows and proof chain read from here.
    await upsertArtifact(db, { ...artifact, headSha: head, runId });
    await update({
      status: "succeeded",
      step: "done",
      evidenceKind: evidence.kind,
      prMode: evidence.prMode,
      verification: {
        baseline: lead.baseline.checks,
        after: lead.after.checks,
        reasons: evidence.reasons,
        others: others.map((o) => ({
          root: o.root,
          ecosystem: o.ecosystem,
          evidence: o.evidence.kind,
          reasons: o.evidence.reasons,
          baseline: o.baseline.checks,
          after: o.after.checks,
        })),
      },
      testCounts: { baseline: evidence.baseline, after: evidence.after },
      egressDenied: lead.after.deniedHosts,
      finishedAt: new Date(),
    });
    await event("pr", "reverified", {
      url: pr.html_url,
      number: pr.number,
      evidence: evidence.kind,
      draft: state.draft,
      was: state.was,
    });
    await settle({ status: "done", result: `${label}${moved}` });
    await settleRunActions(db, runId, ["cancel-run"], {
      status: "refused",
      result: `Too late to stop: the result was already on #${pr.number}`,
    });
    await syncDashboard(ctx, repo.id).catch(() => undefined);
    return { reverified: evidence.kind };
  } catch (error) {
    if (
      !(error instanceof LeaseLostError) &&
      !leaseLost &&
      (error instanceof RunCancelledError || abort.signal.aborted)
    ) {
      const who = cancelledBy ?? (await cancelRequest(db, runId))?.by ?? "a person";
      await updateHeldRun(db, runId, {
        status: "cancelled",
        step: "cancelled by a person",
        error: `cancelled by @${who} during ${lastStep}`,
        finishedAt: new Date(),
      });
      await appendEvent(db, runId, "run", "cancelled", { by: who, during: lastStep }).catch(() => undefined);
      await settleRunActions(db, runId, ["cancel-run"], {
        status: "done",
        result: `Stopped during ${lastStep}; its sandboxes were closed`,
      });
      await settle({ status: "refused", result: `Cancelled by @${who} before it finished` });
      return { cancelled: who };
    }
    if (error instanceof LeaseLostError || leaseLost) {
      await appendEvent(db, runId, "run", "lease-lost", {
        worker: "this worker was paused past its lease",
      }).catch(() => undefined);
      return { skipped: "lease lost" };
    }
    const message = error instanceof Error ? error.message : String(error);
    await updateHeldRun(db, runId, { status: "failed", error: message, finishedAt: new Date() });
    await appendEvent(db, runId, "run", "failed", { error: message }, true).catch(() => undefined);
    await settle({ status: "failed", result: forGitHub(message) });
    return { failed: message };
  } finally {
    clearInterval(heartbeat);
    clearInterval(watchCancel);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Open draft anyway (U2): a run that ended needing a person still holds its best diff. A person can
 * have it as a draft PR, titled unconfirmed and labelled with the evidence that stopped it, to
 * finish by hand. The files are rebuilt from the run's own diff over the commit it started from;
 * a diff that can't carry them (a binary file) or no longer applies is refused with the file named.
 * It writes new code to the repository, so it follows the fix mode and the PR limits as Fix now does.
 */
export async function openDraftAnyway(
  ctx: WorkerContext,
  repo: Repo,
  octokit: Octokit,
  runId: string,
  login: string,
): Promise<Outcome> {
  const { db, gh } = ctx;
  const refused = (result: string): Outcome => ({ status: "refused", result });
  const runLink = { label: "Run", href: `/runs/${runId}` };
  const run = await getRun(db, runId);
  if (!run?.groupKey || run.repoId !== repo.id) return refused("That run isn't in this repository");
  if (run.kind !== "fix" || run.prMode !== "issue" || !run.diff || !run.baseSha)
    return refused("Open draft anyway is for a run that ended needing a person, with a diff to show");
  if (repo.status === "paused") return refused("This repository is paused; resume it first");
  const mode = await fixModeOf(db, repo);
  if (!personMayStart(mode)) return refused(fixesOffReply(mode));
  const groupKey = run.groupKey;
  const open = await getArtifact(db, repo.id, "pr", groupKey);
  if (open?.state === "open" && open.number)
    return {
      status: "done",
      result: `Already open: #${open.number}`,
      links: [{ label: `#${open.number}`, href: open.url ?? "" }],
    };
  // A new branch and PR, so the PR limits apply (review R5).
  const config = (repo.config as ReturnType<typeof readTeireConfig> | null) ?? null;
  const limits = config?.pullRequests ?? {
    limit: PULL_REQUESTS.maxOpenPerRepo,
    perHour: PULL_REQUESTS.maxNewPerHour,
  };
  const counts = await prCounts(db, repo.id);
  if (counts.open >= limits.limit || counts.lastHour >= limits.perHour)
    return refused(
      `The PR limit is reached (${counts.open} of ${limits.limit} open, ${counts.lastHour} of ${limits.perHour} this hour); close one or raise \`pullRequests.limit\` in teire.yml`,
    );

  const [owner = "", name = ""] = repo.fullName.split("/");
  const installation = await gh.installation(repo.installationId as number);
  const checkout = await fetchRepoTarball(owner, name, run.baseSha, { token: await installation.token() });
  try {
    const at = (path: string) => join(checkout.dir, path);
    const rebuilt = filesFromDiff(run.diff, (path) =>
      existsSync(at(path)) && !lstatSync(at(path)).isSymbolicLink() ? readFileSync(at(path), "utf8") : null,
    );
    if ("error" in rebuilt)
      return refused(
        `Teire can't open it: ${rebuilt.error}. Comment \`@teire recreate\` on the issue to start over`,
      );
    // An executable keeps its bit (gradlew); everything else is a plain file.
    const files = rebuilt.files.map((f) => ({
      path: f.path,
      content: f.content,
      ...(f.content !== null && existsSync(at(f.path)) && statSync(at(f.path)).mode & 0o111
        ? { mode: "100755" as const }
        : {}),
    }));

    // The issue carries the PR Teire would have opened: its title and body.
    const issue = await getArtifact(db, repo.id, "issue", groupKey);
    const fromIssue = issue?.number
      ? (await octokit.rest.issues.get({ owner, repo: name, issue_number: issue.number })).data
      : null;
    const subject = (fromIssue?.title ?? "").replace(/^Teire needs a human:\s*/i, "") || groupKey;
    const title = `Unconfirmed: ${subject}`;
    const reasons = ((run.verification as { reasons?: string[] } | null)?.reasons ?? []).filter(Boolean);
    const evidenceLabel = (run.evidenceKind ?? "unverified").replace(/_/g, "-");
    const runUrl = ctx.webUrl ? `${ctx.webUrl}/runs/${run.id}` : undefined;
    const earlier = (fromIssue?.body ?? "").replace(/\n*<sub>Teire stopped:[\s\S]*?<\/sub>\s*$/, "");
    const body = fitBody(
      [
        `> [!WARNING]\n> **Unconfirmed.** Teire's checks did not prove this change. @${login} opened it as a draft from the run's best diff, to finish by hand.${reasons.length ? `\n> Teire stopped: ${saidOnGitHub(reasons)}` : ""}`,
        earlier,
        `${issue?.number ? `From #${issue.number}. ` : ""}${runUrl ? `[The run](${runUrl}) has the evidence.` : ""}`,
      ]
        .filter((b) => b.trim())
        .join("\n\n"),
      PULL_REQUESTS.bodyMaxChars,
      runUrl,
    );
    const branch = branchFor(groupKey);
    const commit = await commitToBranch({
      octokit,
      owner,
      repo: name,
      branch,
      baseSha: run.baseSha,
      botLogin: gh.botLogin,
      headline: `${config?.pullRequests?.commitMessage?.prefix ?? ""}${title}`,
      body: `Unconfirmed: ${saidOnGitHub(reasons) || "Teire's checks did not prove it"}`,
      files,
    });
    const pr = await openOrUpdatePullRequest({
      octokit,
      owner,
      repo: name,
      branch,
      base: config?.pullRequests?.targetBranch || repo.defaultBranch,
      title,
      body,
      draft: true,
      labels: ["teire", "unconfirmed", evidenceLabel, ...(config?.pullRequests?.labels ?? [])],
    });
    await publishCheckRun({
      octokit,
      owner,
      repo: name,
      headSha: commit.oid,
      conclusion: "neutral",
      title: `Unconfirmed: ${(run.evidenceKind ?? "unverified").replace(/_/g, " ")}`,
      summary: saidOnGitHub(reasons) || "Teire's checks did not prove this change.",
      ...(runUrl ? { detailsUrl: runUrl } : {}),
      sites: [],
    }).catch(() => undefined);
    await upsertArtifact(db, {
      repoId: repo.id,
      kind: "pr",
      changeKey: groupKey,
      lineageKey: run.lineageKey ?? lineageKey(groupKey),
      number: pr.number,
      branch,
      headSha: commit.oid,
      state: "open",
      url: pr.url,
      runId: run.id,
    });
    if (issue?.number)
      await octokit.rest.issues
        .createComment({
          owner,
          repo: name,
          issue_number: issue.number,
          body: `@${login} opened #${pr.number} as a draft from this run's best diff: unconfirmed, Teire's checks did not prove it.`,
        })
        .catch(() => undefined);
    await appendEvent(db, run.id, "pr", "draft-anyway", { url: pr.url, number: pr.number, by: login });
    await syncDashboard(ctx, repo.id).catch(() => undefined);
    return {
      status: "done",
      result: `Opened #${pr.number} as an unconfirmed draft`,
      links: [{ label: `#${pr.number}`, href: pr.url }, runLink],
    };
  } finally {
    await rm(checkout.dir, { recursive: true, force: true });
  }
}
