import {
  and,
  artifacts,
  asc,
  changes,
  desc,
  eq,
  findings,
  inArray,
  installations,
  llmCalls,
  repos,
  runEvents,
  runs,
  sandboxExecs,
  sql,
  userInstallations,
} from "@teire/db";
import { notFound } from "next/navigation";
import type { LedgerCheck } from "@/components/teire/ledger";
import { database } from "./db";
import { type Proof, proofOfRun } from "./proof";
import { getSession } from "./session";

/**
 * Data for the U0 compositions (plan revision 3.3): real runs, findings and PRs from the forks in the
 * teire-dev installation, read through the web's read-only role. U1–U3 move what survives into the
 * dashboard's own queries.
 */
export const KIT_ACCOUNT = "teire-dev";

/** The kit is for the people building Teire: members of the teire-dev installation, or local dev. */
export async function canSeeKit(userId: string | null) {
  if (process.env.NODE_ENV === "development") return true;
  if (!userId) return false;
  const [row] = await database()
    .select({ id: installations.id })
    .from(userInstallations)
    .innerJoin(installations, eq(installations.id, userInstallations.installationId))
    .where(and(eq(userInstallations.userId, userId), eq(installations.accountLogin, KIT_ACCOUNT)))
    .limit(1);
  return !!row;
}

type Verification = { baseline?: LedgerCheck[]; after?: LedgerCheck[]; reasons?: string[] } | null;

/** Located call sites for a change group in a repository; null for a group the scan never located. */
async function sitesOf(repoId: number, groupKey: string | null) {
  if (!groupKey) return null;
  const rows = await database()
    .select({ callSites: findings.callSites, verdict: findings.verdict })
    .from(findings)
    .where(and(eq(findings.repoId, repoId), eq(findings.groupKey, groupKey)));
  if (!rows.length) return null;
  const located = rows.filter((r) => Array.isArray(r.callSites));
  if (!located.length) return null;
  return located.reduce((n, r) => n + (r.callSites as unknown[]).length, 0);
}

const checksLine = (v: Verification) => {
  const t = v?.after?.find((c) => c.name === "test")?.counts;
  const b = v?.baseline?.find((c) => c.name === "test")?.counts;
  return t ? `tests ${b ? `${b.passed}/${b.collected}` : "–"} → ${t.passed}/${t.collected}` : undefined;
};

/** One run with everything its proof sheet shows. */
export async function kitRun(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const db = database();
  const [row] = await db
    .select({ run: runs, repo: repos })
    .from(runs)
    .innerJoin(repos, eq(repos.id, runs.repoId))
    .where(eq(runs.id, id))
    .limit(1);
  if (!row || row.repo.isPrivate) return null;
  const { run, repo } = row;
  const [[artifact], events, execs, calls, sites] = await Promise.all([
    db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.repoId, repo.id), eq(artifacts.runId, run.id)))
      .limit(1),
    db.select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(asc(runEvents.seq)),
    db.select().from(sandboxExecs).where(eq(sandboxExecs.runId, run.id)).orderBy(asc(sandboxExecs.createdAt)),
    db.select().from(llmCalls).where(eq(llmCalls.runId, run.id)).orderBy(asc(llmCalls.createdAt)),
    sitesOf(repo.id, run.groupKey),
  ]);
  const verification = run.verification as Verification;
  const proof = proofOfRun({
    kind: run.kind,
    status: run.status,
    step: run.step,
    evidenceKind: run.evidenceKind,
    prMode: run.prMode,
    sites,
    artifact: artifact ? { kind: artifact.kind, url: artifact.url, number: artifact.number } : null,
    ...(checksLine(verification) ? { checks: checksLine(verification) as string } : {}),
  });
  return { run, repo, artifact: artifact ?? null, events, execs, calls, sites, verification, proof };
}

export type KitRun = NonNullable<Awaited<ReturnType<typeof kitRun>>>;

