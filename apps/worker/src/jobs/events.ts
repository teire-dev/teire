import type { Delivery } from "../outbox";
import {
  artifactByBranch,
  getRepo,
  markFindings,
  markInstallation,
  setRepo,
  upsertArtifact,
  upsertInstallation,
  upsertRepo,
} from "../store";
import { ONBOARDING_BRANCH, type WorkerContext } from "./scan";

/**
 * GitHub webhook deliveries → state and jobs (cards C1, C6). Installation and repository changes
 * are recorded; a merged onboarding PR activates the repo; closing or merging a Teire PR marks its
 * findings; a push to the default branch that touches dependencies or code queues a rescan.
 */
export interface EventContext extends WorkerContext {
  enqueueScan: (repoId: number, trigger: "install" | "push" | "command" | "manual") => Promise<void>;
}

interface RepoPayload {
  id: number;
  full_name: string;
  private: boolean;
  default_branch?: string;
}

const RESCAN_FILES =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.github\/teire\.ya?ml)$|\.(c|m)?[jt]sx?$/;

export async function handleDelivery(ctx: EventContext, delivery: Delivery) {
  const { db } = ctx;
  // biome-ignore lint/suspicious/noExplicitAny: GitHub webhook JSON, read field by field per event
  const p = delivery.payload as Record<string, any>;
  switch (delivery.event) {
    case "installation": {
      const installation = p.installation;
      if (delivery.action === "deleted")
        return markInstallation(db, installation.id, { deletedAt: new Date() });
      if (delivery.action === "suspend")
        return markInstallation(db, installation.id, { suspendedAt: new Date() });
      if (delivery.action === "unsuspend")
        return markInstallation(db, installation.id, { suspendedAt: null });
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
        }
        return;
      }
      if (artifact.kind === "pr")
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
      if (touched) await ctx.enqueueScan(repo.id, "push");
      return;
    }
    default:
      return;
  }
}
