import { ArrowUpRight, FolderGit2, Search } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { DeadlineTimeline } from "@/components/teire/deadline-timeline";
import { EmptyState } from "@/components/teire/empty-state";
import { Kpi } from "@/components/teire/kpi";
import { LiveRun } from "@/components/teire/live-run";
import { Mark, MarkStack } from "@/components/teire/mark";
import { ProofGlyphs } from "@/components/teire/proof-glyphs";
import { RunRowItem } from "@/components/teire/run-row";
import { StatusChip } from "@/components/teire/status-chip";
import { Button } from "@/components/ui/button";
import { myScope } from "@/lib/app-shell";
import { providerLogo } from "@/lib/logos";
import { languageMarks, subjectMark } from "@/lib/marks";
import { STEP_DOING } from "@/lib/proof";
import { getSession } from "@/lib/session";
import { overviewOf, type RunRow } from "@/lib/workspace";
import { InstallCard, SignInCard } from "./gate";

export const metadata = { title: "Overview" };

/**
 * Overview (plan revision 3.3, U3; The Org's sectioned home): what needs a person first, then open
 * pull requests with their proof chains, deadlines, what Teire is doing now, recent runs and what it
 * couldn't check. Each section shows a few rows and goes to its full list.
 */
export default function OverviewPage() {
  return (
    <Suspense fallback={<OverviewLoading />}>
      <Overview />
    </Suspense>
  );
}

const SECTION_ROWS = 5;

const subjectOf = (r: Pick<RunRow, "groupKey">) => {
  const [head, ...rest] = (r.groupKey ?? "").split("/");
  return head === "models" || head === "api" ? (rest[0] ?? head) : rest.slice(0, -1).join("/");
};

/** What a row that needs a person is: a regression, an issue for a person, a draft, or a stop. */
function needChip(r: RunRow) {
  if (r.evidence === "regression") return <StatusChip tone="broke">Regression</StatusChip>;
  if (r.pr?.kind === "issue") return <StatusChip tone="attention">Needs a person</StatusChip>;
  if (r.evidence && r.evidence !== "verified") return <StatusChip tone="attention">Draft</StatusChip>;
  return <StatusChip tone="broke">Stopped</StatusChip>;
}

