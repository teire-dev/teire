import { actions, and, eq, installations, registryCredentials, repos, userInstallations } from "@teire/db";
import { type ActionKind, INSTALLATION_ACTIONS } from "@teire/engine/actions";
import { parseAction } from "@teire/engine/actions-schema";
import {
  describeFixMode,
  type EffectiveFixMode,
  type FixMode,
  matchesTarget,
  personMayStart,
} from "@teire/engine/config";
import {
  credentialContext,
  keyFromEnv,
  openSecret,
  type RegistryCredential,
} from "@teire/engine/credentials";
import { forGitHub } from "@teire/engine/github";
import { privateHostReason } from "@teire/engine/net";
import {
  type ActionRow,
  cancelQueued,
  findingsWithChanges,
  fixModeOf,
  getAction,
  getArtifact,
  getRepo,
  getRun,
  latestUpgrades,
  markInstallation,
  recordFeedback,
  removeInstallationData,
  setAction,
  setFindingsState,
  setIgnore,
  setRepo,
  setRun,
  settleRunActions,
  upgradeMatches,
  upsertArtifact,
} from "../store";
import { canWrite, FixesOffError, fixesOffReply, runState, startRun } from "./commands";
import { configPr } from "./config-pr";
import { syncDashboard } from "./dashboard";
import type { EventContext } from "./events";
import { requesterToken } from "./public";
import { openDraftAnyway, startReverify } from "./reverify";

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
    await setAction(db, action.id, { actor: login });
    if (parsed.kind === "fix-in-all") return fixInAll(ctx, action, parsed.params, login);
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
    case "activate": {
      // Active BEFORE the onboarding PR closes: the close webhook then reads this as Teire's own close,
      // not a person's "no thanks" (events.ts treats a close of an onboarding repo as an opt-out).
      if (repo.status === "disabled") return refused("Teire isn't installed on this repository any more");
      const was = repo.status;
      await setRepo(db, repo.id, { status: "active", pausedFrom: null, pausedReason: null });
      const onboarding = await getArtifact(db, repo.id, "onboarding");
      let closed = "";
      if (!params.keep && onboarding?.state === "open" && onboarding.number) {
        await octokit.rest.issues.createComment({
          owner,
          repo: name,
          issue_number: onboarding.number,
          body: `Teire was turned on for this repository by @${login} from the welcome page, so this pull request isn't needed. Closing it; Teire's settings live in \`.github/teire.yml\` whenever you want one.`,
        });
        await octokit.rest.pulls.update({
          owner,
          repo: name,
          pull_number: onboarding.number,
          state: "closed",
        });
        await upsertArtifact(db, { ...onboarding, state: "closed" });
        closed = `; onboarding PR #${onboarding.number} closed`;
      } else if (onboarding?.state === "open" && onboarding.number)
        closed = `; onboarding PR #${onboarding.number} kept open`;
      await ctx.enqueueScan(repo.id, "command");
      const mode = await fixModeOf(db, repo);
      return {
        status: "done",
        result: `${was === "active" ? "Already on" : "On"}: scans daily, fixes ${describeFixMode(mode)}${closed}`,
        links: [{ label: repo.fullName, href: `/app/repos/${repo.fullName}` }],
      };
    }
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
      // Nothing is stored while the file decides, not even the same value: it would surface later
      // as a hidden override when the file drops `fixes:` (U1 review).
      if (after.origin === "repo-file" && mode !== null)
        return refused(`Fixes are set in ${after.file} (${describeFixMode(after)}); change \`fixes:\` there`);
      await setRepo(db, repo.id, { fixMode: mode });
      const cancelled =
        after.mode === "off" && before.mode !== "off"
          ? await cancelQueued(db, [repo.id], fixesOffReply(after), login)
          : 0;
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
    case "refresh":
    case "recreate": {
      const group = String(params.group);
      const pr = await getArtifact(db, repo.id, "pr", group);
      if (!pr || (kind !== "recreate" && pr.state !== "open"))
        return refused(
          kind !== "recreate"
            ? `${kind === "rebase" ? "Rebase" : "Refresh"} works on an open Teire pull request`
            : "There is no Teire pull request for that",
        );
      // A refresh is the base-move refresh asked now: the PR re-applied and checked on the current base.
      return started(ctx, repo, octokit, group, kind === "refresh" ? "rebase" : kind, login);
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
          // The next scan applies it; what's open now stays until then (U3 review).
          result: on
            ? `Ignoring ${update} updates of ${target} from the next scan; other updates still come`
            : `${update} updates of ${target} come again from the next scan`,
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
        await settleRunActions(
          db,
          run.id,
          ["fix", "rebase", "refresh", "recreate", "retry-run", "reverify-run"],
          {
            status: "refused",
            result: `Cancelled by @${login} before it started`,
          },
        );
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
      if (run.kind === "reverify") return refused("A re-verify is retried with Re-verify");
      if (run.status !== "failed" && run.status !== "cancelled")
        return refused(`The run is ${run.status}; nothing to retry`);
      return started(ctx, repo, octokit, run.groupKey, "recreate", login);
    }
    case "reverify-run": {
      const run = await getRun(db, String(params.runId));
      if (!run?.groupKey || run.repoId !== repo.id) return refused("That run isn't in this repository");
      const begun = await startReverify(ctx, repo, run.groupKey, login);
      if ("refused" in begun) return refused(begun.refused);
      // Done when that run finishes, with its evidence (settled there).
      return {
        status: "started",
        result: begun.created
          ? `Queued: #${begun.number} is checked again, merged into the base as it is now`
          : "Already re-verifying",
        links: [runLink(begun.run.id)],
      };
    }
    case "open-draft-anyway":
      return openDraftAnyway(ctx, repo, octokit, String(params.runId), login);
    case "config-pr":
    case "starter-config-pr":
      return configPr(ctx, repo, octokit, kind, params, login);
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
        result: runState(run),
        links: [runLink(run.id)],
      };
}

