import { eq, repos } from "@teire/db";
import { cacheLife, cacheTag } from "next/cache";
import { database } from "./db";

/**
 * Whether a repository is still public, for the public surfaces (V7 final review: a repository that
 * turns private on GitHub must not stay public in Teire until its stored flag catches up).
 *
 * An installed repository is kept current by GitHub's `repository` webhook (privatized / publicized,
 * applied in the webhook route itself). A repository Teire only scanned publicly sends no webhooks,
 * so its public pages ask GitHub at most every few minutes: an anonymous request for the repository's
 * page answers 404 for a private or deleted one. A 404 hides it at once and records it; anything else
 * (an outage, a timeout) keeps the stored answer.
 */
async function githubSaysPrivate(fullName: string): Promise<boolean | null> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`visibility:${fullName}`);
  try {
    const res = await fetch(`https://github.com/${fullName}`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404) return true;
    // A rename redirects; the repository is still there, and still public.
    if (res.status === 200 || (res.status >= 300 && res.status < 400)) return false;
    return null;
  } catch {
    return null;
  }
}

export async function stillPublic(repo: {
  id: number;
  fullName: string;
  isPrivate: boolean;
  installationId: number | null;
}) {
  if (repo.isPrivate) return false;
  if (repo.installationId) return true;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo.fullName)) return false;
  const privateNow = await githubSaysPrivate(repo.fullName);
  if (privateNow !== true) return true;
  await database().update(repos).set({ isPrivate: true }).where(eq(repos.id, repo.id));
  return false;
}
