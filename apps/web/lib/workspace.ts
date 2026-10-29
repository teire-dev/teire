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
  userRepos,
} from "@teire/db";
import { notFound } from "next/navigation";
import type { LedgerCheck } from "@/components/teire/ledger";
import { database } from "./db";
import { repoFixMode } from "./fix-mode";
import { type Proof, proofOfRun } from "./proof";
import { reachKey, reachOf } from "./reach";
import { getSession } from "./session";

/**
 * The dashboard's data (plan revision 3.3, U3), one set of queries for every scope: the signed-in
 * person's chosen installation (its private repositories included, since GitHub said they can see
 * them), or the kit's public teire-dev repositories. Read through the web's read-only role.
 */
export const KIT_ACCOUNT = "teire-dev";

/** Which repositories a page reads: one installation (by id or account) and whether private ones count. */
export interface Scope {
  installationId: number | null;
  account: string | null;
  publicOnly: boolean;
  /**
   * Whose access decides private repositories (U3 review): only those GitHub lists for this person
   * (`user_repos`); public ones in the installation are open to its members.
   */
  userId: string | null;
}

export const KIT_SCOPE: Scope = {
  installationId: null,
  account: KIT_ACCOUNT,
  publicOnly: true,
  userId: null,
};

/** The scope as a condition on `repos` joined to `installations`. */
function scopeWhere(s: Scope) {
  return and(
    s.installationId !== null
      ? eq(repos.installationId, s.installationId)
      : eq(installations.accountLogin, s.account ?? ""),
    s.publicOnly || !s.userId
      ? eq(repos.isPrivate, false)
      : sql`(not ${repos.isPrivate} or exists (select 1 from user_repos ur where ur.user_id = ${s.userId} and ur.repo_id = ${repos.id}))`,
  );
}

/** The scope in hand-written SQL, for the given aliases of `repos` and `installations`. */
export function scopeRaw(s: Scope, repo: string, inst: string) {
  return sql.join(
    [
      s.installationId !== null
        ? sql`${sql.raw(repo)}.installation_id = ${s.installationId}`
        : sql`${sql.raw(inst)}.account_login = ${s.account ?? ""}`,
      s.publicOnly || !s.userId
        ? sql`not ${sql.raw(repo)}.is_private`
        : sql`(not ${sql.raw(repo)}.is_private or exists (select 1 from user_repos ur where ur.user_id = ${s.userId} and ur.repo_id = ${sql.raw(repo)}.id))`,
    ],
    sql` and `,
  );
}

/** Whether a person may read a repository's data: public, or listed for them by GitHub (U3 review). */
export async function canRead(userId: string, repo: { id: number; isPrivate: boolean }) {
  if (!repo.isPrivate) return true;
  const [row] = await database()
    .select({ id: userRepos.repoId })
    .from(userRepos)
    .where(and(eq(userRepos.userId, userId), eq(userRepos.repoId, repo.id)))
    .limit(1);
  return !!row;
}

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