/**
 * Installation-wide actions (D126): the installation's default fix mode, or uninstalling Teire. Only
 * an org admin, or the account owner for a user installation. Membership is read from GitHub now; an
 * answer GitHub didn't give is a refusal.
 */
/**
 * A private registry's credential saved (S18.7, S-P20): the sealed value must open with the worker's
 * key for this installation and host, and the host must be public (S-P19); then it is stored
 * sealed, and taken out of the action's own record.
 */
async function saveRegistryCredential(
  ctx: EventContext,
  action: ActionRow,
  installationId: number,
  params: Record<string, unknown>,
): Promise<Outcome> {
  const key = keyFromEnv(process.env.TEIRE_CREDENTIALS_PRIVATE_KEY);
  if (!key) return refused("Private registries aren't set up on this Teire server yet");
  const host = String(params.host);
  const sealed = String(params.sealed);
  try {
    openSecret(key, sealed, credentialContext(installationId, host));
  } catch {
    return refused(`The credential for ${host} couldn't be read: enter it again`);
  }
  const blocked = await privateHostReason(host);
  if (blocked) return refused(`${blocked}: Teire sends credentials only to public registries`);
  // The registry's URL, when given, is HTTPS on that same host, with nothing in it but the path: the
  // credential goes nowhere else (S18 review S7).
  const url = typeof params.url === "string" && params.url ? new URL(params.url) : null;
  if (url && (url.protocol !== "https:" || url.hostname !== host || url.username || url.password))
    return refused(`The registry URL must be https://${host}/…, without a username or password in it`);
  const values = {
    url: (params.url as string | null) ?? null,
    kind: params.kind as "token" | "basic",
    username: (params.username as string | null) || null,
    sealed,
    createdBy: action.requester,
    updatedAt: new Date(),
  };
  await ctx.db
    .insert(registryCredentials)
    .values({
      installationId,
      ecosystem: params.ecosystem as RegistryCredential["ecosystem"],
      host,
      ...values,
    })
    .onConflictDoUpdate({
      target: [registryCredentials.installationId, registryCredentials.ecosystem, registryCredentials.host],
      set: values,
    });
  return {
    status: "done",
    result: `Saved: Teire sends it to ${host} for installs, version lookups and Dependabot's jobs, never to a repository's code`,
  };
}

