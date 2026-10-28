import type { Delivery } from "../outbox";
import {
  appendEvent,
  artifactByBranch,
  getArtifact,
  getRepo,
  markFindings,
  markInstallation,
  openArtifacts,
  removeInstallationData,
  setFindingsState,
  setIgnore,
  setInstallationPaused,
  setRepo,
  upsertArtifact,
  upsertInstallation,
  upsertRepo,
} from "../store";
import { handleRepoAction } from "./actions";
import {
  canWrite,
  FIXES_PAUSED_REPLY,
  handleComment,
  matchesTarget,
  parseCommand,
  startRun,
} from "./commands";
import { syncDashboard, tickedActions } from "./dashboard";
import { requestDryRun } from "./public";
import { ONBOARDING_BRANCH, type WorkerContext } from "./scan";

/** Customer CI read for one repair (C6). */
const CI = { maxChecks: 3, maxLogChars: 6000 } as const;

/**
 * GitHub webhook deliveries → state and jobs (cards C1, C6). Installation and repository changes
 * are recorded; a merged onboarding PR activates the repo; closing or merging a Teire PR marks its
 * findings; a push to the default branch that touches dependencies or code queues a rescan.
 */
export interface EventContext extends WorkerContext {
  enqueueScan: (
    repoId: number,
    trigger: "install" | "push" | "command" | "manual" | "catalog",
  ) => Promise<void>;
  enqueuePublicScan: (publicScanId: string) => Promise<void>;
}

interface RepoPayload {
  id: number;
  full_name: string;
  private: boolean;
  default_branch?: string;
}

/** Manifests and lockfiles: a base change to these makes a Teire PR's lockfile stale. */
const DEPENDENCY_FILES =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|uv\.lock|poetry\.lock|Pipfile\.lock|requirements[^/]*\.txt|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile|libs\.versions\.toml)$/;

/** Manifests, lockfiles, Teire's config and source files of every supported ecosystem. */
const RESCAN_FILES = new RegExp(
  [
    "(^|/)(package\\.json|package-lock\\.json|npm-shrinkwrap\\.json|pnpm-lock\\.yaml|pnpm-workspace\\.yaml|yarn\\.lock|bun\\.lockb?)$",
    "(^|/)(pyproject\\.toml|uv\\.lock|poetry\\.lock|Pipfile(\\.lock)?|pylock[^/]*\\.toml|requirements[^/]*\\.(txt|in)|setup\\.(py|cfg))$",
    "(^|/)(go\\.(mod|sum|work)|Cargo\\.(toml|lock)|Gemfile(\\.lock)?|gems\\.(rb|locked)|[^/]*\\.gemspec)$",
    "(^|/)(pom\\.xml|build\\.gradle(\\.kts)?|settings\\.gradle(\\.kts)?|gradle\\.lockfile|libs\\.versions\\.toml|gradle\\.properties)$",
    "(^|/)(\\.github/)?teire\\.ya?ml$",
    "\\.((c|m)?[jt]sx?|py|go|rs|rb|java|kt)$",
  ].join("|"),
);

