import { and, eq, inArray, installations, repos, runs, userInstallations } from "@teire/db";
import { type ActionKind, INSTALLATION_ACTIONS } from "@teire/engine/actions";
import { parseAction } from "@teire/engine/actions-schema";
import {
  describeFixMode,
  type EffectiveFixMode,
  type FixMode,
  matchesTarget,
  personMayStart,
} from "@teire/engine/config";
import { forGitHub } from "@teire/engine/github";
import {
  type ActionRow,
  findingsWithChanges,
  fixModeOf,
  getAction,
  getArtifact,
  getRepo,
  getRun,
  latestUpgrades,
  recordFeedback,
  setAction,
  setFindingsState,
  setIgnore,
  setRepo,
  setRun,
} from "../store";
import { canWrite, FixesOffError, fixesOffReply, startRun } from "./commands";
import { syncDashboard } from "./dashboard";
import type { EventContext } from "./events";
import { requesterToken } from "./public";

/**
 * Dashboard actions (S11, the web's repo pages): the `@teire` commands a signed-in person can start
 * from a button, through the outbox as `teire.repo_action`. The same rule as a comment command:
 * the person must see the installation and have write access to the repository. The Dashboard
 * issue follows every change, as with a comment.
 */
export type RepoAction = "rescan" | "pause" | "resume" | "fix" | "ignore" | "unignore";
const ACTIONS: readonly RepoAction[] = ["rescan", "pause", "resume", "fix", "ignore", "unignore"];

/** The person's GitHub login, from the token Better Auth stored when they signed in. */
async function githubLogin(token: string | undefined) {
  if (!token) return null;
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  return ((await res.json()) as { login?: string }).login ?? null;
}

export async function handleRepoAction(
  ctx: EventContext,
  payload: { repoId?: number; action?: string; target?: string; userId?: string },
) {
  const { db } = ctx;
  const { repoId, action, target = "", userId } = payload;
  if (!repoId || !userId || !ACTIONS.includes(action as RepoAction)) return { skipped: "bad request" };
  const repo = await getRepo(db, repoId);
  if (!repo?.installationId) return { skipped: "not installed" };
  const [visible] = await db
    .select({ id: userInstallations.installationId })
    .from(userInstallations)
    .where(
      and(eq(userInstallations.userId, userId), eq(userInstallations.installationId, repo.installationId)),
    )
    .limit(1);
  if (!visible) return { skipped: "no access" };
  const [owner = "", name = ""] = repo.fullName.split("/");
  const { octokit } = await ctx.gh.installation(repo.installationId);
  const login = await githubLogin(await requesterToken(db, userId));
  if (!login || !(await canWrite(octokit, owner, name, login))) return { skipped: "needs write access" };

  switch (action as RepoAction) {
    case "rescan":
      if (repo.status === "paused") return { skipped: "paused" };
      await ctx.enqueueScan(repo.id, "manual");
      return { rescan: repo.fullName };
    case "pause":
      if (repo.status !== "paused") await setRepo(db, repo.id, { status: "paused", pausedFrom: repo.status });
      break;
    case "resume":
      if (repo.status === "paused")
        await setRepo(db, repo.id, { status: repo.pausedFrom ?? "active", pausedFrom: null });
      await ctx.enqueueScan(repo.id, "manual");
      break;
    case "ignore":
    case "unignore": {
      if (!target) return { skipped: "no target" };
      const on = action === "ignore";
      await setIgnore(db, repo.id, target, on);
      await setFindingsState(db, repo.id, (f) => matchesTarget(target, f), on ? "ignored" : "open");
      // Ignoring closes the open PR for it, as `@teire ignore` does (C6).
      if (on)
        for (const f of (await findingsWithChanges(db, repo.id)).filter(
          (x) => matchesTarget(target, x) && x.groupKey,
        )) {
          const pr = await getArtifact(db, repo.id, "pr", f.groupKey as string);
          if (pr?.state === "open" && pr.number) {
            await octokit.rest.issues.createComment({
              owner,
              repo: name,
              issue_number: pr.number,
              body: `Closed: @${login} ignored \`${target}\` from the Teire dashboard.`,
            });
            await octokit.rest.pulls.update({ owner, repo: name, pull_number: pr.number, state: "closed" });
          }
        }
      break;
    }
    case "fix": {
      if (repo.status === "paused") return { skipped: "paused" };
      const mode = await fixModeOf(db, repo);
      if (!personMayStart(mode)) return { refused: fixesOffReply(mode) };
      const group = (await findingsWithChanges(db, repo.id)).find(
        (f) => matchesTarget(target, f) && f.groupKey,
      )?.groupKey;
      if (!group) return { skipped: "no finding" };
      const open = await getArtifact(db, repo.id, "pr", group);
      if (open?.state === "open") return { skipped: "PR already open" };
      const { run } = await startRun(ctx, repo, octokit, group, "fix", login);
      return { run: run.id };
    }
  }
  await syncDashboard(ctx, repo.id).catch(() => undefined);
  return { [action as string]: repo.fullName };
}

