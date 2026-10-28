import { ArrowUpRight, GitPullRequestDraft, RotateCcw, Search } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { DeadlineTimeline } from "@/components/teire/deadline-timeline";
import { KitShell } from "@/components/teire/kit-shell";
import { Kpi } from "@/components/teire/kpi";
import { LiveRun } from "@/components/teire/live-run";
import { Mark, MarkStack } from "@/components/teire/mark";
import { ProofGlyphs } from "@/components/teire/proof-chain";
import { StatusChip } from "@/components/teire/status-chip";
import { Button } from "@/components/ui/button";
import { kitOverview, kitShell, type RunRow, requireKit } from "@/lib/kit";
import { providerLogo } from "@/lib/logos";
import { languageMarks, subjectMark } from "@/lib/marks";

export const metadata = { title: "Overview" };

export default function KitOverviewPage() {
  return (
    <Suspense fallback={<div className="m-8 h-96 animate-pulse rounded-xl bg-sheet shadow-card" />}>
      <Overview />
    </Suspense>
  );
}

const subjectOf = (r: Pick<RunRow, "groupKey">) => {
  const [head, ...rest] = (r.groupKey ?? "").split("/");
  return head === "models" || head === "api" ? (rest[0] ?? head) : rest.slice(0, -1).join("/");
};

/** What Teire is doing at a step, in the present tense (Factory's grammar). */
const DOING: Record<string, string> = {
  queue: "Waiting for its turn",
  assess: "Reading the change",
  resolver: "Updating the dependency files",
  transaction: "Applying the change",
  fix: "Applying the change",
  codemod: "Making the deterministic edits",
  agent: "Nemotron is fixing the code",
  install: "Installing in the sandbox",
  baseline: "Checking the unchanged repo",
  check: "Running your checks",
  verify: "Weighing the evidence",
  review: "Reviewing the diff",
  pr: "Opening the pull request",
};

/** What a row that needs a person should offer: one action, named for what it does. */
function needOf(r: RunRow): { chip: React.ReactNode; action: { label: string; icon: typeof RotateCcw } } {
  if (r.evidence === "regression")
    return {
      chip: <StatusChip tone="broke">Regression</StatusChip>,
      action: { label: "See why", icon: Search },
    };
  if (r.evidence && r.evidence !== "verified")
    return {
      chip: <StatusChip tone="attention">Draft</StatusChip>,
      action: { label: "Re-verify", icon: RotateCcw },
    };
  return { chip: <StatusChip tone="broke">Stopped</StatusChip>, action: { label: "See why", icon: Search } };
}

