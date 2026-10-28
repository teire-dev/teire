import Link from "next/link";
import { Suspense } from "react";
import { RowChevron } from "@/components/row-chevron";
import { EvidenceBadge } from "@/components/run/evidence-badge";
import { overview } from "@/lib/dashboard";
import { ago } from "@/lib/languages";
import { getSession } from "@/lib/session";
import { InstallCard, SignInCard } from "./gate";

export const metadata = { title: "Dashboard" };

/** Dashboard home (C3, C6): what needs attention across every repository you can see. */
export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <Overview />
      </Suspense>
    </main>
  );
}

async function Overview() {
  const session = await getSession();
  if (!session) return <SignInCard next="/app" />;
  const data = await overview(session.user.id);
  if (!data.repos.length) return <InstallCard />;
  const affected = data.repos.reduce((n, r) => n + r.affected, 0);
  const next = data.deadlines.find((d) => d.deadline && d.deadline.getTime() >= Date.now());
  // With no deadline ahead, a passed one still matters: the code already calls something that stopped.
  const passed = data.deadlines.filter((d) => d.deadline && d.deadline.getTime() < Date.now()).length;
  return (
    <>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border shadow-card md:grid-cols-4">
        <Stat label="Repositories watched" value={String(data.repos.length)} href="/app/repos" />
        <Stat
          label="Changes reaching code"
          value={String(affected)}
          tone={affected ? "text-affected" : "text-clear"}
        />
        <Stat label="Open Teire PRs" value={String(data.repos.reduce((n, r) => n + r.openPrs, 0))} />
        <Stat
          label={next || !passed ? "Next deadline" : "Deadlines passed"}
          value={next?.deadline ? next.deadline.toISOString().slice(0, 10) : passed ? String(passed) : "none"}
          tone={next ? "text-human" : passed ? "text-affected" : undefined}
          mono
        />
      </dl>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Deadlines across your repositories</h2>
        {data.deadlines.length ? (
          <ul className="divide-y overflow-hidden rounded-lg bg-card text-sm shadow-card">
            {data.deadlines.map((d) => (
              <li key={`${d.repo}-${d.changeId}`}>
                <Link
                  href={`/app/repos/${d.repo}`}
                  className="row-link grid gap-1 px-4 py-3 pr-10 hover:bg-accent sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-4"
                >
                  <span className="truncate">{d.title}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{d.repo}</span>
                  <span className="font-mono text-xs text-human">
                    {d.deadline && d.deadline.getTime() < Date.now() ? "passed · " : ""}
                    {d.deadline?.toISOString().slice(0, 10)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No dated change reaches your repositories.</p>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Recent runs</h2>
          {data.runs.length ? (
            <ul className="divide-y overflow-hidden rounded-lg bg-card text-sm shadow-card">
              {data.runs.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/runs/${r.id}`}
                    className="row-link flex items-center justify-between gap-3 px-4 py-3 pr-10 hover:bg-accent"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{r.groupKey}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {r.repo} · {ago(r.createdAt)}
                        {r.kind === "dry_run" ? " · dry run" : ""}
                      </span>
                    </span>
                    {r.evidenceKind ? (
                      <EvidenceBadge kind={r.evidenceKind} />
                    ) : (
                      <span className="text-xs text-running">{r.status}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No runs yet. Teire starts one for each change that reaches your code.
            </p>
          )}
        </section>
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Open pull requests</h2>
          {data.prs.length ? (
            <ul className="divide-y overflow-hidden rounded-lg bg-card text-sm shadow-card">
              {data.prs.map((p) => (
                <li
                  key={`${p.repo}-${p.number}`}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <span className="min-w-0">
                    <a href={p.url ?? "#"} className="block truncate text-link hover:underline">
                      {p.repo}#{p.number}
                    </a>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {p.changeKey}
                    </span>
                  </span>
                  {p.runId ? (
                    <Link
                      href={`/runs/${p.runId}`}
                      className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                    >
                      evidence
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No Teire pull request is open.</p>
          )}
        </section>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  tone,
  mono,
  href,
}: {
  label: string;
  value: string;
  tone?: string;
  mono?: boolean;
  href?: string;
}) {
  const body = (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`text-2xl font-semibold tabular-nums ${mono ? "font-mono text-lg" : ""} ${tone ?? ""}`}>
        {value}
      </dd>
    </>
  );
  return href ? (
    <Link href={href} className="relative flex flex-col gap-1 bg-card p-5 hover:bg-accent">
      {body}
      <span className="absolute top-5 right-4 flex">
        <RowChevron />
      </span>
    </Link>
  ) : (
    <div className="flex flex-col gap-1 bg-card p-5">{body}</div>
  );
}
