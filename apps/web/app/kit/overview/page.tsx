import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState } from "@/components/teire/empty-state";
import { KitShell } from "@/components/teire/kit-shell";
import { LiveDot } from "@/components/teire/live-dot";
import { RunRowItem } from "@/components/teire/run-row";
import { StatusChip } from "@/components/teire/status-chip";
import { Surface } from "@/components/teire/surface";
import { Button } from "@/components/ui/button";
import { kitOverview, kitShell, type RunRow, requireKit } from "@/lib/kit";

export const metadata = { title: "Overview" };

export default function KitOverviewPage() {
  return (
    <Suspense fallback={<div className="m-8 h-96 animate-pulse rounded-lg bg-sheet shadow-card" />}>
      <Overview />
    </Suspense>
  );
}

const DAY = 86_400_000;

/** A deadline as a person reads it: "in 34 days" (amber within 90), "passed 5 days ago" (red). */
function countdown(deadline: Date) {
  const days = Math.round((deadline.getTime() - Date.now()) / DAY);
  if (days < 0) return { text: `passed ${-days} day${days === -1 ? "" : "s"} ago`, tone: "broke" as const };
  if (days === 0) return { text: "today", tone: "broke" as const };
  return {
    text: `in ${days} day${days === 1 ? "" : "s"}`,
    tone: days <= 90 ? ("attention" as const) : ("neutral" as const),
  };
}

function Rows({ rows, empty }: { rows: RunRow[]; empty: React.ReactNode }) {
  if (!rows.length) return <>{empty}</>;
  return (
    <ul className="divide-y divide-rule">
      {rows.slice(0, 5).map((r) => (
        <RunRowItem key={r.id} row={r} href={`/kit/run/${r.id}`} />
      ))}
    </ul>
  );
}

async function Overview() {
  await connection();
  await requireKit();
  const [data, shell] = await Promise.all([kitOverview(), kitShell()]);
  const openPrs = data.repos.reduce((n, r) => n + r.openPrs, 0);
  const affected = data.repos.reduce((n, r) => n + r.affected, 0);
  const preview = data.recent.slice(0, 3);

  return (
    <KitShell
      account={shell.account}
      repos={shell.repos}
      crumbs={[{ label: shell.account.login }, { label: "Overview" }]}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="eyebrow">Overview</span>
            <h1 className="heading text-2xl text-ink">What needs you</h1>
          </div>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-rule shadow-card sm:grid-cols-4">
            {[
              ["Repositories watched", String(data.repos.length)],
              ["Changes reaching your code", String(affected)],
              ["Pull requests open", String(openPrs)],
              ["Teire working now", String(data.live.length)],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 bg-sheet px-4 py-3">
                <dt className="eyebrow">{label}</dt>
                <dd className="flex items-center gap-2 font-mono text-xl text-ink tabular-nums">
                  {value}
                  {label === "Teire working now" && data.live.length ? <LiveDot /> : null}
                </dd>
              </div>
            ))}
          </dl>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          <Surface
            eyebrow="Needs you"
            title="Drafts, stops and failures from the last week"
            action={{ label: "Go to runs", href: "/kit/runs" }}
            flush
            className="lg:col-span-2"
          >
            <Rows
              rows={data.needsYou}
              empty={
                <EmptyState
                  title="Nothing needs you"
                  body="Every run this week was proven or is still going."
                />
              }
            />
          </Surface>

          <Surface
            eyebrow="Open pull requests"
            title="Each with its proof"
            action={{ label: "Go to runs", href: "/kit/runs" }}
            flush
          >
            <Rows
              rows={data.openPrs}
              empty={
                <EmptyState
                  title="No open pull requests"
                  body="When a change reaches your code, its fix opens here with the proof."
                  preview={
                    <ul className="divide-y divide-rule">
                      {preview.map((r) => (
                        <RunRowItem key={r.id} row={r} href="#" />
                      ))}
                    </ul>
                  }
                />
              }
            />
          </Surface>

          <Surface eyebrow="Upcoming deadlines" title="Retirements and shutdowns your code still calls" flush>
            {data.deadlines.length ? (
              <ul className="divide-y divide-rule">
                {data.deadlines.slice(0, 5).map((d) => {
                  const when = d.deadline ? countdown(new Date(d.deadline)) : null;
                  return (
                    <li key={d.changeId} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm text-ink">{d.title}</span>
                        <span className="font-mono text-[11px] text-ink-3">
                          {d.provider ?? "package"} · {d.repos} repo{d.repos === 1 ? "" : "s"}
                        </span>
                      </span>
                      {when ? <StatusChip tone={when.tone}>{when.text}</StatusChip> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState title="No dated change reaches your code" />
            )}
          </Surface>

          <Surface eyebrow="Teire working now" flush>
            <Rows
              rows={data.live}
              empty={
                <EmptyState
                  title="Nothing running"
                  body="Runs start when a scan finds a change that reaches your code."
                />
              }
            />
          </Surface>

          <Surface
            eyebrow="Recent runs"
            title="The last two days"
            action={{ label: "Go to runs", href: "/kit/runs" }}
            flush
          >
            <Rows rows={data.recent} empty={<EmptyState title="No runs in two days" />} />
          </Surface>

          <Surface
            eyebrow="What Teire couldn't check"
            title="Coverage, per repository"
            flush
            className="lg:col-span-2"
          >
            {data.gaps.length ? (
              <ul className="divide-y divide-rule">
                {data.gaps.slice(0, 6).map((g) => (
                  <li
                    key={g.repo}
                    className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <span className="w-48 shrink-0 truncate font-mono text-xs text-ink">
                      {g.repo.split("/")[1]}
                    </span>
                    <span className="text-xs text-ink-2">{g.said.join(" · ")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="Every repository was checked in full"
                action={
                  <Button size="sm" variant="outline">
                    Install on another repository
                  </Button>
                }
              />
            )}
          </Surface>
        </div>
      </div>
    </KitShell>
  );
}