/**
 * A person's action from the web (plan revision 3.3, "Actions with real results", D121): the web
 * recorded it with its outbox delivery; here it is re-authorized against GitHub as it is now, carried
 * out, and moved to its outcome with the links it produced. "Done" means the effect happened: a
 * rescan when its scan finishes, a fix when its run has started (both settled where that happens).
 */
type Outcome = {
  status: "done" | "refused" | "failed" | "started" | "stopping";
  result: string;
  links?: { label: string; href: string }[];
  params?: Record<string, unknown>;
};
type Octokit = Awaited<ReturnType<EventContext["gh"]["installation"]>>["octokit"];
type Repo = NonNullable<Awaited<ReturnType<typeof getRepo>>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refused = (result: string): Outcome => ({ status: "refused", result });
const runLink = (id: string) => ({ label: "Run", href: `/runs/${id}` });

export async function handleAction(ctx: EventContext, payload: { actionId?: string }) {
  const { db } = ctx;
  if (!payload.actionId || !UUID.test(payload.actionId)) return { skipped: "bad request" };
  const action = await getAction(db, payload.actionId);
  // A redelivery of an action already taken leaves it be.
  if (!action || (action.status !== "requested" && action.status !== "unknown")) return { skipped: true };
  const parsed = parseAction(action.kind, action.params);
  const outcome: Outcome = await (async () => {
    if (!parsed.ok) return refused(parsed.error);
    await setAction(db, action.id, { status: "accepted" });
    const login = await githubLogin(await requesterToken(db, action.requester));
    if (!login) return refused("Teire couldn't read your GitHub account; sign in again");
    if (INSTALLATION_ACTIONS.has(parsed.kind)) return installationAction(ctx, action, parsed, login);
    const repo = action.repoId ? await getRepo(db, action.repoId) : null;
    if (!repo?.installationId) return refused("Teire is no longer installed on this repository");
    if (!(await sees(db, action.requester, repo.installationId)))
      return refused(`You no longer have access to ${repo.fullName}`);
    const [owner = "", name = ""] = repo.fullName.split("/");
    const { octokit } = await ctx.gh.installation(repo.installationId);
    if (!(await canWrite(octokit, owner, name, login)))
      return refused(`You need write access to ${repo.fullName} on GitHub`);
    const done = await repoAction(ctx, repo, octokit, parsed.kind, parsed.params, login);
    await syncDashboard(ctx, repo.id).catch(() => undefined);
    return done;
  })().catch(
    (error: unknown): Outcome => ({
      status: "failed",
      result: forGitHub(error instanceof Error ? error.message : String(error)),
    }),
  );
  await setAction(db, action.id, outcome);
  return { [action.kind]: outcome.status };
}

