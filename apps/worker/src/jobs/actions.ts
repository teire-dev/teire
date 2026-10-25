import { and, eq, user, userInstallations } from "@teire/db";
import { matchesTarget } from "@teire/engine/config";
import { findingsWithChanges, getArtifact, getRepo, setFindingsState, setIgnore, setRepo } from "../store";
import { startRun } from "./commands";
import { syncDashboard } from "./dashboard";
import type { EventContext } from "./events";

/**
 * Dashboard actions (S11, the web's repo pages): the `@teire` commands a signed-in person can start
 * from a button, through the outbox as `teire.repo_action`. Access is the installations GitHub said
 * this person can see at sign-in; the Dashboard issue follows every change, as with a comment.
 */
export type RepoAction = "rescan" | "pause" | "resume" | "fix" | "ignore" | "unignore";
const ACTIONS: readonly RepoAction[] = ["rescan", "pause", "resume", "fix", "ignore", "unignore"];

export async function handleRepoAction(
  ctx: EventContext,
  payload: { repoId?: number; action?: string; target?: string; userId?: string },
) {
  const { db } = ctx;
  const { repoId, action, target = "", userId } = payload;
  if (!repoId || !userId || !ACTIONS.includes(action as RepoAction)) return { skipped: "bad request" };
  const repo = await getRepo(db, repoId);
  if (!repo?.installationId) return { skipped: "not installed" };
  const [allowed] = await db
    .select({ id: userInstallations.installationId })
    .from(userInstallations)
    .where(
      and(eq(userInstallations.userId, userId), eq(userInstallations.installationId, repo.installationId)),
    )
    .limit(1);
  if (!allowed) return { skipped: "no access" };
  const [person] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1);
  const by = `web:${person?.name ?? userId}`;

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
      break;
    }
    case "fix": {
      const group = (await findingsWithChanges(db, repo.id)).find(
        (f) => matchesTarget(target, f) && f.groupKey,
      )?.groupKey;
      if (!group) return { skipped: "no finding" };
      const open = await getArtifact(db, repo.id, "pr", group);
      if (open?.state === "open") return { skipped: "PR already open" };
      const { octokit } = await ctx.gh.installation(repo.installationId);
      const { run } = await startRun(ctx, repo, octokit, group, "fix", by);
      return { run: run.id };
    }
  }
  await syncDashboard(ctx, repo.id).catch(() => undefined);
  return { [action as string]: repo.fullName };
}
