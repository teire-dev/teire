import { account, and, eq, session, user, userInstallations, verification } from "@teire/db";
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

/** `GET /user/installations` with the user's GitHub token → `user_installations`. */
async function refreshInstallations(userId: string) {
  const db = database();
  const [row] = await db
    .select({ token: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  if (!row?.token) return;
  const res = await fetch("https://api.github.com/user/installations?per_page=100", {
    headers: {
      authorization: `Bearer ${row.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return;
  const { installations } = (await res.json()) as { installations: { id: number }[] };
  await db.delete(userInstallations).where(eq(userInstallations.userId, userId));
  if (installations.length)
    await db
      .insert(userInstallations)
      .values(installations.map((i) => ({ userId, installationId: i.id, refreshedAt: new Date() })))
      .onConflictDoNothing();
}
