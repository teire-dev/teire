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
  systemState,
  userInstallations,
} from "@teire/db";
import { notFound } from "next/navigation";
import type { LedgerCheck } from "@/components/teire/ledger";
import { database } from "./db";
import { repoFixMode } from "./fix-mode";
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

/** What reaches the code for one change group: located call sites (affected findings only), and
 * whether it is a security advisory (whose reach is the installed version, not a call site). */
export interface Reach {
  sites: number | null;
  advisory: boolean;
}

/**
 * Reach for many (repository, group) pairs in one query (review round 2: no query per row). Sites
 * count only findings that reach the code; a group the scan located but that reaches nothing is 0;
 * a group never located (a plain bump) is null.
 */
async function reachOf(pairs: { repoId: number; groupKey: string | null }[]) {
  const wanted = pairs.filter((p): p is { repoId: number; groupKey: string } => !!p.groupKey);
  const out = new Map<string, Reach>();
  if (!wanted.length) return out;
  const rows = await database()
    .select({
      repoId: findings.repoId,
      groupKey: findings.groupKey,
      callSites: findings.callSites,
      verdict: findings.verdict,
      cls: findings.class,
    })
    .from(findings)
    .where(
      and(
        inArray(findings.repoId, [...new Set(wanted.map((p) => p.repoId))]),
        inArray(findings.groupKey, [...new Set(wanted.map((p) => p.groupKey))]),
      ),
    );
  for (const r of rows) {
    const key = `${r.repoId}:${r.groupKey}`;
    const reach = out.get(key) ?? { sites: null, advisory: false };
    const located = Array.isArray(r.callSites) ? (r.callSites as unknown[]).length : null;
    if (r.verdict === "affected") {
      if (r.cls === "security") reach.advisory = true;
      if (located !== null) reach.sites = (reach.sites ?? 0) + located;
    } else if (located !== null && reach.sites === null) reach.sites = 0;
    out.set(key, reach);
  }
  return out;
}

const reachKey = (repoId: number, groupKey: string | null) => `${repoId}:${groupKey}`;

const checksLine = (v: Verification) => {
  const t = v?.after?.find((c) => c.name === "test")?.counts;
  const b = v?.baseline?.find((c) => c.name === "test")?.counts;
  return t ? `tests ${b ? `${b.passed}/${b.collected}` : "–"} → ${t.passed}/${t.collected}` : undefined;
};

/** One run with everything its proof sheet shows. */
export async function kitRun(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const db = database();
  // The kit's installation only, as every list in it (review round 2).
  const [row] = await db
    .select({ run: runs, repo: repos })
    .from(runs)
    .innerJoin(repos, eq(repos.id, runs.repoId))
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(and(eq(runs.id, id), eq(installations.accountLogin, KIT_ACCOUNT)))
    .limit(1);
  if (!row || row.repo.isPrivate) return null;
  const { run, repo } = row;
  const [[artifact], events, execs, calls, reach] = await Promise.all([
    db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.repoId, repo.id), eq(artifacts.runId, run.id)))
      .limit(1),
    db.select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(asc(runEvents.seq)),
    db.select().from(sandboxExecs).where(eq(sandboxExecs.runId, run.id)).orderBy(asc(sandboxExecs.createdAt)),
    db.select().from(llmCalls).where(eq(llmCalls.runId, run.id)).orderBy(asc(llmCalls.createdAt)),
    reachOf([{ repoId: repo.id, groupKey: run.groupKey }]),
  ]);
  const verification = run.verification as Verification;
  const { sites, advisory } = reach.get(reachKey(repo.id, run.groupKey)) ?? { sites: null, advisory: false };
  const proof = proofOfRun({
    kind: run.kind,
    status: run.status,
    step: run.step,
    evidenceKind: run.evidenceKind,
    prMode: run.prMode,
    sites,
    advisory,
    artifact: artifact ? { kind: artifact.kind, url: artifact.url, number: artifact.number } : null,
    ...(checksLine(verification) ? { checks: checksLine(verification) as string } : {}),
  });
  // The agent's model as the calls recorded it, not a name typed into the page.
  const model = calls.find((c) => c.purpose === "fix")?.model ?? calls[0]?.model ?? null;
  return {
    run,
    repo,
    artifact: (artifact ?? null) as typeof artifact | null,
    events,
    execs,
    calls,
    sites,
    advisory,
    verification,
    proof,
    model,
  };
}

