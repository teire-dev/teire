import { and, asc, eq, inArray, installations, repos, sql, systemState } from "@teire/db";
import { cookies } from "next/headers";
import { myInstallations } from "./dashboard";
import { database } from "./db";
import { repoFixMode } from "./fix-mode";

/** The installation the person last chose in the switcher (U1); the first they can see otherwise. */
export const INSTALLATION_COOKIE = "teire-installation";

export async function currentInstallation(userId: string) {
  const all = await myInstallations(userId);
  const chosen = (await cookies()).get(INSTALLATION_COOKIE)?.value;
  return { all, current: all.find((i) => String(i.id) === chosen) ?? all[0] ?? null };
}

/** Repositories with a run Teire is working on now (the sidebar's live dots and the live poll). */
export async function liveRepos(installationId: number) {
  const { rows } = await database().execute<{ full_name: string }>(sql`
    select r.full_name from repos r
    where r.installation_id = ${installationId}
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
  const { all, current } = await currentInstallation(userId);
  if (!current) return { installations: all, current: null, repos: [], system: await systemLine() };
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
      ),
    )
    .orderBy(asc(repos.fullName));
  const [live, system] = await Promise.all([liveRepos(current.id), systemLine()]);
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
  };
}

export type AppShellData = Awaited<ReturnType<typeof appShell>>;
