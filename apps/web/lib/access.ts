import { and, eq, repos, runs, userRepos } from "@teire/db";
import { headers } from "next/headers";
import { auth, freshAccess } from "./auth";
import { database } from "./db";
import { stillPublic } from "./visibility";

/**
 * Who may see a run: anyone for a public repo; for a private repo, a signed-in user whose GitHub
 * account can see the installation (refreshed at sign-in).
 */
export async function visibleRun(runId: string) {
  if (!/^[0-9a-f-]{36}$/.test(runId)) return null;
  const db = database();
  const [row] = await db
    .select({ run: runs, repo: repos })
    .from(runs)
    .innerJoin(repos, eq(repos.id, runs.repoId))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row) return null;
  // Public only while GitHub still says so (a repository Teire merely scanned sends no webhooks).
  if (!row.repo.isPrivate && (await stillPublic(row.repo))) return row;
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session || !row.repo.installationId) return null;
  // What GitHub says this person can access now, read again when stale (U4 review).
  await freshAccess(session.user.id);
  // The person's own access to this private repository, as GitHub listed it (U3 review); being able
  // to see its installation is not enough.
  const [member] = await db
    .select({ id: userRepos.repoId })
    .from(userRepos)
    .where(
      and(
        eq(userRepos.userId, session.user.id),
        eq(userRepos.repoId, row.repo.id),
        eq(userRepos.installationId, row.repo.installationId),
      ),
    )
    .limit(1);
  return member ? row : null;
}