export async function rowsOf(
  scope: Scope,
  where: ReturnType<typeof and>,
  limit: number,
  offset = 0,
): Promise<RunRow[]> {
  const db = database();
  const rows = await db
    .select({ run: runs, repo: repos.fullName, repoId: repos.id })
    .from(runs)
    .innerJoin(repos, eq(repos.id, runs.repoId))
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(and(scopeWhere(scope), where))
    .orderBy(desc(runs.updatedAt), desc(runs.id))
    .limit(limit)
    .offset(offset);
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
export async function countRuns(scope: Scope, where: ReturnType<typeof and>) {
  const [row] = await database()
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .innerJoin(repos, eq(repos.id, runs.repoId))
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(and(scopeWhere(scope), where));
  return row?.n ?? 0;
}

/** Runs that need a person: a draft or an issue in the last week, or a stop. */
export const NEEDS_YOU = and(
  sql`${runs.finishedAt} > now() - interval '7 days'`,
  sql`(${runs.evidenceKind} in ('environment_mismatch','needs_live_access','needs_local_service','typecheck_only','pre_existing_failure','regression','timeout','unverified') or (${runs.status} = 'failed' and ${runs.error} like 'stopped:%'))`,
);

/** The Overview's sections, most urgent first (plan revision 3.3, "Overview"). */
export async function overviewOf(scope: Scope) {
  const db = database();
  const [needsYou, needsYouCount, liveCount, openPrs, live, recent, deadlines, repoRows] = await Promise.all([
    rowsOf(scope, NEEDS_YOU, 8),
    countRuns(scope, NEEDS_YOU),
    // The same runs the "Working now" list shows: queued, running and stopping (U4 review).
    countRuns(scope, inArray(runs.status, ["queued", "running", "stopping"])),
    rowsOf(
      scope,
      and(
        // Every run that holds an open PR now, whatever it ended as: the list its count counts.
        sql`exists (select 1 from artifacts a where a.run_id = ${runs.id} and a.kind = 'pr' and a.state = 'open')`,
      ),
      8,
    ),
    rowsOf(scope, inArray(runs.status, ["queued", "running", "stopping"]), 6),
    rowsOf(scope, sql`${runs.finishedAt} > now() - interval '2 days'`, 8),
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
          scopeWhere(scope),
          eq(findings.verdict, "affected"),
          // Only what still needs fixing: an ignored or fixed finding has no deadline for you (U4 review).
          eq(findings.state, "open"),
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
        affected: sql<number>`(select count(distinct coalesce(f.group_key, f.change_id))::int from findings f where f.repo_id = ${repos.id} and f.state = 'open' and f.verdict in ('affected', 'needs_human', 'check_by_hand'))`,
        openPrs: sql<number>`(select count(*)::int from artifacts a where a.repo_id = ${repos.id} and a.kind = 'pr' and a.state = 'open')`,
        live: sql<boolean>`exists (select 1 from runs r where r.repo_id = ${repos.id} and r.status in ('running', 'stopping'))`,
      })
      .from(repos)
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .where(scopeWhere(scope))
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
    where ${scopeRaw(scope, "r", "i")} and s.status = 'done' and s.coverage is not null
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
  // Every figure counts the same repositories its lists show (round 2); "reaching code" is the Findings
  // tab's own count, per repository: open groups that are affected or need a person (U3 review).
  const [counts] = (
    await db.execute<{ proven: number; open: number; reaching: number }>(sql`
      select
        (select count(*)::int from artifacts a join runs r on r.id = a.run_id join repos p on p.id = a.repo_id join installations i on i.id = p.installation_id
          where ${scopeRaw(scope, "p", "i")} and a.kind = 'pr' and a.state = 'open' and r.evidence_kind = 'verified') as proven,
        (select count(*)::int from artifacts a join runs r on r.id = a.run_id join repos p on p.id = a.repo_id join installations i on i.id = p.installation_id
          where ${scopeRaw(scope, "p", "i")} and a.kind = 'pr' and a.state = 'open') as open,
        (select count(distinct (f.repo_id, coalesce(f.group_key, f.change_id)))::int from findings f join repos p on p.id = f.repo_id join installations i on i.id = p.installation_id
          where ${scopeRaw(scope, "p", "i")} and f.state = 'open' and f.verdict in ('affected', 'needs_human', 'check_by_hand')) as reaching`)
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
export async function repoOf(scope: Scope, fullName: string) {
  const db = database();
  const [row] = await db
    .select({
      repo: repos,
      defaultFixMode: installations.defaultFixMode,
      securityFixMode: installations.securityFixMode,
    })
    .from(repos)
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(and(eq(repos.fullName, fullName), scopeWhere(scope)))
    .limit(1);
  const repo = row?.repo;
  if (!row || !repo) return null;
  const fixMode = repoFixMode(repo, row);
  const [rows, recent] = await Promise.all([
    db
      .select({ finding: findings, change: changes })
      .from(findings)
      .leftJoin(changes, eq(changes.id, findings.changeId))
      .where(eq(findings.repoId, repo.id))
      .orderBy(asc(findings.priority)),
    rowsOf(scope, eq(runs.repoId, repo.id), 12),
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

/** Every recent run across the scope, newest first, for the Runs page. */
export function runsOf(scope: Scope, where: ReturnType<typeof and> = sql`true`, limit = 60, offset = 0) {
  return rowsOf(scope, where, limit, offset);
}

/** The kit compositions read the same queries over the kit's scope. */
export const kitOverview = () => overviewOf(KIT_SCOPE);
export const kitRepo = (fullName: string) => repoOf(KIT_SCOPE, fullName);
export const kitRuns = () => runsOf(KIT_SCOPE, sql`true`, 40);

/** One repository a change reaches, and what Fix now would do there. */
export interface ChangeReach {
  repo: string;
  groupKey: string;
  sites: number;
  /**
   * What Fix now does there, as the worker decides it (U3 review): starts a run (or waits for the PR
   * limit), its PR is already open, a run for it is already going, fixes are off, or Teire is paused.
   */
  plan:
    | { kind: "run"; waits?: string }
    | { kind: "open"; number: number; url: string | null }
    | { kind: "running"; runId: string }
    | { kind: "off"; why: string }
    | { kind: "paused" };
}

/**
 * Changes for you (plan revision 3.3, U3): every catalog change that reaches code in the scope, with
 * the repositories it reaches, newest deadline first, then by how many repositories it reaches.
 */
export async function changesFor(scope: Scope) {
  const db = database();
  const rows = await db
    .select({
      changeId: changes.id,
      title: changes.title,
      kind: changes.kind,
      provider: changes.providerSlug,
      ecosystem: changes.ecosystem,
      subject: changes.subjectName,
      from: changes.fromVersion,
      to: changes.toVersion,
      deadline: changes.deadline,
      repo: repos.fullName,
      repoId: repos.id,
      repoStatus: repos.status,
      config: repos.config,
      fixMode: repos.fixMode,
      defaultFixMode: installations.defaultFixMode,
      securityFixMode: installations.securityFixMode,
      groupKey: findings.groupKey,
      callSites: findings.callSites,
    })
    .from(findings)
    .innerJoin(changes, eq(changes.id, findings.changeId))
    .innerJoin(repos, eq(repos.id, findings.repoId))
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(and(scopeWhere(scope), eq(findings.verdict, "affected"), eq(findings.state, "open")));
  const ids = [...new Set(rows.map((r) => r.repoId))];
  const going = ids.length
    ? await db
        .select({ id: runs.id, repoId: runs.repoId, groupKey: runs.groupKey })
        .from(runs)
        .where(
          and(
            inArray(runs.repoId, ids),
            eq(runs.kind, "fix"),
            inArray(runs.status, ["queued", "running", "stopping"]),
          ),
        )
    : [];
  const open = rows.length
    ? await db
        .select({
          repoId: artifacts.repoId,
          changeKey: artifacts.changeKey,
          number: artifacts.number,
          url: artifacts.url,
        })
        .from(artifacts)
        .where(
          and(
            inArray(artifacts.repoId, [...new Set(rows.map((r) => r.repoId))]),
            eq(artifacts.kind, "pr"),
            eq(artifacts.state, "open"),
          ),
        )
    : [];
  const byChange = new Map<
    string,
    {
      id: string;
      title: string;
      kind: string;
      provider: string | null;
      ecosystem: string | null;
      subject: string | null;
      from: string | null;
      to: string | null;
      deadline: Date | null;
      reaches: ChangeReach[];
    }
  >();
  for (const r of rows) {
    if (!r.groupKey) continue;
    const entry = byChange.get(r.changeId) ?? {
      id: r.changeId,
      title: r.title,
      kind: r.kind,
      provider: r.provider,
      ecosystem: r.ecosystem,
      subject: r.subject,
      from: r.from,
      to: r.to,
      deadline: r.deadline,
      reaches: [],
    };
    byChange.set(r.changeId, entry);
    if (entry.reaches.some((x) => x.repo === r.repo && x.groupKey === r.groupKey)) continue;
    const pr = open.find((a) => a.repoId === r.repoId && a.changeKey === r.groupKey);
    const run = going.find((x) => x.repoId === r.repoId && x.groupKey === r.groupKey);
    const mode = repoFixMode({ config: r.config, fixMode: r.fixMode, fullName: r.repo }, r);
    // The open-PR limit (teire.yml `pullRequests.limit`, 5 by default): a new PR waits for it.
    const limit = (r.config as { pullRequests?: { limit?: number } } | null)?.pullRequests?.limit ?? 5;
    const openHere = open.filter((a) => a.repoId === r.repoId).length;
    entry.reaches.push({
      repo: r.repo,
      groupKey: r.groupKey,
      sites: Array.isArray(r.callSites) ? r.callSites.length : 0,
      plan:
        r.repoStatus === "paused"
          ? { kind: "paused" }
          : pr?.number
            ? { kind: "open", number: pr.number, url: pr.url }
            : run
              ? { kind: "running", runId: run.id }
              : mode.mode === "off"
                ? {
                    kind: "off",
                    why: mode.file
                      ? `set in ${mode.file}`
                      : mode.origin === "dashboard"
                        ? "set here"
                        : "the installation's default",
                  }
                : openHere >= limit
                  ? { kind: "run", waits: `waits for the PR limit (${openHere} of ${limit} open)` }
                  : { kind: "run" },
    });
  }
  // Most urgent first: the soonest deadline ahead, then the most recently passed, then undated by reach.
  const now = Date.now();
  const rank = (d: Date | null): [number, number] => {
    const t = d?.getTime();
    if (t === undefined) return [2, 0];
    return t >= now ? [0, t] : [1, -t];
  };
  return [...byChange.values()].sort((a, b) => {
    const [ga, ta] = rank(a.deadline);
    const [gb, tb] = rank(b.deadline);
    return ga - gb || ta - tb || b.reaches.length - a.reaches.length;
  });
}

export type ChangeForYou = Awaited<ReturnType<typeof changesFor>>[number];

/** The Repositories table (plan revision 3.3, U3): every repository in the scope with its state and counts. */
export async function reposOf(scope: Scope) {
  const rows = await database()
    .select({
      id: repos.id,
      fullName: repos.fullName,
      status: repos.status,
      isPrivate: repos.isPrivate,
      config: repos.config,
      fixMode: repos.fixMode,
      defaultFixMode: installations.defaultFixMode,
      securityFixMode: installations.securityFixMode,
      pausedReason: repos.pausedReason,
      lastScannedAt: repos.lastScannedAt,
      languages: repos.languages,
      affected: sql<number>`(select count(distinct coalesce(f.group_key, f.change_id))::int from findings f where f.repo_id = ${repos.id} and f.state = 'open' and f.verdict in ('affected', 'needs_human', 'check_by_hand'))`,
      openPrs: sql<number>`(select count(*)::int from artifacts a where a.repo_id = ${repos.id} and a.kind = 'pr' and a.state = 'open')`,
      needsYou: sql<number>`(select count(*)::int from runs where runs.repo_id = ${repos.id} and ${NEEDS_YOU})`,
      live: sql<boolean>`exists (select 1 from runs r where r.repo_id = ${repos.id} and r.status in ('running', 'stopping'))`,
      lastScanFailed: sql<boolean>`coalesce((select s.status = 'failed' from scans s where s.repo_id = ${repos.id} order by s.created_at desc limit 1), false)`,
    })
    .from(repos)
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(scopeWhere(scope))
    .orderBy(asc(repos.fullName));
  return rows.map(({ config, defaultFixMode, securityFixMode, fixMode, ...r }) => ({
    ...r,
    config,
    fixMode: repoFixMode({ config, fixMode, fullName: r.fullName }, { defaultFixMode, securityFixMode }),
  }));
}

export type RepoListRow = Awaited<ReturnType<typeof reposOf>>[number];

/** Usage in the scope (plan revision 3.3, Settings › Usage): runs, sandbox time, model spend by purpose. */
export async function usageOf(scope: Scope) {
  const db = database();
  const { rows } = await db.execute<{ purpose: string; calls: number; tokens: string; cost: string }>(sql`
    select c.purpose, count(*)::int as calls, coalesce(sum(c.tokens_in + c.tokens_out), 0)::bigint as tokens,
      coalesce(sum(c.cost_usd), 0)::float as cost
    from llm_calls c join runs r on r.id = c.run_id join repos p on p.id = r.repo_id
      join installations i on i.id = p.installation_id
    where ${scopeRaw(scope, "p", "i")} and c.created_at > now() - interval '30 days'
    group by c.purpose order by cost desc`);
  const [totals] = (
    await db.execute<{ runs: number; sandbox_ms: string }>(sql`
      select
        (select count(*)::int from runs r join repos p on p.id = r.repo_id join installations i on i.id = p.installation_id
          where ${scopeRaw(scope, "p", "i")} and r.created_at > now() - interval '30 days') as runs,
        (select coalesce(sum(x.duration_ms), 0)::bigint from sandbox_execs x join runs r on r.id = x.run_id
          join repos p on p.id = r.repo_id join installations i on i.id = p.installation_id
          where ${scopeRaw(scope, "p", "i")} and x.created_at > now() - interval '30 days') as sandbox_ms`)
  ).rows;
  return {
    runs: totals?.runs ?? 0,
    sandboxMs: Number(totals?.sandbox_ms ?? 0),
    byPurpose: rows.map((r) => ({
      purpose: r.purpose,
      calls: r.calls,
      tokens: Number(r.tokens),
      costUsd: Number(r.cost),
    })),
  };
}

/** The scope's repository names, for pickers (the Runs page's repository filter). */
export async function repoNamesOf(scope: Scope) {
  const rows = await database()
    .select({ fullName: repos.fullName })
    .from(repos)
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(scopeWhere(scope))
    .orderBy(asc(repos.fullName));
  return rows.map((r) => r.fullName);
}