async function Overview() {
  await connection();
  await requireKit();
  const [data, shell] = await Promise.all([kitOverview(), kitShell()]);
  const deadlines = data.deadlines
    .filter((d) => d.deadline)
    .map((d) => {
      const p = providerLogo(d.provider);
      return {
        id: d.changeId,
        title: d.title,
        date: new Date(d.deadline as unknown as string),
        brand: { label: p.name, light: p.light, dark: p.dark },
        repos: d.repos,
      };
    });

  return (
    <KitShell
      account={shell.account}
      repos={shell.repos}
      crumbs={[{ label: shell.account.login }, { label: "Overview" }]}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="heading text-3xl text-ink">Overview</h1>
          {data.live.length ? (
            <span className="flex items-center gap-2 rounded-full bg-signal-soft px-3 py-1 text-xs text-signal">
              <span className="size-1.5 rounded-full bg-signal animate-live" />
              Teire is working on {data.live.length}
            </span>
          ) : null}
        </header>

        <section className="grid animate-enter grid-cols-2 gap-px overflow-hidden rounded-xl bg-rule shadow-card lg:grid-cols-4">
          <Kpi label="Proven, ready to merge" value={data.counts.proven} tone="proven" />
          <Kpi label="Needs you" value={data.counts.drafts} tone="attention" />
          <Kpi label="Open pull requests" value={data.counts.open} />
          <Kpi label="Changes reaching code" value={data.counts.reaching} />
        </section>

        <div className="grid animate-enter gap-6 [animation-delay:80ms] lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="eyebrow">Needs you</h2>
              <Link href="/kit/runs" className="flex items-center gap-1 text-xs text-ink-2 hover:text-ink">
                All {data.counts.drafts} <ArrowUpRight className="size-3" />
              </Link>
            </div>
            <ul className="flex flex-col gap-2">
              {data.needsYou.slice(0, 8).map((r) => {
                const need = needOf(r);
                return (
                  <li
                    key={r.id}
                    className="group flex items-center gap-3 rounded-xl bg-sheet p-3 shadow-card transition-shadow hover:shadow-card-hover"
                  >
                    <Mark brand={subjectMark(r.groupKey)} />
                    <Link href={`/kit/run/${r.id}`} className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium text-ink">{subjectOf(r)}</span>
                      <span
                        className="truncate font-mono text-[11px] text-ink-3"
                        title={`${r.from} → ${r.to}`}
                      >
                        {r.repo.split("/")[1]}
                        {r.pr?.number ? ` · #${r.pr.number}` : ""}
                      </span>
                    </Link>
                    <ProofGlyphs proof={r.proof} className="hidden sm:inline-flex" />
                    {need.chip}
                    <Button asChild size="sm" variant="outline" className="hidden md:inline-flex">
                      <Link href={`/kit/run/${r.id}`}>
                        <need.action.icon data-icon="inline-start" />
                        {need.action.label}
                      </Link>
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="eyebrow">Working now</h2>
            <div className="flex flex-col gap-1 rounded-xl bg-sheet p-2 shadow-card">
              {data.live.length ? (
                data.live.map((r) => (
                  <LiveRun
                    key={r.id}
                    href={`/kit/run/${r.id}`}
                    brand={subjectMark(r.groupKey)}
                    repo={r.repo.split("/")[1] ?? r.repo}
                    subject={subjectOf(r)}
                    doing={`${DOING[r.step ?? "queue"] ?? "Working"}…`}
                    startedAt={r.startedAt?.toISOString() ?? null}
                  />
                ))
              ) : (
                <p className="px-2 py-6 text-center text-xs text-ink-3">Nothing running</p>
              )}
              <Link
                href="/kit/runs"
                className="mt-1 flex items-center justify-center gap-1 rounded-lg py-2 text-xs text-ink-2 hover:bg-hover"
              >
                All runs <ArrowUpRight className="size-3" />
              </Link>
            </div>
            <h2 className="eyebrow mt-3">Ready to merge</h2>
            <ul className="flex flex-col gap-1 rounded-xl bg-sheet p-2 shadow-card">
              {data.openPrs
                .filter((r) => r.evidence === "verified")
                .slice(0, 5)
                .map((r) => (
                  <li key={r.id}>
                    <a
                      href={r.pr?.url ?? `/kit/run/${r.id}`}
                      className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover"
                    >
                      <Mark brand={subjectMark(r.groupKey)} size="sm" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm text-ink">{subjectOf(r)}</span>
                        <span className="truncate font-mono text-[11px] text-ink-3">
                          {r.repo.split("/")[1]} · #{r.pr?.number}
                        </span>
                      </span>
                      <StatusChip tone="proven">Proven</StatusChip>
                    </a>
                  </li>
                ))}
            </ul>
          </section>
        </div>

        {deadlines.length ? (
          <section className="flex animate-enter flex-col gap-3 [animation-delay:160ms]">
            <h2 className="eyebrow">Deadlines</h2>
            <div className="rounded-xl bg-sheet px-6 pt-4 pb-3 shadow-card">
              <DeadlineTimeline deadlines={deadlines} />
            </div>
          </section>
        ) : null}

        <section className="flex flex-col gap-3">
          <h2 className="eyebrow">Repositories</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.repos
              .filter((r) => r.affected || r.openPrs)
              .map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/kit/repo/${r.fullName}`}
                    className="flex h-full flex-col gap-4 rounded-xl bg-sheet p-4 shadow-card transition-shadow hover:shadow-card-hover"
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2 truncate text-sm font-medium text-ink">
                        {r.fullName.split("/")[1]}
                        {r.live ? (
                          <span className="size-1.5 shrink-0 rounded-full bg-signal animate-live" />
                        ) : null}
                      </span>
                      <MarkStack brands={languageMarks(r.languages)} />
                    </span>
                    <span className="flex items-end justify-between gap-3">
                      <span className="flex items-baseline gap-1.5">
                        <span className="font-mono text-2xl leading-none text-ink tabular-nums">
                          {r.affected}
                        </span>
                        <span className="text-[11px] text-ink-3">reaching code</span>
                      </span>
                      <span className="flex items-center gap-3 font-mono text-xs text-ink-2">
                        {r.fixesPaused ? <StatusChip tone="neutral">fixes off</StatusChip> : null}
                        <span className="flex items-center gap-1" title="open pull requests">
                          <GitPullRequestDraft className="size-3.5 text-ink-3" />
                          {r.openPrs}
                        </span>
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      </div>
    </KitShell>
  );
}
