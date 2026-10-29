import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { EstateMap } from "@/components/app/estate-map";
import { StatTile } from "@/components/app/stat-tile";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { MiniFlow } from "@/components/flow/mini-flow";
import { TileSquare } from "@/components/flow/tile";
import { LiveRun } from "@/components/teire/live-run";
import { Mark } from "@/components/teire/mark";
import { StatusChip } from "@/components/teire/status-chip";
import { NextStep } from "@/components/welcome/next-step";
import { myScope } from "@/lib/app-shell";
import { changesGraph, sourcesGraph } from "@/lib/estate";
import { subjectMark } from "@/lib/marks";
import { STEP_DOING } from "@/lib/proof";
import { getSession } from "@/lib/session";
import { type DayCount, dailyCounts, estateOf, overviewOf, type RunRow } from "@/lib/workspace";
import { InstallCard, SignInCard } from "./gate";

export const metadata = { title: "Overview" };

/**
 * Overview (plan revision 3.4, V4): four figures that each go to their list, the estate map (what
 * reaches your code → your repositories → what Teire has open, drag a change onto a repository to fix
 * it there), then what needs a person and what Teire is doing now. Everything else is one click away.
 */
export default function OverviewPage() {
  return (
    <Suspense fallback={<OverviewLoading />}>
      <Overview />
    </Suspense>
  );
}

const ROWS = 5;
const DAYS = 14;

const subjectOf = (r: Pick<RunRow, "groupKey">) => {
  const [head, ...rest] = (r.groupKey ?? "").split("/");
  return head === "models" || head === "api" ? (rest[0] ?? head) : rest.slice(0, -1).join("/");
};

/** What a row that needs a person is: a regression, an issue for a person, a draft, or a stop. */
function needChip(r: RunRow) {
  if (r.evidence === "regression") return <StatusChip tone="broke">Regression</StatusChip>;
  if (r.pr?.kind === "issue") return <StatusChip tone="attention">Issue</StatusChip>;
  if (r.evidence && r.evidence !== "verified") return <StatusChip tone="attention">Draft</StatusChip>;
  return <StatusChip tone="broke">Stopped</StatusChip>;
}

/**
 * What a series adds up to, in words: the last seven days for runs (each run ends once), today alone
 * for the figures whose own count is already a window (needs you) or that a day can re-find (reach).
 */
function week(days: DayCount[], key: keyof Omit<DayCount, "day">) {
  const n = days.slice(-7).reduce((sum, d) => sum + d[key], 0);
  return n ? `+${n} new in 7 days` : null;
}
function today(days: DayCount[], key: keyof Omit<DayCount, "day">) {
  const n = days.at(-1)?.[key] ?? 0;
  return n ? `+${n} new today` : null;
}

