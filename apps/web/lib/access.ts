import { and, eq, repos, runs, userInstallations } from "@teire/db";
import { headers } from "next/headers";
import { auth } from "./auth";
import { database } from "./db";

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
  if (!row.repo.isPrivate) return row;
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session || !row.repo.installationId) return null;
  const [member] = await db
    .select()
    .from(userInstallations)
    .where(
      and(
        eq(userInstallations.userId, session.user.id),
        eq(userInstallations.installationId, row.repo.installationId),
      ),
    )
    .limit(1);
  return member ? row : null;
}
