import { timingSafeEqual } from "node:crypto";
import { and, eq, installations, repos, sql, userInstallations, userRepos } from "@teire/db";
import { myScope } from "../app-shell";
import { auth } from "../auth";
import { database } from "../db";
import { KIT_ACCOUNT, KIT_SCOPE, type Scope } from "../workspace";

/**
 * Who Ask Teire answers (plan revision 3.3, U4): a signed-in person, every read scoped to what GitHub
 * says they can see (their chosen installation for lists; any installation they can see for a named
 * repository, private ones only when GitHub lists them for this person). The operator walk (the
 * deployed streaming check and the scripted questions) holds the worker's bearer secret instead and
 * reads only the public teire-dev repositories: nothing a stranger couldn't already open.
 */
export interface Viewer {
  /** Null for the operator walk, which can read but never act. */
  userId: string | null;
  name: string | null;
  scope: Scope | null;
  /** Every installation this person can see (none for the operator walk, which reads the kit's account). */
  installationIds: number[];
  /** The installation's account, for lists and the model's context line. */
  account: string | null;
}

function operatorAllowed(request: Request) {
  const secret = process.env.REVALIDATE_SECRET;
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  return (
    !!secret && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret))
  );
}

export async function viewerOf(request: Request): Promise<Viewer | null> {
  if (request.headers.get("authorization")) {
    if (!operatorAllowed(request)) return null;
    return { userId: null, name: "operator", scope: KIT_SCOPE, installationIds: [], account: KIT_ACCOUNT };
  }
  const session = await auth().api.getSession({ headers: request.headers });
  if (!session) return null;
  const userId = session.user.id;
  const [mine, seen] = await Promise.all([
    myScope(userId),
    database()
      .select({ id: userInstallations.installationId })
      .from(userInstallations)
      .where(eq(userInstallations.userId, userId)),
  ]);
  return {
    userId,
    name: session.user.name ?? null,
    scope: mine?.scope ?? null,
    installationIds: seen.map((r) => r.id),
    account: mine?.installation.login ?? null,
  };
}

export type ReadableRepo = typeof repos.$inferSelect;

/**
 * A repository this viewer may read, by `owner/name`, or why not (said to the person plainly: "You
 * no longer have access to <repo>"). The same rules as the Repository page.
 */
export async function readableRepo(
  viewer: Viewer,
  fullName: string,
): Promise<{ repo: ReadableRepo } | { error: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName))
    return { error: `"${fullName.slice(0, 80)}" isn't a repository name` };
  const db = database();
  const [row] = await db
    .select({ repo: repos, account: installations.accountLogin })
    .from(repos)
    .leftJoin(installations, eq(installations.id, repos.installationId))
    // GitHub names are case-insensitive: "Teire-Dev/NLSH" is teire-dev/nlsh.
    .where(sql`lower(${repos.fullName}) = lower(${fullName})`)
    .limit(1);
  const nope = { error: `You don't have access to ${fullName} in Teire (or Teire isn't installed there)` };
  if (!row?.repo.installationId) return nope;
  if (viewer.userId === null)
    return row.account === KIT_ACCOUNT && !row.repo.isPrivate ? { repo: row.repo } : nope;
  if (!viewer.installationIds.includes(row.repo.installationId)) return nope;
  if (row.repo.isPrivate) {
    const [own] = await db
      .select({ id: userRepos.repoId })
      .from(userRepos)
      .where(and(eq(userRepos.userId, viewer.userId), eq(userRepos.repoId, row.repo.id)))
      .limit(1);
    if (!own) return nope;
  }
  return { repo: row.repo };
}

/** The scope a named repository's lists read: its own installation, under this viewer's rules. */
export function scopeOfRepo(viewer: Viewer, repo: ReadableRepo): Scope {
  if (viewer.userId === null) return KIT_SCOPE;
  return { installationId: repo.installationId, account: null, publicOnly: false, userId: viewer.userId };
}

/**
 * Which of these repositories the viewer may read now, in one query (the same rules as
 * `readableRepo`): what a stored thread is checked against before it is shown or reused.
 */
export async function readableNames(viewer: Viewer, names: string[]): Promise<Set<string>> {
  const wanted = [...new Set(names.filter((n) => /^[\w.-]+\/[\w.-]+$/.test(n)).map((n) => n.toLowerCase()))];
  if (!wanted.length) return new Set();
  const { rows } = await database().execute<{ full_name: string; ok: boolean }>(sql`
    select r.full_name,
      ${
        viewer.userId === null
          ? sql`(i.account_login = ${KIT_ACCOUNT} and not r.is_private)`
          : sql`(r.installation_id in (${sql.join(
              (viewer.installationIds.length ? viewer.installationIds : [-1]).map((id) => sql`${id}`),
              sql`, `,
            )})
              and (not r.is_private or exists (select 1 from user_repos ur where ur.user_id = ${viewer.userId} and ur.repo_id = r.id)))`
      } as ok
    from repos r left join installations i on i.id = r.installation_id
    where lower(r.full_name) in (${sql.join(
      wanted.map((n) => sql`${n}`),
      sql`, `,
    )})`);
  return new Set(rows.filter((r) => r.ok).map((r) => r.full_name.toLowerCase()));
}