export type KitRun = NonNullable<Awaited<ReturnType<typeof kitRun>>>;

/**
 * The run as it stood at one of its events (`?at=<seq>` on the kit's run page): the live state, from
 * the run's own records up to that moment (review round 2: a live composition without waiting for a
 * run). Nothing later shows: no evidence, no PR, no command or model call after it.
 */
export function kitRunAt(data: KitRun, seq: number): KitRun {
  const events = data.events.filter((e) => e.seq <= seq);
  const at = events.at(-1)?.at ?? data.run.startedAt ?? data.run.createdAt;
  const before = (d: Date) => d.getTime() <= at.getTime();
  const step = events.at(-1)?.step ?? "assess";
  const run = {
    ...data.run,
    status: "running" as const,
    step,
    evidenceKind: null,
    prMode: null,
    verification: null,
    finishedAt: null,
  };
  return {
    ...data,
    run,
    events,
    execs: data.execs.filter((x) => before(x.createdAt)),
    calls: data.calls.filter((c) => before(c.createdAt)),
    artifact: null,
    verification: null,
    proof: proofOfRun({
      kind: run.kind,
      status: "running",
      step,
      evidenceKind: null,
      prMode: null,
      sites: data.sites,
      advisory: data.advisory,
      artifact: null,
    }),
  };
}

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
  startedAt: Date | null;
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
  const [arts, reach] = await Promise.all([
    ids.length ? db.select().from(artifacts).where(inArray(artifacts.runId, ids)) : [],
    reachOf(rows.map((r) => ({ repoId: r.repoId, groupKey: r.run.groupKey }))),
  ]);
  return rows.map(({ run, repo, repoId }) => {
    const art = arts.find((a) => a.runId === run.id);
    const v = run.verification as Verification;
    const { sites, advisory } = reach.get(reachKey(repoId, run.groupKey)) ?? { sites: null, advisory: false };
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
      startedAt: run.startedAt,
      createdAt: run.createdAt,
      pr: art ? { number: art.number, url: art.url, kind: art.kind } : null,
      proof: proofOfRun({
        kind: run.kind,
        status: run.status,
        step: run.step,
        evidenceKind: run.evidenceKind,
        prMode: run.prMode,
        sites,
        advisory,
        artifact: art ? { kind: art.kind, url: art.url, number: art.number } : null,
        ...(checksLine(v) ? { checks: checksLine(v) as string } : {}),
      }),
    };
  });
}

/** How many runs match, under the same rules as `rowsOf` (a figure always counts its own list). */
async function countRuns(where: ReturnType<typeof and>) {
  const [row] = await database()
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .innerJoin(repos, eq(repos.id, runs.repoId))
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(and(eq(installations.accountLogin, KIT_ACCOUNT), eq(repos.isPrivate, false), where));
  return row?.n ?? 0;
}

/** Runs that need a person: a draft or an issue in the last week, or a stop. */
const NEEDS_YOU = and(
  sql`${runs.finishedAt} > now() - interval '7 days'`,
  sql`(${runs.evidenceKind} in ('environment_mismatch','needs_live_access','needs_local_service','typecheck_only','pre_existing_failure','regression','timeout','unverified') or (${runs.status} = 'failed' and ${runs.error} like 'stopped:%'))`,
);