/** The installation is one this person's GitHub account can see (refreshed at sign-in). */
async function sees(db: EventContext["db"], userId: string, installationId: number) {
  const [row] = await db
    .select({ id: userInstallations.installationId })
    .from(userInstallations)
    .where(and(eq(userInstallations.userId, userId), eq(userInstallations.installationId, installationId)))
    .limit(1);
  return !!row;
}

async function repoAction(
  ctx: EventContext,
  repo: Repo,
  octokit: Octokit,
  kind: ActionKind,
  params: Record<string, unknown>,
  login: string,
): Promise<Outcome> {
  const { db } = ctx;
  const [owner = "", name = ""] = repo.fullName.split("/");
  switch (kind) {
    case "rescan":
      if (repo.status === "paused") return refused("This repository is paused; resume it first");
      await ctx.enqueueScan(repo.id, "manual");
      return { status: "started", result: "Rescanning the default branch" };
    case "pause":
      if (repo.status !== "paused") await setRepo(db, repo.id, { status: "paused", pausedFrom: repo.status });
      return { status: "done", result: "Paused: no scans or pull requests until it is resumed" };
    case "resume":
      if (repo.status === "paused")
        await setRepo(db, repo.id, {
          status: repo.pausedFrom ?? "active",
          pausedFrom: null,
          pausedReason: null,
        });
      await ctx.enqueueScan(repo.id, "manual");
      return { status: "done", result: "Resumed; rescanning" };
    case "set-fix-mode": {
      const before = await fixModeOf(db, repo);
      const mode = (params.mode ?? null) as FixMode | null;
      const after = await fixModeOf(db, { ...repo, fixMode: mode });
      // A file that sets the mode wins (D118): the dashboard can't override it, so nothing is stored.
      if (after.origin === "repo-file" && mode !== null && after.mode !== mode)
        return refused(`Fixes are set in ${after.file} (${describeFixMode(after)}); change \`fixes:\` there`);
      await setRepo(db, repo.id, { fixMode: mode });
      const cancelled =
        after.mode === "off" && before.mode !== "off" ? await cancelQueued(db, [repo.id], after) : 0;
      return {
        status: "done",
        result: `Fix mode: ${describeFixMode(after)}${cancelled ? `; ${cancelled} queued run${cancelled === 1 ? "" : "s"} cancelled` : ""}`,
        // What it was, for Undo.
        params: { ...params, previous: { mode: repo.fixMode ?? null } },
      };
    }
    case "fix": {
      const mode = await fixModeOf(db, repo);
      if (!personMayStart(mode)) return refused(fixesOffReply(mode));
      const target = String(params.target);
      const group =
        (await findingsWithChanges(db, repo.id)).find((f) => matchesTarget(target, f) && f.groupKey)
          ?.groupKey ??
        (await latestUpgrades(db, repo.id)).find((u) => upgradeMatches(target, u.groupKey, u.to))?.groupKey ??
        null;
      if (!group) return refused(`Nothing to fix matches ${target}`);
      const open = await getArtifact(db, repo.id, "pr", group);
      if (open?.state === "open")
        return {
          status: "done",
          result: `Already open: #${open.number}`,
          links: [{ label: `#${open.number}`, href: open.url ?? "" }],
        };
      return started(ctx, repo, octokit, group, "fix", login);
    }
    case "rebase":
    case "recreate": {
      const group = String(params.group);
      const pr = await getArtifact(db, repo.id, "pr", group);
      if (!pr || (kind === "rebase" && pr.state !== "open"))
        return refused(
          kind === "rebase"
            ? "Rebase works on an open Teire pull request"
            : "There is no Teire pull request for that",
        );
      return started(ctx, repo, octokit, group, kind, login);
    }
    case "ignore":
    case "unignore": {
      const target = String(params.target);
      const on = kind === "ignore";
      const update = params.update as string | undefined;
      if (update) {
        await setIgnore(db, repo.id, `${target}@${update}`, on);
        return {
          status: "done",
          result: on
            ? `Ignoring ${update} updates of ${target}; other updates still come`
            : `${update} updates of ${target} come again`,
        };
      }
      await setIgnore(db, repo.id, target, on);
      const n = await setFindingsState(db, repo.id, (f) => matchesTarget(target, f), on ? "ignored" : "open");
      const closed: number[] = [];
      if (on)
        for (const f of (await findingsWithChanges(db, repo.id)).filter(
          (x) => matchesTarget(target, x) && x.groupKey,
        )) {
          const pr = await getArtifact(db, repo.id, "pr", f.groupKey as string);
          if (pr?.state !== "open" || !pr.number || closed.includes(pr.number)) continue;
          await octokit.rest.issues.createComment({
            owner,
            repo: name,
            issue_number: pr.number,
            body: `Closed: @${login} ignored \`${target}\` from the Teire dashboard.`,
          });
          await octokit.rest.pulls.update({ owner, repo: name, pull_number: pr.number, state: "closed" });
          closed.push(pr.number);
        }
      return {
        status: "done",
        result: `${on ? "Ignored" : "Unignored"} ${target} (${n} finding${n === 1 ? "" : "s"})${closed.length ? `; closed ${closed.map((c) => `#${c}`).join(", ")}` : ""}`,
      };
    }
    case "cancel-run": {
      const run = await getRun(db, String(params.runId));
      if (!run || run.repoId !== repo.id) return refused("That run isn't in this repository");
      if (run.status === "queued") {
        await setRun(db, run.id, {
          status: "cancelled",
          step: "cancelled by a person",
          error: `cancelled by @${login} before it started`,
          cancelRequestedAt: new Date(),
          cancelledBy: login,
          finishedAt: new Date(),
        });
        return { status: "done", result: "Cancelled before it started", links: [runLink(run.id)] };
      }
      if (run.status !== "running" && run.status !== "stopping")
        return refused(`The run already ended (${run.status})`);
      // The run's own worker sees this within seconds, stops its sandboxes and settles this action.
      await setRun(db, run.id, { status: "stopping", cancelRequestedAt: new Date(), cancelledBy: login });
      return { status: "stopping", result: "Stopping: closing its sandboxes", links: [runLink(run.id)] };
    }
    case "retry-run": {
      const run = await getRun(db, String(params.runId));
      if (!run?.groupKey || run.repoId !== repo.id) return refused("That run isn't in this repository");
      if (run.status !== "failed" && run.status !== "cancelled")
        return refused(`The run is ${run.status}; nothing to retry`);
      return started(ctx, repo, octokit, run.groupKey, "recreate", login);
    }
    case "feedback":
      await recordFeedback(db, {
        repoId: repo.id,
        groupKey: (params.groupKey as string | undefined) ?? null,
        changeId: null,
        login,
        reason: String(params.reason),
        url: null,
      });
      return { status: "done", result: "Thanks; recorded" };
    default:
      return refused(`${kind} isn't something Teire does for one repository`);
  }
}

