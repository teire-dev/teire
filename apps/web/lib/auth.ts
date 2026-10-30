import {
  account,
  and,
  asc,
  eq,
  session,
  sql,
  user,
  userInstallations,
  userRepos,
  verification,
} from "@teire/db";
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
    // "Delete my Teire account" (Settings → Account): GitHub's authorization for Teire ends while the
    // token is still here, then what only this person had goes; Better Auth removes the user, the
    // GitHub account link and every session. A session older than a day signs in again first.
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (u) => {
          const { forgetPerson, revokeGrant } = await import("./revoke");
          await revokeGrant(u.id);
          await forgetPerson(u.id);
        },
      },
    },
    // Sign-in failures land on /signin with ?error= (said there in plain words), not a default page.
    onAPIError: { errorURL: "/signin" },
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

/**
 * This person's GitHub token, refreshed first when it has expired: a GitHub App's user token lasts
 * eight hours, and Better Auth swaps the refresh token for a new pair and stores it, so the worker,
 * which reads the stored token for actions, finds a live one too. Null without a GitHub account.
 */
export async function githubToken(userId: string): Promise<string | null> {
  const [row] = await database()
    .select({ id: account.id, token: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  if (!row) return null;
  const fresh = await auth()
    .api.getAccessToken({ body: { accountId: row.id, userId } })
    .catch(() => null);
  return fresh?.accessToken || row.token || null;
}

/** The GitHub login this person signed in with (Better Auth keeps their display name, not the login). */
export async function githubLogin(userId: string): Promise<string | null> {
  const token = await githubToken(userId);
  if (!token) return null;
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return res?.ok ? (((await res.json()) as { login?: string }).login ?? null) : null;
}

/** `GET /user/installations` with the user's GitHub token → `user_installations`; true when GitHub answered. */
export async function refreshInstallations(userId: string): Promise<boolean> {
  const db = database();
  const token = await githubToken(userId);
  if (!token) return false;
  const res = await fetch("https://api.github.com/user/installations?per_page=100", {
    headers: {
      authorization: `Bearer ${token}`,
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
  // An installation GitHub didn't list this time keeps its last known grants (never widened); the
  // others are rewritten. One suspended installation no longer stalls everyone's refresh (U4 review).
  const kept = new Set<number>();
  for (const i of installations) {
    const ids: number[] = [];
    let complete = true;
    for (let page = 1; page <= ACCESS_PAGES; page++) {
      const r = await fetch(
        `https://api.github.com/user/installations/${i.id}/repositories?per_page=100&page=${page}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10_000),
        },
      ).catch(() => null);
      if (!r?.ok) {
        complete = false;
        break;
      }
      const body = (await r.json()) as { repositories: { id: number }[]; total_count: number };
      ids.push(...body.repositories.map((x) => x.id));
      if (ids.length >= body.total_count || !body.repositories.length) break;
    }
    if (complete) repoIds.set(i.id, ids);
    else kept.add(i.id);
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.delete(userInstallations).where(eq(userInstallations.userId, userId));
    await tx.delete(userRepos).where(
      and(
        eq(userRepos.userId, userId),
        kept.size
          ? sql`${userRepos.installationId} not in (${sql.join(
              [...kept].map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql`true`,
      ),
    );
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
/** After a failed read, GitHub isn't asked again for this person for a while (per function instance). */
const failedAt = new Map<string, number>();
const ACCESS_RETRY_MS = 2 * 60_000;

export async function freshAccess(userId: string) {
  const [last] = await database()
    .select({ at: userInstallations.refreshedAt })
    .from(userInstallations)
    .where(eq(userInstallations.userId, userId))
    .orderBy(asc(userInstallations.refreshedAt))
    .limit(1);
  if (last && Date.now() - last.at.getTime() <= ACCESS_FRESH_MS) return;
  if (Date.now() - (failedAt.get(userId) ?? 0) < ACCESS_RETRY_MS) return;
  const ok = await refreshInstallations(userId).catch((error) => {
    console.warn("[auth] access", error);
    return false;
  });
  if (ok) failedAt.delete(userId);
  else failedAt.set(userId, Date.now());
  // A short GitHub outage keeps the last answer; a long one doesn't keep private access open (U4
  // review): the per-repository grants lapse until GitHub answers again. Public repositories stay.
  if (!ok && last && Date.now() - last.at.getTime() > ACCESS_LAPSE_MS)
    await database().delete(userRepos).where(eq(userRepos.userId, userId));
}
