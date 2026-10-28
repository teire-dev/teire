import { and, eq, userInstallations } from "@teire/db";
import { matchesTarget, personMayStart } from "@teire/engine/config";
import {
  findingsWithChanges,
  fixModeOf,
  getArtifact,
  getRepo,
  setFindingsState,
  setIgnore,
  setRepo,
} from "../store";
import { canWrite, fixesOffReply, startRun } from "./commands";
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