/** A run for the group: started (its action is done once the run starts), or the reason it can't. */
async function started(
  ctx: EventContext,
  repo: Repo,
  octokit: Octokit,
  group: string,
  reason: "fix" | "rebase" | "recreate",
  login: string,
): Promise<Outcome> {
  const begun = await startRun(ctx, repo, octokit, group, reason, login).catch((error: unknown) => {
    if (error instanceof FixesOffError) return error;
    throw error;
  });
  if (begun instanceof FixesOffError) return refused(begun.message);
  const { run, created } = begun;
  return created || run.status === "queued"
    ? { status: "started", result: "Queued", links: [runLink(run.id)] }
    : {
        status: "done",
        result: run.status === "running" ? "Already running" : `Already ${run.status} on this commit`,
        links: [runLink(run.id)],
      };
}

/** `@teire fix zod` or Fix now on an upgrade with no finding: matches `npm/zod/4.6.6` by name. */
function upgradeMatches(target: string, groupKey: string, to: string) {
  const t = target.trim();
  const eco = groupKey.split("/")[0] ?? "";
  const pkg = groupKey.endsWith(`/${to}`) ? groupKey.slice(eco.length + 1, -(to.length + 1)) : null;
  return t === groupKey || t === `${eco}/${pkg}` || (!!pkg && (t === pkg || t === `${eco}:${pkg}`));
}