/** A row in any list of runs or PRs: enough for the subject, the chain and the evidence. */
export interface RunRow {
  id: string;
  repo: string;
  groupKey: string | null;
  from: string | null;
  to: string | null;
  status: string;
  step: string | null;
  evidence: string | null;
  backend: string | null;
  finishedAt: Date | null;
  createdAt: Date;
  proof: Proof;
  pr: { number: number | null; url: string | null; kind: string } | null;
}

async function rowsOf(where: ReturnType<typeof and>, limit: number): Promise<RunRow[]> {
  const db = database();
  const rows = await db
    .select({ run: runs, repo: repos.fullName, repoId: repos.id })
    .from(runs)
    .innerJoin(repos, eq(repos.id, runs.repoId))
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(and(eq(installations.accountLogin, KIT_ACCOUNT), eq(repos.isPrivate, false), where))
    .orderBy(desc(runs.updatedAt))
    .limit(limit);
  const ids = rows.map((r) => r.run.id);
  const arts = ids.length ? await db.select().from(artifacts).where(inArray(artifacts.runId, ids)) : [];
  return Promise.all(
    rows.map(async ({ run, repo, repoId }) => {
      const art = arts.find((a) => a.runId === run.id);
      const v = run.verification as Verification;
      return {
        id: run.id,
        repo,
        groupKey: run.groupKey,
        from: run.fromVersion,
        to: run.targetVersion,
        status: run.status,
        step: run.step,
        evidence: run.evidenceKind,
        backend: run.backend,
        finishedAt: run.finishedAt,
        createdAt: run.createdAt,
        pr: art ? { number: art.number, url: art.url, kind: art.kind } : null,
        proof: proofOfRun({
          kind: run.kind,
          status: run.status,
          step: run.step,
          evidenceKind: run.evidenceKind,
          prMode: run.prMode,
          sites: await sitesOf(repoId, run.groupKey),
          artifact: art ? { kind: art.kind, url: art.url, number: art.number } : null,
          ...(checksLine(v) ? { checks: checksLine(v) as string } : {}),
        }),
      };
    }),
  );
}

/** The Overview's sections, most urgent first (plan revision 3.3, "Overview"). */
export async function kitOverview() {
  const db = database();
  const [needsYou, openPrs, live, recent, deadlines, repoRows] = await Promise.all([
    rowsOf(
      and(
        sql`${runs.finishedAt} > now() - interval '7 days'`,
        sql`(${runs.evidenceKind} in ('environment_mismatch','needs_live_access','needs_local_service','typecheck_only','regression','timeout','unverified') or (${runs.status} = 'failed' and ${runs.error} like 'stopped:%'))`,
      ),
      8,
    ),
    rowsOf(
      and(
        eq(runs.status, "succeeded"),
        sql`exists (select 1 from artifacts a where a.run_id = ${runs.id} and a.kind = 'pr' and a.state = 'open')`,
      ),
      8,
    ),
    rowsOf(eq(runs.status, "running"), 6),
    rowsOf(sql`${runs.finishedAt} > now() - interval '2 days'`, 8),
    db
      .select({
        changeId: changes.id,
        title: changes.title,
        deadline: changes.deadline,
        provider: changes.providerSlug,
        repos: sql<number>`count(distinct ${findings.repoId})::int`,
      })
      .from(findings)
      .innerJoin(changes, eq(changes.id, findings.changeId))
      .innerJoin(repos, eq(repos.id, findings.repoId))
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .where(
        and(
          eq(installations.accountLogin, KIT_ACCOUNT),
          eq(findings.verdict, "affected"),
          sql`${changes.deadline} > now() - interval '30 days'`,
        ),
      )
      .groupBy(changes.id, changes.title, changes.deadline, changes.providerSlug)
      .orderBy(asc(changes.deadline))
      .limit(6),
    db
      .select({
        id: repos.id,
        fullName: repos.fullName,
        status: repos.status,
        fixesPaused: repos.fixesPaused,
        pausedReason: repos.pausedReason,
        lastScannedAt: repos.lastScannedAt,
        languages: repos.languages,
        affected: sql<number>`(select count(*)::int from findings f where f.repo_id = ${repos.id} and f.verdict = 'affected')`,
        openPrs: sql<number>`(select count(*)::int from artifacts a where a.repo_id = ${repos.id} and a.kind = 'pr' and a.state = 'open')`,
        live: sql<boolean>`exists (select 1 from runs r where r.repo_id = ${repos.id} and r.status = 'running')`,
      })
      .from(repos)
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .where(and(eq(installations.accountLogin, KIT_ACCOUNT), eq(repos.isPrivate, false)))
      .orderBy(desc(repos.lastScannedAt)),
  ]);
  // What each repository's latest finished scan could not check (its coverage record).
  const coverage = await db.execute<{
    full_name: string;
    coverage: {
      gaps?: string[];
      detectOnly?: string[];
      advisoryStatus?: string;
      resolutionLevel?: string;
      unresolvedSites?: number;
    } | null;
  }>(sql`
    select distinct on (r.id) r.full_name, s.coverage
    from scans s join repos r on r.id = s.repo_id join installations i on i.id = r.installation_id
    where i.account_login = ${KIT_ACCOUNT} and not r.is_private and s.status = 'done' and s.coverage is not null
    order by r.id, s.created_at desc`);
  const gaps = coverage.rows
    .map((row) => {
      const c = row.coverage ?? {};
      const said: string[] = [];
      if (c.resolutionLevel && c.resolutionLevel !== "type")
        said.push(`call sites located by ${c.resolutionLevel}, not types`);
      if (c.advisoryStatus && c.advisoryStatus !== "complete") said.push(`advisories ${c.advisoryStatus}`);
      if (c.detectOnly?.length) said.push(`${c.detectOnly.join(", ")}: listed, not analysed`);
      for (const g of c.gaps ?? []) said.push(g);
      return { repo: row.full_name, said, unresolved: c.unresolvedSites ?? 0 };
    })
    .filter((g) => g.said.length);
  return { needsYou, openPrs, live, recent, deadlines, repos: repoRows, gaps };
}