function Heading({ title, go }: { title: string; go?: { label: string; href: string } | null }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="eyebrow">{title}</h2>
      {go ? (
        <Link href={go.href} className="flex items-center gap-1 text-xs text-ink-2 hover:text-ink">
          {go.label} <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}

/** A quiet list: one tile in its state and a few words, in place of an empty box. */
function Quiet({ state, label }: { state: "proven" | "pending"; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
      <TileSquare tile={{ entity: state === "proven" ? "check" : "fix", state, label }} size="sm" />
      <span className="text-sm text-ink-2">{label}</span>
    </div>
  );
}

async function Overview() {
  await connection();
  const session = await getSession();
  if (!session) return <SignInCard next="/app" />;
  const mine = await myScope(session.user.id);
  if (!mine) return <InstallCard />;
  const [data, days, estate] = await Promise.all([
    overviewOf(mine.scope),
    dailyCounts(mine.scope, DAYS),
    estateOf(mine.scope),
  ]);
  if (!data.repos.length) return <InstallCard />;
  const graphs = { changes: changesGraph(estate), sources: sourcesGraph(estate) };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <NextStep />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="heading text-3xl text-ink">Overview</h1>
        {data.counts.live ? (
          <Link
            href="/app/runs?show=active"
            className="flex items-center gap-2 rounded-full bg-signal-soft px-3 py-1 font-mono text-xs text-signal hover:bg-signal/15"
          >
            <span className="size-1.5 rounded-full bg-signal animate-live" />
            {data.counts.live} going or queued
          </Link>
        ) : null}
      </header>

      <section className="grid animate-enter grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Figures">
        <StatTile
          label="Ready to merge"
          value={data.counts.proven}
          tone="proven"
          href="/app/runs?show=open-prs&evidence=verified"
          series={days.map((d) => d.ready)}
          week={week(days, "ready")}
        />
        <StatTile
          label="Needs you"
          value={data.counts.needsYou}
          tone="attention"
          href="/app/runs?show=needs-you"
          series={days.map((d) => d.needs)}
          week={today(days, "needs")}
        />
        <StatTile
          label="Open pull requests"
          value={data.counts.open}
          href="/app/runs?show=open-prs"
          series={days.map((d) => d.opened)}
          week={week(days, "opened")}
        />
        <StatTile
          label="Reaching your code"
          value={data.counts.reaching}
          tone="signal"
          href="/app/changes"
          series={days.map((d) => d.reaching)}
          week={today(days, "reaching")}
        />
      </section>

      <div className="animate-enter [animation-delay:60ms]">
        <EstateMap graphs={graphs} />
      </div>

      <div className="grid animate-enter grid-cols-1 gap-6 [animation-delay:120ms] *:min-w-0 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="flex flex-col gap-3">
          <Heading
            title="Needs you"
            go={
              data.counts.needsYou > ROWS
                ? { label: `All ${data.counts.needsYou}`, href: "/app/runs?show=needs-you" }
                : null
            }
          />
          {data.needsYou.length ? (
            <ul className="flex flex-col divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
              {data.needsYou.slice(0, ROWS).map((r) => (
                <li key={r.id}>
                  <Link href={`/runs/${r.id}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-hover">
                    <Mark brand={subjectMark(r.groupKey)} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium text-ink">{subjectOf(r)}</span>
                      <span
                        className="truncate font-mono text-[11px] text-ink-3"
                        title={`${r.from} → ${r.to}`}
                      >
                        {r.repo.split("/")[1]}
                        {r.pr?.number ? ` · #${r.pr.number}` : ""}
                      </span>
                    </span>
                    <MiniFlow
                      proof={r.proof}
                      subject={subjectMark(r.groupKey)}
                      className="hidden sm:inline-flex"
                    />
                    {needChip(r)}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Quiet state="proven" label="Nothing needs you" />
          )}
        </section>

        <section className="flex flex-col gap-3">
          <Heading
            title="Working now"
            go={data.live.length ? { label: "All runs", href: "/app/runs?show=active" } : null}
          />
          {data.live.length ? (
            <div className="flex flex-col gap-1 rounded-xl bg-sheet p-2 shadow-card">
              {data.live.map((r) => (
                <LiveRun
                  key={r.id}
                  href={`/runs/${r.id}`}
                  brand={subjectMark(r.groupKey)}
                  repo={r.repo.split("/")[1] ?? r.repo}
                  subject={subjectOf(r)}
                  doing={`${r.status === "queued" ? "Waiting its turn" : (STEP_DOING[r.step ?? "queue"] ?? "Working")}…`}
                  startedAt={r.startedAt?.toISOString() ?? null}
                />
              ))}
            </div>
          ) : (
            <Quiet state="pending" label="Nothing running" />
          )}
        </section>
      </div>
    </div>
  );
}

function OverviewLoading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6" role="status" aria-label="Loading">
      <div className="h-9 w-40 animate-pulse rounded-lg bg-sunken" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[104px] animate-pulse rounded-xl bg-sheet shadow-card" />
        ))}
      </div>
      <div className="flex h-[420px] items-center justify-center rounded-xl bg-sheet shadow-card">
        <GhostFlow tiles={3} />
      </div>
    </div>
  );
}