export async function handleDelivery(ctx: EventContext, delivery: Delivery) {
  const { db } = ctx;
  // biome-ignore lint/suspicious/noExplicitAny: GitHub webhook JSON, read field by field per event
  const p = delivery.payload as Record<string, any>;
  switch (delivery.event) {
    case "installation": {
      const installation = p.installation;
      // Uninstalled: runs stop and the repos' data is removed. Suspended: its repos pause (D109).
      if (delivery.action === "deleted") {
        await markInstallation(db, installation.id, { deletedAt: new Date() });
        return removeInstallationData(db, installation.id);
      }
      if (delivery.action === "suspend") {
        await markInstallation(db, installation.id, { suspendedAt: new Date() });
        return setInstallationPaused(db, installation.id, true);
      }
      if (delivery.action === "unsuspend") {
        await markInstallation(db, installation.id, { suspendedAt: null });
        return setInstallationPaused(db, installation.id, false);
      }
      await upsertInstallation(db, installation);
      if (delivery.action === "created")
        for (const r of (p.repositories ?? []) as RepoPayload[]) {
          const repo = await upsertRepo(db, r, installation.id);
          await ctx.enqueueScan(repo.id, "install");
        }
      return;
    }
    case "installation_repositories": {
      await upsertInstallation(db, p.installation);
      for (const r of (p.repositories_added ?? []) as RepoPayload[]) {
        const repo = await upsertRepo(db, r, p.installation.id);
        if (repo.status === "disabled") await setRepo(db, repo.id, { status: "detected" });
        await ctx.enqueueScan(repo.id, "install");
      }
      for (const r of (p.repositories_removed ?? []) as RepoPayload[])
        await setRepo(db, r.id, { status: "disabled" });
      return;
    }
    case "repository": {
      if (p.repository) await upsertRepo(db, p.repository, p.installation?.id ?? null);
      return;
    }
    case "pull_request": {
      if (delivery.action !== "closed") return;
      const repo = await getRepo(db, p.repository.id);
      if (!repo) return;
      const branch: string = p.pull_request.head.ref;
      const merged: boolean = p.pull_request.merged === true;
      const artifact = await artifactByBranch(db, repo.id, branch);
      if (!artifact) return;
      await upsertArtifact(db, { ...artifact, state: merged ? "merged" : "closed" });
      if (branch === ONBOARDING_BRANCH) {
        if (merged) {
          await setRepo(db, repo.id, { status: "active" });
          await ctx.enqueueScan(repo.id, "command");
        } else if (repo.status === "onboarding")
          // Closing the onboarding PR is "no thanks" (card C1): paused until `@teire resume`, which
          // starts onboarding again.
          await setRepo(db, repo.id, { status: "paused", pausedFrom: "detected", pausedReason: "opted_out" });
        return;
      }
      // A person's close dismisses that target (D112); Teire's own closes (superseded, stale) don't.
      if (artifact.kind === "pr" && (merged || p.sender?.type !== "Bot"))
        await markFindings(db, repo.id, artifact.changeKey, merged ? "fixed" : "dismissed");
      return;
    }
    case "push": {
      const repo = await getRepo(db, p.repository.id);
      if (!repo || (repo.status !== "active" && repo.status !== "onboarding")) return;
      if (p.ref !== `refs/heads/${repo.defaultBranch}`) return;
      const touched = (
        (p.commits ?? []) as { added?: string[]; modified?: string[]; removed?: string[] }[]
      ).some((c) =>
        [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].some((f) => RESCAN_FILES.test(f)),
      );
      // `schedule: off` means no automatic scans, pushes included (C8).
      const off = (repo.config as { schedule?: string } | null)?.schedule === "off";
      if (touched && !off) await ctx.enqueueScan(repo.id, "push");
      // The base moved (C6): open Teire PRs are re-applied when the push touched dependency files
      // or GitHub reports a conflict; their verification ran against the old base.
      const deps = (
        (p.commits ?? []) as { added?: string[]; modified?: string[]; removed?: string[] }[]
      ).some((c) =>
        [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].some((f) =>
          DEPENDENCY_FILES.test(f),
        ),
      );
      if (!repo.installationId) return;
      const [owner = "", name = ""] = repo.fullName.split("/");
      const { octokit } = await ctx.gh.installation(repo.installationId);
      for (const a of await openArtifacts(db, repo.id)) {
        if (a.kind !== "pr" || !a.number) continue;
        const conflict = deps
          ? true
          : (await octokit.rest.pulls.get({ owner, repo: name, pull_number: a.number }).catch(() => null))
              ?.data.mergeable === false;
        // Paused fixes keep their PRs as they are until `@teire resume-fixes`.
        if (conflict && !repo.fixesPaused)
          await startRun(ctx, repo, octokit, a.changeKey, "rebase", "base-moved");
      }
      return;
    }
    case "issue_comment": {
      if (delivery.action !== "created") return;
      await handleComment(ctx, p);
      // Commands that change what the Dashboard issue lists re-render it now, not at the next scan.
      const command = parseCommand(String(p.comment?.body ?? ""), ctx.gh.slug);
      if (command && ["ignore", "unignore", "pause", "resume"].includes(command.name) && p.repository?.id)
        await syncDashboard(ctx, p.repository.id).catch(() => undefined);
      return;
    }
    case "issues": {
      // Ticks in the Dashboard issue (C7).
      if (delivery.action !== "edited" || p.sender?.type === "Bot") return;
      const repo = await getRepo(db, p.repository.id);
      if (!repo?.installationId) return;
      const dashboard = await getArtifact(db, repo.id, "dashboard");
      if (!dashboard || dashboard.number !== p.issue.number) return;
      const actions = tickedActions(String(p.changes?.body?.from ?? ""), String(p.issue.body ?? ""));
      if (!actions.length) return;
      const [owner = "", name = ""] = repo.fullName.split("/");
      const { octokit } = await ctx.gh.installation(repo.installationId);
      const login = String(p.sender?.login ?? "");
      if (!(await canWrite(octokit, owner, name, login))) {
        await syncDashboard(ctx, repo.id);
        return;
      }
      const done: string[] = [];
      for (const a of actions) {
        if (a.kind === "rescan") {
          await ctx.enqueueScan(repo.id, "command");
          done.push("rescan started");
        } else if (a.kind === "unignore") {
          await setIgnore(db, repo.id, a.key, false);
          await setFindingsState(db, repo.id, (f) => matchesTarget(a.key, f), "open");
          done.push(`unignored \`${a.key}\``);
        } else if (repo.fixesPaused) {
          done.push(`${a.kind} \`${a.key}\`: ${FIXES_PAUSED_REPLY}`);
        } else {
          const { run, created } = await startRun(ctx, repo, octokit, a.key, a.kind, login);
          done.push(
            `${a.kind} \`${a.key}\`: ${created ? "started" : "already running"}${ctx.webUrl ? ` (${ctx.webUrl}/runs/${run.id})` : ""}`,
          );
        }
      }
      await syncDashboard(ctx, repo.id);
      await octokit.rest.issues.createComment({
        owner,
        repo: name,
        issue_number: p.issue.number,
        body: `@${login}: ${done.join("; ")}.`,
      });
      return;
    }
    case "check_suite": {
      // The repo's own CI on a Teire PR (C6): one repair attempt per head commit.
      const suite = p.check_suite;
      if (delivery.action !== "completed" || !["failure", "timed_out"].includes(suite?.conclusion)) return;
      if (suite.app?.slug === ctx.gh.slug) return;
      const repo = await getRepo(db, p.repository.id);
      if (!repo?.installationId || repo.status === "paused" || repo.fixesPaused) return;
      const artifact = await artifactByBranch(db, repo.id, String(suite.head_branch ?? ""));
      if (!artifact || artifact.kind !== "pr" || artifact.state !== "open") return;
      if (artifact.headSha !== suite.head_sha || artifact.ciRepairSha === suite.head_sha) return;
      await upsertArtifact(db, { ...artifact, ciRepairSha: suite.head_sha });
      const [owner = "", name = ""] = repo.fullName.split("/");
      const { octokit } = await ctx.gh.installation(repo.installationId);
      const checks = await failingChecks(octokit, owner, name, suite.head_sha, ctx.gh.slug);
      if (!checks.length) return;
      const { run, created } = await startRun(
        ctx,
        repo,
        octokit,
        artifact.changeKey,
        "ci-repair",
        "ci",
        (runId) => appendEvent(db, runId, "ci", "failure", { checks }),
      );
      if (created && artifact.number)
        await octokit.rest.issues.createComment({
          owner,
          repo: name,
          issue_number: artifact.number,
          body: `CI failed on this PR (${checks.map((c) => `[${c.name}](${c.url})`).join(", ")}). Teire is making one repair attempt from those logs${ctx.webUrl ? `: ${ctx.webUrl}/runs/${run.id}` : "."}`,
        });
      return;
    }
    // Requests from the web (C9), through the same outbox as GitHub's deliveries.
    case "teire.public_scan":
      if (typeof p.publicScanId === "string") await ctx.enqueuePublicScan(p.publicScanId);
      return;
    case "teire.dry_run":
      console.log("[dry-run]", JSON.stringify(await requestDryRun(ctx, p)));
      return;
    case "teire.repo_action":
      console.log("[action]", JSON.stringify(await handleRepoAction(ctx, p)));
      return;
    default:
      return;
  }
}

/** Failing check runs on a commit, other than Teire's, with the end of each log (Actions jobs). */
export async function failingChecks(
  octokit: Awaited<ReturnType<EventContext["gh"]["installation"]>>["octokit"],
  owner: string,
  repo: string,
  sha: string,
  slug: string,
) {
  const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref: sha, per_page: 100 });
  const failed = data.check_runs.filter(
    (c) => (c.conclusion === "failure" || c.conclusion === "timed_out") && c.app?.slug !== slug,
  );
  const out: { name: string; url: string; log: string }[] = [];
  for (const c of failed.slice(0, CI.maxChecks)) {
    let log = [c.output?.title, c.output?.summary, c.output?.text].filter(Boolean).join("\n");
    if (c.app?.slug === "github-actions") {
      const res = await octokit
        .request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", { owner, repo, job_id: c.id })
        .catch(() => null);
      if (res && typeof res.data === "string") log = res.data.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, "");
    }
    out.push({ name: c.name, url: c.html_url ?? c.details_url ?? "", log: log.slice(-CI.maxLogChars) });
  }
  return out;
}