/** Queued fix runs of these repositories stop with the reason, when fixes turn Off (D125). */
async function cancelQueued(db: EventContext["db"], repoIds: number[], mode: EffectiveFixMode) {
  if (!repoIds.length) return 0;
  const rows = await db
    .update(runs)
    .set({ status: "cancelled", step: "fixes off", error: fixesOffReply(mode), finishedAt: new Date() })
    .where(and(inArray(runs.repoId, repoIds), eq(runs.status, "queued"), eq(runs.kind, "fix")))
    .returning({ id: runs.id });
  return rows.length;
}

/**
 * The installation's default fix mode (D126): an org admin, or the account owner for a user
 * installation. Membership is read from GitHub now; an answer GitHub didn't give is a refusal.
 */
async function installationAction(
  ctx: EventContext,
  action: ActionRow,
  parsed: { kind: ActionKind; params: Record<string, unknown> },
  login: string,
): Promise<Outcome> {
  const { db } = ctx;
  if (!action.installationId || !(await sees(db, action.requester, action.installationId)))
    return refused("You no longer have access to this installation");
  const [inst] = await db
    .select()
    .from(installations)
    .where(eq(installations.id, action.installationId))
    .limit(1);
  if (!inst) return refused("Teire is no longer installed there");
  if (inst.accountType === "User") {
    if (inst.accountLogin.toLowerCase() !== login.toLowerCase())
      return refused(`Only ${inst.accountLogin} can change this installation's default`);
  } else {
    const { octokit } = await ctx.gh.installation(inst.id);
    const role = await octokit.rest.orgs
      .getMembershipForUser({ org: inst.accountLogin, username: login })
      .then((r) => (r.data.state === "active" ? r.data.role : null))
      .catch(() => null);
    if (role !== "admin")
      return refused(`Only an admin of ${inst.accountLogin} can change the installation's default`);
  }
  const mode = parsed.params.mode as FixMode;
  const security = (parsed.params.security as "auto" | "ask" | undefined) ?? inst.securityFixMode;
  const previous = { mode: inst.defaultFixMode, security: inst.securityFixMode };
  await db
    .update(installations)
    .set({ defaultFixMode: mode, securityFixMode: security })
    .where(eq(installations.id, inst.id));
  // Repositories that follow the default and are now Off have their queued runs cancelled.
  const repoRows = await db.select().from(repos).where(eq(repos.installationId, inst.id));
  const nowOff: number[] = [];
  let follow = 0;
  for (const r of repoRows) {
    const m = await fixModeOf(db, r);
    if (m.origin === "installation") follow++;
    if (m.mode === "off" && m.origin === "installation") nowOff.push(r.id);
  }
  const reason: EffectiveFixMode = {
    mode,
    origin: "installation",
    file: null,
    security: { mode: security, origin: "installation" },
  };
  const cancelled = mode === "off" && previous.mode !== "off" ? await cancelQueued(db, nowOff, reason) : 0;
  for (const r of repoRows) await syncDashboard(ctx, r.id).catch(() => undefined);
  const names = { auto: "Automatic", ask: "Ask first", off: "Off" } as const;
  return {
    status: "done",
    result: `Installation default: ${names[mode]}${security === "ask" ? " (security fixes ask first)" : ""}; ${follow} repositor${follow === 1 ? "y follows" : "ies follow"} it${cancelled ? `; ${cancelled} queued run${cancelled === 1 ? "" : "s"} cancelled` : ""}`,
    params: { ...parsed.params, previous },
  };
}
