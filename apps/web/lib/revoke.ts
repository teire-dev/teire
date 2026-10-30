import {
  account,
  and,
  assistantMessages,
  assistantThreads,
  eq,
  inArray,
  installations,
  repos,
  session,
  userInstallations,
  userRepos,
} from "@teire/db";
import { githubToken } from "./auth";
import { database } from "./db";
import { canRead } from "./workspace";

/**
 * Taking Teire's access away, from inside Teire (what a person can otherwise do only on GitHub):
 * one repository out of an installation, Teire's sign-in authorization, or the whole Teire account.
 * Uninstalling is an installation action (`uninstall`), done by the worker as the App after it checks
 * the person owns or administers the account.
 */

const GITHUB = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

/**
 * Removes one repository from its installation with the person's own GitHub token (GitHub:
 * `DELETE /user/installations/{id}/repositories/{repo}`): they must administer the repository, and
 * the installation must cover selected repositories, not all. GitHub's webhook then tells the worker,
 * which stops Teire there.
 */
export async function removeRepository(
  userId: string,
  fullName: string,
): Promise<{ ok: true } | { error: string; manage?: string }> {
  const db = database();
  const [row] = await db
    .select({
      id: repos.id,
      installationId: repos.installationId,
      isPrivate: repos.isPrivate,
      selection: installations.repositorySelection,
      login: installations.accountLogin,
      type: installations.accountType,
    })
    .from(repos)
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .innerJoin(
      userInstallations,
      and(eq(userInstallations.installationId, repos.installationId), eq(userInstallations.userId, userId)),
    )
    .where(eq(repos.fullName, fullName))
    .limit(1);
  if (!row?.installationId || !(await canRead(userId, row))) return { error: `You can't see ${fullName}` };
  const manage =
    row.type === "Organization"
      ? `https://github.com/organizations/${row.login}/settings/installations/${row.installationId}`
      : `https://github.com/settings/installations/${row.installationId}`;
  if (row.selection === "all")
    return {
      error: `Teire is installed on all of ${row.login}'s repositories. On GitHub, switch the installation to selected repositories to leave this one out.`,
      manage,
    };
  const token = await githubToken(userId);
  if (!token) return { error: "Sign in again: Teire has no GitHub access for you" };
  const res = await fetch(
    `https://api.github.com/user/installations/${row.installationId}/repositories/${row.id}`,
    {
      method: "DELETE",
      headers: { ...GITHUB, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  ).catch(() => null);
  if (!res) return { error: "GitHub didn't answer; try again" };
  if (res.status === 422)
    return {
      error: `GitHub won't remove ${row.login}'s last repository from the installation: uninstall Teire instead.`,
      manage,
    };
  if (res.status === 403 || res.status === 404)
    return { error: `Only an admin of ${fullName} can remove Teire from it.` };
  if (!res.ok && res.status !== 304) return { error: `GitHub refused (HTTP ${res.status})` };
  // The web only reads repositories (its database role): GitHub's webhook tells the worker, which
  // marks it removed and stops its runs, within seconds.
  return { ok: true };
}

/**
 * Ends the authorization the person gave Teire on GitHub (GitHub: `DELETE /applications/{client
 * id}/grant`): every token Teire holds for them stops working, and GitHub no longer lists Teire under
 * their authorized apps. Best effort: a token GitHub already revoked is fine.
 */
export async function revokeGrant(userId: string) {
  const token = await githubToken(userId);
  const id = process.env.GITHUB_CLIENT_ID;
  const secret = process.env.GITHUB_CLIENT_SECRET;
  if (!token || !id || !secret) return false;
  const res = await fetch(`https://api.github.com/applications/${id}/grant`, {
    method: "DELETE",
    headers: {
      ...GITHUB,
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ access_token: token }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  return res?.status === 204 || res?.status === 404;
}

/**
 * What only this person had in Teire: which installations and repositories GitHub says they can
 * see, and their Ask Teire threads (messages go with them). Actions, feedback and spend they recorded
 * on shared repositories stay in those repositories' history under an id that names no one once the
 * account is gone.
 */
export async function forgetPerson(userId: string) {
  const db = database();
  await db.transaction(async (tx) => {
    await tx.delete(userRepos).where(eq(userRepos.userId, userId));
    await tx.delete(userInstallations).where(eq(userInstallations.userId, userId));
    const threads = tx
      .select({ id: assistantThreads.id })
      .from(assistantThreads)
      .where(eq(assistantThreads.userId, userId));
    await tx.delete(assistantMessages).where(inArray(assistantMessages.threadId, threads));
    await tx.delete(assistantThreads).where(eq(assistantThreads.userId, userId));
  });
}

/**
 * Revoke without deleting the account: the GitHub authorization ends, the tokens Teire held and every
 * session go, and what GitHub said they can see is forgotten. Signing in again asks GitHub again.
 */
export async function revokeAccess(userId: string) {
  await revokeGrant(userId);
  const db = database();
  await db
    .update(account)
    .set({ accessToken: null, refreshToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null })
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")));
  await forgetPerson(userId);
  await db.delete(session).where(eq(session.userId, userId));
}