/** The Overview's sections, most urgent first (plan revision 3.3, "Overview"). */
export async function kitOverview() {
  const db = database();
  const [needsYou, needsYouCount, liveCount, openPrs, live, recent, deadlines, repoRows] = await Promise.all([
    rowsOf(NEEDS_YOU, 8),
    countRuns(NEEDS_YOU),
    countRuns(eq(runs.status, "running")),
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
          eq(repos.isPrivate, false),
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
        config: repos.config,
        fixMode: repos.fixMode,
        defaultFixMode: installations.defaultFixMode,
        securityFixMode: installations.securityFixMode,
        pausedReason: repos.pausedReason,
        lastScannedAt: repos.lastScannedAt,
        languages: repos.languages,
        affected: sql<number>`(select count(distinct f.group_key)::int from findings f where f.repo_id = ${repos.id} and f.verdict = 'affected')`,
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
  // Every figure counts the same public repositories of the installation its lists show (round 2).
  const [counts] = (
    await db.execute<{ proven: number; open: number; reaching: number }>(sql`
      select
        (select count(*)::int from artifacts a join runs r on r.id = a.run_id join repos p on p.id = a.repo_id join installations i on i.id = p.installation_id
          where i.account_login = ${KIT_ACCOUNT} and not p.is_private and a.kind = 'pr' and a.state = 'open' and r.evidence_kind = 'verified') as proven,
        (select count(*)::int from artifacts a join repos p on p.id = a.repo_id join installations i on i.id = p.installation_id
          where i.account_login = ${KIT_ACCOUNT} and not p.is_private and a.kind = 'pr' and a.state = 'open') as open,
        (select count(distinct f.group_key)::int from findings f join repos p on p.id = f.repo_id join installations i on i.id = p.installation_id
          where i.account_login = ${KIT_ACCOUNT} and not p.is_private and f.verdict = 'affected') as reaching`)
  ).rows;
  return {
    needsYou,
    openPrs,
    live,
    recent,
    deadlines,
    repos: repoRows.map(({ config, defaultFixMode, securityFixMode, fixMode, ...r }) => ({
      ...r,
      fixMode: repoFixMode({ config, fixMode, fullName: r.fullName }, { defaultFixMode, securityFixMode }),
    })),
    gaps,
    counts: { ...(counts ?? { proven: 0, open: 0, reaching: 0 }), needsYou: needsYouCount, live: liveCount },
  };
}

/** One repository's findings grouped by change, its PRs and runs: the Repository page. */
export async function kitRepo(fullName: string) {
  const db = database();
  const [row] = await db
    .select({
      repo: repos,
      defaultFixMode: installations.defaultFixMode,
      securityFixMode: installations.securityFixMode,
    })
    .from(repos)
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(and(eq(repos.fullName, fullName), eq(installations.accountLogin, KIT_ACCOUNT)))
    .limit(1);
  const repo = row?.repo;
  if (!row || !repo || repo.isPrivate) return null;
  const fixMode = repoFixMode(repo, row);
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
  return { repo, fixMode, groups: [...groups], runs: recent };
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
      config: repos.config,
      fixMode: repos.fixMode,
      defaultFixMode: installations.defaultFixMode,
      securityFixMode: installations.securityFixMode,
      languages: repos.languages,
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
  // The worker's heartbeat, as /trust reads it: the status line says what it says, never a literal.
  const [worker] = await db.select().from(systemState).where(eq(systemState.key, "worker")).limit(1);
  const at = (worker?.value as { at?: string } | undefined)?.at;
  const quietMin = at ? Math.floor((Date.now() - Date.parse(at)) / 60_000) : null;
  return {
    system: {
      alive: quietMin !== null && quietMin < 5,
      label:
        quietMin === null
          ? "No worker heartbeat yet"
          : quietMin < 5
            ? "Worker running"
            : `Worker quiet ${quietMin} min`,
    },
    account: { login: account?.login ?? KIT_ACCOUNT, avatarUrl: account?.avatarUrl ?? null },
    repos: list.map((r) => ({
      fullName: r.fullName,
      live: r.live,
      paused: repoFixMode(r, r).mode === "off",
      languages: r.languages,
    })),
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