async function installationAction(
  ctx: EventContext,
  action: ActionRow,
  parsed: { kind: ActionKind; params: Record<string, unknown> },
  login: string,
): Promise<Outcome> {
  const { db } = ctx;
  // A credential's sealed value leaves the action's record at once, whatever the outcome (S18
  // review S9); the worker keeps it only in memory while it checks and stores it.
  if (parsed.kind === "set-registry-credential")
    await db
      .update(actions)
      .set({ params: { ...parsed.params, sealed: "(received)" } })
      .where(eq(actions.id, action.id));
  if (!action.installationId || !(await sees(db, action.requester, action.installationId)))
    return refused("You no longer have access to this installation");
  const [inst] = await db
    .select()
    .from(installations)
    .where(eq(installations.id, action.installationId))
    .limit(1);
  if (!inst) return refused("Teire is no longer installed there");
  const what =
    parsed.kind === "uninstall"
      ? "uninstall Teire from it"
      : parsed.kind === "set-registry-credential" || parsed.kind === "remove-registry-credential"
        ? "manage its private-registry credentials"
        : "change the installation's default";
  if (inst.accountType === "User") {
    if (inst.accountLogin.toLowerCase() !== login.toLowerCase())
      return refused(`Only ${inst.accountLogin} can ${what}`);
  } else {
    const { octokit } = await ctx.gh.installation(inst.id);
    // The org role, read from GitHub now (D126). Only an org admin passes: GitHub tells Teire that
    // only when the App may read organization members; without that permission nobody passes, and
    // the refusal says what to grant (a repository admin is not an org admin; U1 review).
    const role = await octokit.rest.orgs
      .getMembershipForUser({ org: inst.accountLogin, username: login })
      .then((r) => (r.data.state === "active" ? r.data.role : "none"))
      .catch((error: { status?: number }) => (error.status === 403 ? "unknown" : "none"));
    if (role === "unknown")
      return refused(
        `Teire can't check who administers ${inst.accountLogin}: the Teire app needs the organization permission "Members: read" (an owner of ${inst.accountLogin} grants it in the app's settings on GitHub)`,
      );
    if (role !== "admin") return refused(`Only an admin of ${inst.accountLogin} can ${what}`);
  }
  if (parsed.kind === "set-registry-credential")
    return saveRegistryCredential(ctx, action, inst.id, parsed.params);
  if (parsed.kind === "remove-registry-credential") {
    const host = String(parsed.params.host);
    const removed = await db
      .delete(registryCredentials)
      .where(
        and(
          eq(registryCredentials.installationId, inst.id),
          eq(registryCredentials.ecosystem, parsed.params.ecosystem as RegistryCredential["ecosystem"]),
          eq(registryCredentials.host, host),
        ),
      )
      .returning({ id: registryCredentials.id });
    return removed.length
      ? { status: "done", result: `Removed: Teire no longer sends a credential to ${host}` }
      : refused(`There is no credential for ${host}`);
  }
  if (parsed.kind === "uninstall") {
    if (String(parsed.params.account).toLowerCase() !== inst.accountLogin.toLowerCase())
      return refused(`Type ${inst.accountLogin} to confirm`);
    // Uninstalled as GitHub's own uninstall would: the App's grant ends, runs stop and the
    // repositories' data is removed now; the webhook that follows finds it done.
    await ctx.gh.app.octokit.request("DELETE /app/installations/{installation_id}", {
      installation_id: inst.id,
    });
    await markInstallation(db, inst.id, { deletedAt: new Date() });
    await removeInstallationData(db, inst.id);
    return {
      status: "done",
      result: `Teire is uninstalled from ${inst.accountLogin}: it can't read or change its repositories any more, its runs stopped and their data is removed`,
    };
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
  const cancelled =
    mode === "off" && previous.mode !== "off"
      ? await cancelQueued(db, nowOff, fixesOffReply(reason), login)
      : 0;
  for (const r of repoRows) await syncDashboard(ctx, r.id).catch(() => undefined);
  const names = { auto: "Automatic", ask: "Ask first", off: "Off" } as const;
  return {
    status: "done",
    result: `Installation default: ${names[mode]}${security === "ask" ? " (security fixes ask first)" : ""}; ${follow} repositor${follow === 1 ? "y follows" : "ies follow"} it${cancelled ? `; ${cancelled} queued run${cancelled === 1 ? "" : "s"} cancelled` : ""}`,
    params: { ...parsed.params, previous },
  };
}

/**
 * Fix in all (plan revision 3.3, U3): one action, one Fix now per repository the change reaches, each
 * decided there as Fix now is: paused, fixes off, your write access on GitHub, a PR already open, a
 * run already going. Authority is each repository's own write access (a person can fix only where
 * they can write). The result is a receipt per repository, with every run it started linked.
 */
async function fixInAll(
  ctx: EventContext,
  action: ActionRow,
  params: Record<string, unknown>,
  login: string,
): Promise<Outcome> {
  const { db } = ctx;
  if (!action.installationId || !(await sees(db, action.requester, action.installationId)))
    return refused("You no longer have access to this installation");
  const changeId = String(params.changeId);
  const names = (params.repos as string[]) ?? [];
  const lines: string[] = [];
  const links: { label: string; href: string }[] = [];
  let started = 0;
  for (const fullName of names) {
    const short = fullName.split("/")[1] ?? fullName;
    const [repo] = await db
      .select()
      .from(repos)
      .where(and(eq(repos.fullName, fullName), eq(repos.installationId, action.installationId)))
      .limit(1);
    if (!repo?.installationId) {
      lines.push(`${short}: not in this installation`);
      continue;
    }
    if (repo.status === "paused") {
      lines.push(`${short}: paused`);
      continue;
    }
    const mode = await fixModeOf(db, repo);
    if (!personMayStart(mode)) {
      lines.push(`${short}: fixes off`);
      continue;
    }
    const [owner = "", name = ""] = fullName.split("/");
    const { octokit } = await ctx.gh.installation(repo.installationId);
    if (!(await canWrite(octokit, owner, name, login))) {
      lines.push(`${short}: needs your write access`);
      continue;
    }
    const group = (await findingsWithChanges(db, repo.id)).find(
      (f) => f.changeId === changeId && f.groupKey,
    )?.groupKey;
    if (!group) {
      lines.push(`${short}: no longer reaches the code`);
      continue;
    }
    const open = await getArtifact(db, repo.id, "pr", group);
    if (open?.state === "open" && open.number) {
      lines.push(`${short}: #${open.number} is open`);
      if (open.url) links.push({ label: `${short} #${open.number}`, href: open.url });
      continue;
    }
    const begun = await startRun(ctx, repo, octokit, group, "fix", login).catch((error: unknown) => {
      if (error instanceof FixesOffError) return error;
      throw error;
    });
    if (begun instanceof FixesOffError) {
      lines.push(`${short}: ${begun.message}`);
      continue;
    }
    started++;
    lines.push(`${short}: ${begun.created ? "run queued" : runState(begun.run)}`);
    links.push({ label: short, href: `/runs/${begun.run.id}` });
    await syncDashboard(ctx, repo.id).catch(() => undefined);
  }
  return {
    status: started ? "done" : "refused",
    // Every repository's line is kept (up to 100 of them); the cap only guards a runaway message.
    result: `${started} of ${names.length} started: ${lines.join("; ")}`.slice(0, 16_000),
    links,
  };
}