/** One repository's findings grouped by change, its PRs and runs: the Repository page. */
export async function kitRepo(fullName: string) {
  const db = database();
  const [repo] = await db.select().from(repos).where(eq(repos.fullName, fullName)).limit(1);
  if (!repo || repo.isPrivate) return null;
  const [rows, recent] = await Promise.all([
    db
      .select({ finding: findings, change: changes })
      .from(findings)
      .leftJoin(changes, eq(changes.id, findings.changeId))
      .where(eq(findings.repoId, repo.id))
      .orderBy(asc(findings.priority)),
    rowsOf(eq(runs.repoId, repo.id), 12),
  ]);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.finding.groupKey ?? r.finding.changeId;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return { repo, groups: [...groups], runs: recent };
}

/** The sidebar's installation and repositories, with a live dot where a run is going. */
export async function kitShell() {
  const db = database();
  const [account] = await db
    .select({ login: installations.accountLogin, avatarUrl: installations.avatarUrl })
    .from(installations)
    .where(eq(installations.accountLogin, KIT_ACCOUNT))
    .limit(1);
  const list = await db
    .select({
      fullName: repos.fullName,
      paused: repos.fixesPaused,
      live: sql<boolean>`exists (select 1 from runs r where r.repo_id = ${repos.id} and r.status = 'running')`,
    })
    .from(repos)
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(
      and(
        eq(installations.accountLogin, KIT_ACCOUNT),
        eq(repos.isPrivate, false),
        sql`exists (select 1 from findings f where f.repo_id = ${repos.id})`,
      ),
    )
    .orderBy(asc(repos.fullName));
  return {
    account: { login: account?.login ?? KIT_ACCOUNT, avatarUrl: account?.avatarUrl ?? null },
    repos: list.map((r) => ({ fullName: r.fullName, live: r.live, paused: r.paused })),
  };
}

/** Members of the teire-dev installation (or local dev) see the kit; everyone else gets a 404. */
export async function requireKit() {
  const session = await getSession();
  if (!(await canSeeKit(session?.user.id ?? null))) notFound();
}

/** Every recent run across the installation, for the Runs composition. */
export function kitRuns() {
  return rowsOf(sql`true`, 40);
}
