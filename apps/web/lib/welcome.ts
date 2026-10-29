import { and, artifacts, desc, eq, findings, inArray, repos, scans, sql } from "@teire/db";
import { currentInstallation } from "./app-shell";
import { freshAccess, refreshInstallations } from "./auth";
import { myInstallations } from "./dashboard";
import { database } from "./db";
import { repoFixMode } from "./fix-mode";

/**
 * The welcome flow's data (plan revision 3.3, U5): the installation GitHub just sent the person back
 * from (or the one they chose last), each repository it covers that they can see, its first scan as it
 * stands, what reaches its code, its onboarding PR and the fix mode it will run with.
 */
export type WelcomeData = Awaited<ReturnType<typeof welcomeOf>>;

export async function welcomeOf(userId: string, asked: number | null) {
  await freshAccess(userId);
  let all = await myInstallations(userId);
  // A brand-new installation isn't in the list read at sign-in: ask GitHub again, once.
  if (asked !== null && !all.some((i) => i.id === asked)) {
    await refreshInstallations(userId).catch(() => false);
    all = await myInstallations(userId);
  }
  const installation =
    asked !== null ? (all.find((i) => i.id === asked) ?? null) : (await currentInstallation(userId)).current;
  if (!installation && asked !== null)
    return { state: "not-visible" as const, installation: null, repos: [] };
  if (!installation) return { state: "none" as const, installation: null, repos: [] };
  const db = database();
  const rows = await db
    .select()
    .from(repos)
    .where(
      and(
        eq(repos.installationId, installation.id),
        inArray(repos.status, ["detected", "onboarding", "active", "paused"]),
        // A private repository shows only to people GitHub lists for it (U3 review).
        sql`(not "repos"."is_private" or exists (select 1 from user_repos ur where ur.user_id = ${userId} and ur.repo_id = "repos"."id"))`,
      ),
    )
    .orderBy(repos.fullName);
  const ids = rows.map((r) => r.id);
  const [latest, reaching, onboarding] = ids.length
    ? await Promise.all([
        db.execute<{
          repo_id: number;
          status: string;
          error: string | null;
          created_at: Date;
          finished_at: Date | null;
        }>(sql`
          select distinct on (repo_id) repo_id, status, error, created_at, finished_at from scans
          where repo_id in (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )}) order by repo_id, created_at desc`),
        db
          .select({
            repoId: findings.repoId,
            n: sql<number>`count(distinct coalesce(${findings.groupKey}, ${findings.changeId}))::int`,
          })
          .from(findings)
          .where(
            and(
              inArray(findings.repoId, ids),
              eq(findings.state, "open"),
              inArray(findings.verdict, ["affected", "needs_human", "check_by_hand"]),
            ),
          )
          .groupBy(findings.repoId),
        db
          .select({
            repoId: artifacts.repoId,
            number: artifacts.number,
            url: artifacts.url,
            state: artifacts.state,
          })
          .from(artifacts)
          .where(and(inArray(artifacts.repoId, ids), eq(artifacts.kind, "onboarding")))
          .orderBy(desc(artifacts.updatedAt)),
      ])
    : [{ rows: [] }, [], []];
  const manage =
    installation.type === "Organization"
      ? `https://github.com/organizations/${installation.login}/settings/installations/${installation.id}`
      : `https://github.com/settings/installations/${installation.id}`;
  return {
    state: "ok" as const,
    installation: { ...installation, manage, suspended: !!installation.suspendedAt },
    repos: rows.map((r) => {
      // A raw query returns bigint ids as strings.
      const scan = latest.rows.find((s) => Number(s.repo_id) === r.id) ?? null;
      const pr = onboarding.find((a) => a.repoId === r.id) ?? null;
      const mode = repoFixMode(r, installation);
      return {
        fullName: r.fullName,
        isPrivate: r.isPrivate,
        status: r.status,
        pausedReason: r.pausedReason,
        createdAt: r.createdAt.toISOString(),
        scan: scan
          ? {
              status: scan.status,
              error: scan.error?.slice(0, 200) ?? null,
              at: new Date(scan.finished_at ?? scan.created_at).toISOString(),
            }
          : null,
        reaching: reaching.find((x) => x.repoId === r.id)?.n ?? 0,
        onboarding: pr?.number ? { number: pr.number, url: pr.url, state: pr.state } : null,
        fixMode: { mode: mode.mode, file: mode.file, origin: mode.origin },
      };
    }),
  };
}
