import {
  and,
  artifacts,
  desc,
  eq,
  findings,
  inArray,
  installations,
  repos,
  sql,
  userInstallations,
} from "@teire/db";
import { currentInstallation } from "./app-shell";
import { freshAccess, githubLogin, refreshInstallations } from "./auth";
import { myInstallations } from "./dashboard";
import { database } from "./db";
import { repoFixMode } from "./fix-mode";
import { installOutcome } from "./install-outcome";

/**
 * The welcome flow's data (plan revision 3.3, U5): the installation GitHub just sent the person back
 * from (or the one they chose last), each repository it covers that they can see, its first scan as it
 * stands, the languages and packages it read, what reaches its code (the three most urgent changes by
 * name), its onboarding PR and the fix mode it will run with.
 */
export type WelcomeData = Awaited<ReturnType<typeof welcomeOf>>;

export async function welcomeOf(userId: string, asked: number | null) {
  await freshAccess(userId);
  let all = await myInstallations(userId);
  // A brand-new installation isn't in the list read at sign-in: ask GitHub again, once.
  let answered = true;
  if (asked !== null && !all.some((i) => i.id === asked)) {
    answered = await refreshInstallations(userId).catch(() => false);
    all = await myInstallations(userId);
  }
  const installation =
    asked !== null ? (all.find((i) => i.id === asked) ?? null) : (await currentInstallation(userId)).current;
  // GitHub lists it for this person, but the worker hasn't read its webhook yet (GitHub sends people
  // back the moment they install): the page waits for it instead of calling it someone else's.
  if (!installation && asked !== null && answered) {
    const [listed] = await database()
      .select({ id: userInstallations.installationId })
      .from(userInstallations)
      .where(and(eq(userInstallations.userId, userId), eq(userInstallations.installationId, asked)))
      .limit(1);
    if (listed) return { state: "arriving" as const, installation: null, repos: [] };
  }
  if (!installation && asked !== null) {
    // Say which account is signed in and where the installation is, so the way on is plain: GitHub
    // doesn't list it for this account (installed with another one), or GitHub didn't answer.
    const [signedInAs, [on]] = await Promise.all([
      githubLogin(userId),
      database()
        .select({ login: installations.accountLogin })
        .from(installations)
        .where(eq(installations.id, asked))
        .limit(1),
    ]);
    return {
      state: "not-visible" as const,
      installation: null,
      repos: [],
      answered,
      signedInAs,
      installedOn: on?.login || null,
    };
  }
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
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const [latest, reaching, onboarding, packages, top] = ids.length
    ? await Promise.all([
        db.execute<{
          repo_id: number;
          status: string;
          error: string | null;
          created_at: Date;
          finished_at: Date | null;
          upgrades: { security?: boolean }[] | null;
          skipped: "archived" | "empty" | null;
          nothing_readable: boolean | null;
        }>(sql`
          select distinct on (repo_id) repo_id, status, error, created_at, finished_at,
            coverage->>'skipped' as skipped, (coverage->>'nothingReadable')::boolean as nothing_readable,
            (select s2.upgrades from scans s2 where s2.repo_id = scans.repo_id and s2.status = 'done'
              order by s2.created_at desc limit 1) as upgrades
          from scans
          where repo_id in (${idList}) order by repo_id, created_at desc`),
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
        // The packages each repository's last finished scan read.
        // Per ecosystem, so each ecosystem's tile carries its own count (plan revision 3.4, B11).
        db.execute<{ repo_id: number; ecosystem: string; n: number }>(sql`
          select d.repo_id, d.ecosystem, count(distinct d.dependency_key)::int as n
          from dependency_instances d
          join (select distinct on (repo_id) id from scans
                where repo_id in (${idList}) and status = 'done'
                order by repo_id, finished_at desc) s on s.id = d.scan_id
          group by d.repo_id, d.ecosystem`),
        // What reaches each repository's code, most urgent first; a group counts once.
        db.execute<{
          repo_id: number;
          key: string;
          title: string;
          verdict: string;
          deadline: Date | null;
        }>(sql`
          select f.repo_id, coalesce(f.group_key, f.change_id) as key, c.title, f.verdict, c.deadline
          from findings f join changes c on c.id = f.change_id
          where f.repo_id in (${idList}) and f.state = 'open'
            and f.verdict in ('affected', 'needs_human', 'check_by_hand')
          order by f.repo_id, f.priority asc nulls last, c.deadline asc nulls last
          limit 2000`),
      ])
    : [{ rows: [] }, [], [], { rows: [] }, { rows: [] }];
  // Repositories Teire knew here that the installation no longer reaches: shown as needing access
  // on GitHub, never dropped or called removed (Codex walk B11, the Automatic handoff).
  const needsAccess = await db
    .select({ fullName: repos.fullName })
    .from(repos)
    .where(
      and(
        eq(repos.installationId, installation.id),
        eq(repos.status, "disabled"),
        sql`(not "repos"."is_private" or exists (select 1 from user_repos ur where ur.user_id = ${userId} and ur.repo_id = "repos"."id"))`,
      ),
    )
    .orderBy(repos.fullName);
  const manage =
    installation.type === "Organization"
      ? `https://github.com/organizations/${installation.login}/settings/installations/${installation.id}`
      : `https://github.com/settings/installations/${installation.id}`;
  return {
    state: "ok" as const,
    installation: {
      ...installation,
      createdAt: installation.createdAt.toISOString(),
      manage,
      suspended: !!installation.suspendedAt,
    },
    needsAccess: needsAccess.map((r) => r.fullName),
    // Who is signed in, beside whose installation this is (Codex walk B11).
    signedInAs: await githubLogin(userId).catch(() => null),
    repos: rows.map((r) => {
      // A raw query returns bigint ids as strings.
      const scan = latest.rows.find((s) => Number(s.repo_id) === r.id) ?? null;
      const pr = onboarding.find((a) => a.repoId === r.id) ?? null;
      const mode = repoFixMode(r, installation);
      const changes: { key: string; title: string; verdict: string; deadline: string | null }[] = [];
      for (const t of top.rows) {
        if (Number(t.repo_id) !== r.id || changes.some((c) => c.key === t.key)) continue;
        changes.push({
          key: t.key,
          title: t.title,
          verdict: t.verdict,
          deadline: t.deadline ? new Date(t.deadline).toISOString() : null,
        });
        if (changes.length === 3) break;
      }
      return {
        fullName: r.fullName,
        isPrivate: r.isPrivate,
        languages: Array.isArray(r.languages) ? r.languages : [],
        packages: packages.rows
          .filter((p) => Number(p.repo_id) === r.id)
          .reduce((n, p) => n + Number(p.n), 0),
        byEcosystem: Object.fromEntries(
          packages.rows.filter((p) => Number(p.repo_id) === r.id).map((p) => [p.ecosystem, Number(p.n)]),
        ) as Record<string, number>,
        changes,
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
        // What Automatic would start from the latest scan (the Automatic handoff: volume before it starts).
        upgrades: {
          security: (scan?.upgrades ?? []).filter((u) => u.security).length,
          routine: (scan?.upgrades ?? []).filter((u) => !u.security).length,
        },
        onboarding: pr?.number ? { number: pr.number, url: pr.url, state: pr.state } : null,
        // Archived, no commits yet, or nothing Teire reads: no onboarding PR is coming, and the row says why.
        outcome: installOutcome(
          { skipped: scan?.skipped ?? undefined, nothingReadable: scan?.nothing_readable ?? undefined },
          r,
        ),
        fixMode: { mode: mode.mode, file: mode.file, origin: mode.origin },
      };
    }),
  };
}
