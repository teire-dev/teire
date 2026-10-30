import { and, eq, inArray, repos, runs, sql } from "@teire/db";
import { Pause, Play } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ActionButton } from "@/components/app/action-button";
import { FilterSelect } from "@/components/app/filter-select";
import { TileSquare } from "@/components/flow/tile";
import { Trail } from "@/components/flow/trail";
import { myScope } from "@/lib/app-shell";
import { runFlow } from "@/lib/flow/model";
import { runFlowsOf } from "@/lib/run-flows";
import { getSession } from "@/lib/session";
import { ago } from "@/lib/time";
import { countRuns, NEEDS_YOU, queueOf, repoNamesOf, runsOf, waitingReason } from "@/lib/workspace";
import { InstallCard, SignInCard } from "../gate";

export const metadata = { title: "Runs" };

const PAGE = 30;

/**
 * Runs (plan revision 3.4, V4): every run as its breadcrumb trail (repository, change, reach, update,
 * fix, sandbox, checks, review, outcome), each step opening its evidence in place; three dropdown
 * filters in the URL (the Overview's figures link here), paged.
 */
const SHOW = {
  all: { label: "All runs", where: sql`true` },
  "needs-you": { label: "Needs you", where: NEEDS_YOU },
  "open-prs": {
    label: "Open PRs",
    where: sql`exists (select 1 from artifacts a where a.run_id = ${runs.id} and a.kind = 'pr' and a.state = 'open')`,
  },
  active: { label: "Working now", where: inArray(runs.status, ["queued", "running", "stopping"]) },
  failed: { label: "Failed", where: eq(runs.status, "failed") },
  cancelled: { label: "Cancelled", where: eq(runs.status, "cancelled") },
} as const;

const EVIDENCE = {
  verified: "Proven",
  typecheck_only: "Typecheck only",
  pre_existing_failure: "Already failing",
  needs_live_access: "Needs live access",
  environment_mismatch: "Not checked everywhere",
  needs_local_service: "Needs a local service",
  regression: "Regression",
  timeout: "Timed out",
  unverified: "Unverified",
} as const;

export default function RunsPage({ searchParams }: PageProps<"/app/runs">) {
  return (
    <Suspense
      fallback={
        <div className="mx-auto h-96 w-full max-w-6xl animate-pulse rounded-xl bg-sheet shadow-card" />
      }
    >
      <Runs searchParams={searchParams} />
    </Suspense>
  );
}

