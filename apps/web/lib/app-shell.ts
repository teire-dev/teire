import { and, asc, eq, inArray, installations, repos, sql, systemState } from "@teire/db";
import { cookies } from "next/headers";
import { freshAccess } from "./auth";
import { myInstallations } from "./dashboard";
import { database } from "./db";
import { repoFixMode } from "./fix-mode";
import type { Scope } from "./workspace";

/** The installation the person last chose in the switcher (U1); the first they can see otherwise. */
export const INSTALLATION_COOKIE = "teire-installation";

export async function currentInstallation(userId: string) {
  const all = await myInstallations(userId);
  const chosen = (await cookies()).get(INSTALLATION_COOKIE)?.value;
  return { all, current: all.find((i) => String(i.id) === chosen) ?? all[0] ?? null };
}

/** A private repository counts only when GitHub lists it for this person (U3 review); `r` is `repos`. */
const readable = (userId: string) =>
  sql`(not r.is_private or exists (select 1 from user_repos ur where ur.user_id = ${userId} and ur.repo_id = r.id))`;

/** Repositories with a run Teire is working on now (the sidebar's live dots and the live poll). */
export async function liveRepos(installationId: number, userId: string) {
  const { rows } = await database().execute<{ full_name: string }>(sql`
    select r.full_name from repos r
    where r.installation_id = ${installationId} and ${readable(userId)}
      and exists (select 1 from runs x where x.repo_id = r.id and x.status in ('running', 'stopping'))
  `);
  return rows.map((r) => r.full_name);
}

/** The worker's heartbeat, as /trust reads it: the status line says what it says, never a literal. */
export async function systemLine() {
  const [worker] = await database().select().from(systemState).where(eq(systemState.key, "worker")).limit(1);
  const at = (worker?.value as { at?: string } | undefined)?.at;
  const quietMin = at ? Math.floor((Date.now() - Date.parse(at)) / 60_000) : null;
  return {
    alive: quietMin !== null && quietMin < 5,
    label:
      quietMin === null
        ? "No worker heartbeat yet"
        : quietMin < 5
          ? "Worker running"
          : `Worker quiet ${quietMin} min`,
  };
}

/**
 * The app shell's data (plan revision 3.3, "App shell"): the installations this person can see, the
 * chosen one, its repositories (each with its effective fix mode and whether Teire is working on it
 * now) and the worker's heartbeat.
 */
export async function appShell(userId: string) {
  await freshAccess(userId);
  const { all, current } = await currentInstallation(userId);
  if (!current)
    return {
      installations: all,
      current: null,
      repos: [],
      system: await systemLine(),
      runs: [],
      changes: [],
      prs: [],
    };
  const db = database();
  const [inst] = await db
    .select({ defaultFixMode: installations.defaultFixMode, securityFixMode: installations.securityFixMode })
    .from(installations)
    .where(eq(installations.id, current.id))
    .limit(1);
  const rows = await db
    .select({
      id: repos.id,
      fullName: repos.fullName,
      status: repos.status,
      languages: repos.languages,
      config: repos.config,
      fixMode: repos.fixMode,
    })
    .from(repos)
    .where(
      and(
        eq(repos.installationId, current.id),
        inArray(repos.status, ["active", "onboarding", "paused", "detected"]),
        // Qualified by hand: with no join, Drizzle would leave these columns bare inside the subquery.
        sql`(not "repos"."is_private" or exists (select 1 from user_repos ur where ur.user_id = ${userId} and ur.repo_id = "repos"."id"))`,
      ),
    )
    .orderBy(asc(repos.fullName));
  const [live, system, recent, prs, reaching] = await Promise.all([
    liveRepos(current.id, userId),
    systemLine(),
    // For ⌘K and Ask Teire's @-mentions: the installation's latest runs (their proof chains load when
    // the palette opens, /api/app/palette) and the changes that reach its code.
    database().execute<{ id: string; full_name: string; group_key: string | null; status: string }>(sql`
      select x.id, r.full_name, x.group_key, x.status from runs x join repos r on r.id = x.repo_id
      where r.installation_id = ${current.id} and ${readable(userId)} and x.kind = 'fix' order by x.created_at desc limit 12`),
    // For Ask Teire's @-mentions: the installation's open Teire PRs.
    database().execute<{ number: number; full_name: string; change_key: string }>(sql`
      select a.number, r.full_name, a.change_key from artifacts a join repos r on r.id = a.repo_id
      where r.installation_id = ${current.id} and ${readable(userId)} and a.kind = 'pr' and a.state = 'open'
        and a.number is not null
      order by a.updated_at desc limit 20`),
    database().execute<{
      change_id: string;
      title: string | null;
      repos: number;
      provider: string | null;
      ecosystem: string | null;
    }>(sql`
      select f.change_id, c.title, count(distinct f.repo_id)::int as repos,
        c.provider_slug as provider, c.ecosystem
      from findings f join repos r on r.id = f.repo_id left join changes c on c.id = f.change_id
      where r.installation_id = ${current.id} and ${readable(userId)} and f.verdict = 'affected' and f.state = 'open'
      group by f.change_id, c.title, c.provider_slug, c.ecosystem order by repos desc limit 12`),
  ]);
  return {
    installations: all,
    current,
    repos: rows.map((r) => ({
      fullName: r.fullName,
      status: r.status,
      languages: r.languages,
      live: live.includes(r.fullName),
      fixMode: repoFixMode(r, inst ?? null).mode,
    })),
    system,
    runs: recent.rows.map((r) => ({ id: r.id, repo: r.full_name, groupKey: r.group_key, status: r.status })),
    changes: reaching.rows.map((c) => ({
      id: c.change_id,
      title: c.title ?? c.change_id,
      repos: c.repos,
      provider: c.provider,
      ecosystem: c.ecosystem,
    })),
    prs: prs.rows.map((p) => ({ number: p.number, repo: p.full_name, group: p.change_key })),
  };
}

export type AppShellData = Awaited<ReturnType<typeof appShell>>;

/**
 * What the dashboard's pages read for this person (U3): their chosen installation, its private
 * repositories included (GitHub said they can see it when they signed in). Null with none.
 */
export async function myScope(userId: string) {
  // What GitHub says this person can access, read again when older than ten minutes (U3 review).
  await freshAccess(userId);
  const { current } = await currentInstallation(userId);
  if (!current) return null;
  return {
    scope: { installationId: current.id, account: null, publicOnly: false, userId } satisfies Scope,
    installation: current,
  };
}
