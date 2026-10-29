import { account, and, asc, eq, session, user, userInstallations, userRepos, verification } from "@teire/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { database } from "./db";

/**
 * Sign in with GitHub (the App's own OAuth client), the same path for everyone (D42): a session in
 * Postgres through the Drizzle adapter, as the `teire_web` role. After each sign-in the user's
 * installations are read from GitHub with their token, so the dashboard shows only what they can see.
 */
function create() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set");
  const db = database();
  return betterAuth({
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema: { user, session, account, verification } }),
    socialProviders: { github: { clientId, clientSecret } },
    databaseHooks: {
      session: {
        create: {
          after: async (created) => {
            await refreshInstallations(created.userId).catch((error) =>
              console.warn("[auth] installations", error),
            );
          },
        },
      },
    },
    plugins: [nextCookies()],
  });
}

let instance: ReturnType<typeof create> | null = null;
export function auth() {
  instance ??= create();
  return instance;
}

/** `GET /user/installations` with the user's GitHub token → `user_installations`; true when GitHub answered. */
export async function refreshInstallations(userId: string): Promise<boolean> {
  const db = database();
  const [row] = await db
    .select({ token: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  if (!row?.token) return false;
  const res = await fetch("https://api.github.com/user/installations?per_page=100", {
    headers: {
      authorization: `Bearer ${row.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return false;
  const { installations } = (await res.json()) as { installations: { id: number }[] };
  // Inside each installation, the repositories this person can access (U3 review): an organisation
  // member may see the installation without access to every private repository in it.
  const repoIds = new Map<number, number[]>();
  for (const i of installations) {
    const ids: number[] = [];
    for (let page = 1; page <= ACCESS_PAGES; page++) {
      const r = await fetch(
        `https://api.github.com/user/installations/${i.id}/repositories?per_page=100&page=${page}`,
        {
          headers: {
            authorization: `Bearer ${row.token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      // An answer GitHub didn't give keeps the last known access rather than granting any.
      if (!r.ok) return false;
      const body = (await r.json()) as { repositories: { id: number }[]; total_count: number };
      ids.push(...body.repositories.map((x) => x.id));
      if (ids.length >= body.total_count || !body.repositories.length) break;
    }
    repoIds.set(i.id, ids);
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.delete(userInstallations).where(eq(userInstallations.userId, userId));
    await tx.delete(userRepos).where(eq(userRepos.userId, userId));
    if (installations.length)
      await tx
        .insert(userInstallations)
        .values(installations.map((i) => ({ userId, installationId: i.id, refreshedAt: now })))
        .onConflictDoNothing();
    const rows = [...repoIds].flatMap(([installationId, ids]) =>
      ids.map((repoId) => ({ userId, repoId, installationId, refreshedAt: now })),
    );
    for (let i = 0; i < rows.length; i += 500)
      await tx
        .insert(userRepos)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing();
  });
  return true;
}

/** Pages of 100 repositories read per installation (10 000 repositories). */
const ACCESS_PAGES = 100;
/** What GitHub said a person can access is read again after this long (plan: ten minutes). */
const ACCESS_FRESH_MS = 10 * 60_000;
/** Past this without GitHub answering, private repositories stop being readable until it does. */
const ACCESS_LAPSE_MS = 60 * 60_000;

/**
 * Re-reads this person's installations and repositories from GitHub when the last read is older than
 * ten minutes, before a page shows private repository data. A failed read keeps the last answer for
 * an hour; after that, private access lapses until GitHub answers.
 */
export async function freshAccess(userId: string) {
  const [last] = await database()
    .select({ at: userInstallations.refreshedAt })
    .from(userInstallations)
    .where(eq(userInstallations.userId, userId))
    .orderBy(asc(userInstallations.refreshedAt))
    .limit(1);
  if (last && Date.now() - last.at.getTime() <= ACCESS_FRESH_MS) return;
  const ok = await refreshInstallations(userId).catch((error) => {
    console.warn("[auth] access", error);
    return false;
  });
  // A short GitHub outage keeps the last answer; a long one doesn't keep private access open (U4
  // review): the per-repository grants lapse until GitHub answers again. Public repositories stay.
  if (!ok && last && Date.now() - last.at.getTime() > ACCESS_LAPSE_MS)
    await database().delete(userRepos).where(eq(userRepos.userId, userId));
}
