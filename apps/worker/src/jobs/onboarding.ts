import { and, artifacts, type Database, eq } from "@teire/db";
import { setRepo, upsertArtifact } from "../store";
import type { WorkerContext } from "./scan";

type Octokit = Awaited<ReturnType<WorkerContext["gh"]["installation"]>>["octokit"];

/**
 * `resume` on a repository whose onboarding pull request was closed (Codex walk B12): the PR's state
 * is read from GitHub (a missed close webhook leaves Teire's copy saying open), the closed PR is
 * reopened when GitHub allows it, and otherwise the next scan opens a new one. Returns what to tell
 * the person, or null when onboarding isn't what's waiting.
 */
export async function resumeOnboarding(
  db: Database,
  repo: { id: number; status: string; pausedReason?: string | null },
  octokit: Octokit,
  owner: string,
  name: string,
): Promise<string | null> {
  const declined = repo.status === "paused" && repo.pausedReason === "opted_out";
  if (repo.status !== "onboarding" && !declined) return null;
  const [pr] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.repoId, repo.id), eq(artifacts.kind, "onboarding")))
    .limit(1);
  if (pr?.number) {
    // A read GitHub didn't answer settles nothing: the state stays and the reply says so (walk-fix
    // review #4). Only "no such PR" starts onboarding over.
    let gone = false;
    const live = await octokit.rest.pulls
      .get({ owner, repo: name, pull_number: pr.number })
      .then((r) => r.data)
      .catch((error: { status?: number }) => {
        if (error.status === 404 || error.status === 410) gone = true;
        return null;
      });
    if (!live && !gone)
      return `GitHub didn't answer about the onboarding pull request #${pr.number}; nothing changed. Try \`@teire resume\` again in a minute.`;
    if (live?.merged) {
      await upsertArtifact(db, { ...pr, state: "merged" });
      await setRepo(db, repo.id, { status: "active", pausedFrom: null, pausedReason: null });
      return `The onboarding pull request #${pr.number} is merged: Teire is on, and this scan fills the Dashboard issue.`;
    }
    if (live?.state === "open") {
      await setRepo(db, repo.id, { status: "onboarding", pausedFrom: null, pausedReason: null });
      return `The onboarding pull request #${pr.number} is open: merge it to turn Teire on.`;
    }
    if (live) {
      // GitHub refuses (422) to reopen a PR whose branch is gone or whose base moved past it.
      const reopened = await octokit.rest.pulls
        .update({ owner, repo: name, pull_number: pr.number, state: "open" })
        .then(() => "yes" as const)
        .catch((error: { status?: number }) =>
          error.status === 422 ? ("no" as const) : ("unknown" as const),
        );
      if (reopened === "unknown")
        return `GitHub didn't answer when Teire reopened the onboarding pull request #${pr.number}; nothing changed. Try \`@teire resume\` again in a minute.`;
      if (reopened === "yes") {
        await upsertArtifact(db, { ...pr, state: "open" });
        await setRepo(db, repo.id, { status: "onboarding", pausedFrom: null, pausedReason: null });
        return `Reopened the onboarding pull request #${pr.number}: merge it to turn Teire on.`;
      }
    }
  }
  // Nothing to reopen (its branch is gone, or there never was one): onboarding starts over.
  await setRepo(db, repo.id, { status: "detected", pausedFrom: null, pausedReason: null });
  return "The onboarding pull request can't be reopened: this scan opens a new one to merge.";
}