async function Runs({ searchParams }: { searchParams: PageProps<"/app/runs">["searchParams"] }) {
  await connection();
  const session = await getSession();
  if (!session) return <SignInCard next="/app/runs" />;
  const [mine, params] = await Promise.all([myScope(session.user.id), searchParams]);
  if (!mine) return <InstallCard />;
  const one = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : null);
  const show = (one("show") ?? "all") as keyof typeof SHOW;
  const evidence = one("evidence");
  const repo = one("repo");
  const page = Math.max(1, Number(one("page") ?? 1) || 1);
  const where = and(
    (SHOW[show] ?? SHOW.all).where,
    evidence && evidence in EVIDENCE ? eq(runs.evidenceKind, evidence as keyof typeof EVIDENCE) : undefined,
    repo ? eq(repos.fullName, repo) : undefined,
  );
  // A page of runs at a time, and how many there are in all (U3 review: "every run" is every run).
  const [rows, total, names, queue] = await Promise.all([
    runsOf(mine.scope, where, PAGE, (page - 1) * PAGE),
    countRuns(mine.scope, where),
    repoNamesOf(mine.scope),
    queueOf(mine.scope),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const href = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams();
    // A filter change starts again at the first page.
    for (const [k, v] of Object.entries({ show, evidence, repo, page: null, ...patch }))
      if (v && !(k === "show" && v === "all")) next.set(k, v);
    const q = next.toString();
    return `/app/runs${q ? `?${q}` : ""}`;
  };
  const flows = await runFlowsOf(
    mine.scope,
    rows.map((r) => r.id),
  );
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <h1 className="heading flex items-baseline gap-2 text-3xl text-ink">
        Runs
        <span className="font-mono text-base text-ink-3">{total}</span>
      </h1>
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Filter runs">
        <FilterSelect
          label="Show"
          value={show}
          options={Object.entries(SHOW).map(([k, v]) => ({
            value: k,
            label: v.label,
            href: href({ show: k }),
          }))}
        />
        <FilterSelect
          label="Evidence"
          value={evidence ?? "all"}
          options={[
            { value: "all", label: "Any evidence", href: href({ evidence: null }) },
            ...Object.entries(EVIDENCE).map(([k, label]) => ({
              value: k,
              label,
              href: href({ evidence: k }),
            })),
          ]}
        />
        <FilterSelect
          label="Repository"
          value={repo ?? "all"}
          options={[
            { value: "all", label: "Every repository", href: href({ repo: null }) },
            ...names.map((n) => ({ value: n, label: n.split("/")[1] ?? n, href: href({ repo: n }) })),
          ]}
        />
        {show !== "all" || evidence || repo ? (
          <Link href="/app/runs" className="px-2 text-xs text-ink-3 hover:text-ink">
            Clear
          </Link>
        ) : null}
      </div>
      {queue.length ? (
        // Work in progress per repository, paced by its limits, with the one control to hold it.
        <ul className="flex flex-col gap-2" aria-label="Work in progress">
          {queue.map((q) => {
            const waiting = [...q.waiting.values()].reduce((a, b) => a + b, 0);
            return (
              <li
                key={q.repo}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-sheet px-4 py-3 shadow-card"
              >
                <TileSquare
                  tile={{ entity: "check", state: q.paused ? "pending" : "live", label: "" }}
                  size="sm"
                />
                <Link
                  href={href({ repo: q.repo, show: "active" })}
                  className="text-sm text-ink hover:underline"
                >
                  {q.repo}
                </Link>
                <span className="font-mono text-xs text-ink-2">
                  {q.running} running · {waiting} waiting
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {[...q.waiting].map(([why, n]) => (
                    <span
                      key={why}
                      className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[11px] text-ink-2"
                    >
                      {n} {why}
                    </span>
                  ))}
                </span>
                <span className="ml-auto">
                  <ActionButton kind={q.paused ? "resume" : "pause"} repo={q.repo} variant="ghost">
                    {q.paused ? (
                      <Play data-icon="inline-start" aria-hidden />
                    ) : (
                      <Pause data-icon="inline-start" aria-hidden />
                    )}
                    {q.paused ? "Resume" : "Pause"}
                  </ActionButton>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {rows.length ? (
        <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
          {rows.map((r) => {
            const input = flows.get(r.id);
            return (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                {input ? (
                  <Trail
                    graph={runFlow(input)}
                    runHref={`/runs/${r.id}`}
                    label={`The run on ${r.repo}`}
                    className="flex-1"
                  />
                ) : (
                  <span className="flex-1 truncate font-mono text-xs text-ink-3">{r.groupKey}</span>
                )}
                <Link
                  href={`/runs/${r.id}`}
                  className="shrink-0 font-mono text-[11px] text-ink-3 hover:text-ink"
                  title={r.createdAt.toISOString()}
                >
                  {r.status === "queued"
                    ? waitingReason(r.step)
                    : ago(r.finishedAt ?? r.startedAt ?? r.createdAt)}{" "}
                  ›
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
          <TileSquare tile={{ entity: "check", state: "pending", label: "" }} size="sm" />
          <span className="text-sm text-ink-2">No run matches</span>
          <Link href="/app/runs" className="ml-auto text-xs text-ink-2 hover:text-ink">
            Clear
          </Link>
        </div>
      )}
      {rows.length && pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center justify-between font-mono text-xs text-ink-3">
          {page > 1 ? (
            <Link href={href({ page: String(page - 1) })} className="text-ink hover:underline">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span>
            {page} / {pages}
          </span>
          {page < pages ? (
            <Link href={href({ page: String(page + 1) })} className="text-ink hover:underline">
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