function Section({
  title,
  go,
  children,
}: {
  title: string;
  go?: { label: string; href: string } | null;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow">{title}</h2>
        {go ? (
          <Link href={go.href} className="flex items-center gap-1 text-xs text-ink-2 hover:text-ink">
            {go.label} <ArrowUpRight className="size-3" aria-hidden />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

async function Overview() {
  await connection();
  const session = await getSession();
  if (!session) return <SignInCard next="/app" />;
  const mine = await myScope(session.user.id);
  if (!mine) return <InstallCard />;
  const data = await overviewOf(mine.scope);
  if (!data.repos.length) return <InstallCard />;
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
  const prs = data.openPrs.slice(0, SECTION_ROWS);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="heading text-3xl text-ink">Overview</h1>
        {data.counts.live ? (
          <span className="flex items-center gap-2 rounded-full bg-signal-soft px-3 py-1 text-xs text-signal">
            <span className="size-1.5 rounded-full bg-signal animate-live" />
            Teire is working on {data.counts.live}
          </span>
        ) : null}
      </header>

      <section className="grid animate-enter grid-cols-2 gap-px overflow-hidden rounded-xl bg-rule shadow-card lg:grid-cols-4">
        <Kpi label="Proven, ready to merge" value={data.counts.proven} tone="proven" />
        <Kpi label="Needs you" value={data.counts.needsYou} tone="attention" />
        <Kpi label="Open pull requests" value={data.counts.open} />
        <Kpi label="Changes reaching code" value={data.counts.reaching} />
      </section>

      <div className="grid animate-enter grid-cols-1 gap-6 [animation-delay:80ms] *:min-w-0 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-8">
          <Section
            title="Needs you"
            go={
              data.counts.needsYou
                ? { label: `All ${data.counts.needsYou}`, href: "/app/runs?show=needs-you" }
                : null
            }
          >
            {data.needsYou.length ? (
              <ul className="flex flex-col gap-2">
                {data.needsYou.slice(0, SECTION_ROWS).map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/runs/${r.id}`}
                      className="flex items-center gap-3 rounded-xl bg-sheet p-3 shadow-card transition-shadow hover:shadow-card-hover"
                    >
                      <Mark brand={subjectMark(r.groupKey)} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium text-ink">{subjectOf(r)}</span>
                        <span
                          className="truncate font-mono text-[11px] text-ink-3"
                          title={`${r.from} → ${r.to}`}
                        >
                          {r.repo.split("/")[1]}
                          {r.pr?.number ? ` · ${r.pr.kind === "issue" ? "issue" : ""} #${r.pr.number}` : ""}
                        </span>
                      </span>
                      <ProofGlyphs proof={r.proof} className="hidden sm:inline-flex" />
                      {needChip(r)}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl bg-sheet px-4 py-6 text-center text-sm text-ink-3 shadow-card">
                Nothing needs you: every run in the last week ended proven or is still working.
              </p>
            )}
          </Section>

          <Section
            title="Open pull requests"
            go={
              data.counts.open ? { label: `All ${data.counts.open}`, href: "/app/runs?show=open-prs" } : null
            }
          >
            {prs.length ? (
              <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
                {prs.map((r) => (
                  <RunRowItem key={r.id} row={r} href={`/runs/${r.id}`} />
                ))}
              </ul>
            ) : (
              <EmptyState
                className="rounded-xl bg-sheet shadow-card"
                title="No Teire pull request is open"
                body="When a change reaches your code, its fix opens here with what proves it."
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href="/app/changes">
                      <Search data-icon="inline-start" />
                      See what reaches your code
                    </Link>
                  </Button>
                }
              />
            )}
          </Section>

          <Section
            title="Deadlines"
            go={deadlines.length ? { label: "Changes for you", href: "/app/changes" } : null}
          >
            {deadlines.length ? (
              <div className="rounded-xl bg-sheet px-6 pt-4 pb-3 shadow-card">
                <DeadlineTimeline deadlines={deadlines} />
              </div>
            ) : (
              <p className="rounded-xl bg-sheet px-4 py-6 text-center text-sm text-ink-3 shadow-card">
                No dated change reaches your repositories.
              </p>
            )}
          </Section>

          <Section
            title="Recent runs"
            go={data.recent.length ? { label: "All runs", href: "/app/runs" } : null}
          >
            {data.recent.length ? (
              <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
                {data.recent.slice(0, SECTION_ROWS).map((r) => (
                  <RunRowItem key={r.id} row={r} href={`/runs/${r.id}`} />
                ))}
              </ul>
            ) : (
              <p className="rounded-xl bg-sheet px-4 py-6 text-center text-sm text-ink-3 shadow-card">
                No run finished in the last two days.
              </p>
            )}
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-8">
          <Section title="Working now" go={{ label: "All runs", href: "/app/runs?show=active" }}>
            <div className="flex flex-col gap-1 rounded-xl bg-sheet p-2 shadow-card">
              {data.live.length ? (
                data.live.map((r) => (
                  <LiveRun
                    key={r.id}
                    href={`/runs/${r.id}`}
                    brand={subjectMark(r.groupKey)}
                    repo={r.repo.split("/")[1] ?? r.repo}
                    subject={subjectOf(r)}
                    doing={`${r.status === "queued" ? (r.step ?? "Queued") : (STEP_DOING[r.step ?? "queue"] ?? "Working")}…`}
                    startedAt={r.startedAt?.toISOString() ?? null}
                  />
                ))
              ) : (
                <p className="px-2 py-6 text-center text-xs text-ink-3">Nothing running</p>
              )}
            </div>
          </Section>

          <Section
            title="What Teire couldn't check"
            go={data.gaps.length > SECTION_ROWS ? { label: "Repositories", href: "/app/repos" } : null}
          >
            {data.gaps.length ? (
              <ul className="flex flex-col gap-1 rounded-xl bg-sheet p-2 shadow-card">
                {data.gaps.slice(0, SECTION_ROWS).map((g) => (
                  <li key={g.repo}>
                    <Link
                      href={`/app/repos/${g.repo}/findings`}
                      className="flex flex-col gap-0.5 rounded-lg px-2 py-2 hover:bg-hover"
                    >
                      <span className="truncate font-mono text-xs text-ink">{g.repo.split("/")[1]}</span>
                      <span className="line-clamp-2 text-[11px] text-ink-3">{g.said.join("; ")}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl bg-sheet px-4 py-6 text-center text-xs text-ink-3 shadow-card">
                Every scan checked what it found by type.
              </p>
            )}
          </Section>
        </div>
      </div>

      <Section title="Repositories" go={{ label: `All ${data.repos.length}`, href: "/app/repos" }}>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.repos.slice(0, 6).map((r) => (
            <li key={r.id}>
              <Link
                href={`/app/repos/${r.fullName}`}
                className="flex h-full flex-col gap-4 rounded-xl bg-sheet p-4 shadow-card transition-shadow hover:shadow-card-hover"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2 truncate text-sm font-medium text-ink">
                    <FolderGit2 className="size-3.5 shrink-0 text-ink-3" aria-hidden />
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
                  <span className="flex items-center gap-2 font-mono text-xs text-ink-2">
                    {r.fixMode.mode !== "auto" ? (
                      <StatusChip tone="neutral">
                        {r.fixMode.mode === "off" ? "fixes off" : "ask first"}
                      </StatusChip>
                    ) : null}
                    <span title="open pull requests">{r.openPrs} PRs</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function OverviewLoading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8" role="status" aria-label="Loading">
      <div className="h-9 w-48 animate-pulse rounded-lg bg-sunken" />
      <div className="h-24 animate-pulse rounded-xl bg-sheet shadow-card" />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="h-96 animate-pulse rounded-xl bg-sheet shadow-card" />
        <div className="h-72 animate-pulse rounded-xl bg-sheet shadow-card" />
      </div>
    </div>
  );
}
