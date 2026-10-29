import { and, eq, inArray, repos, runs, sql } from "@teire/db";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { RunRowItem } from "@/components/teire/run-row";
import { myScope } from "@/lib/app-shell";
import { getSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { countRuns, NEEDS_YOU, repoNamesOf, runsOf } from "@/lib/workspace";
import { InstallCard, SignInCard } from "../gate";

export const metadata = { title: "Runs" };

const PAGE = 50;

/** The lists the Overview's sections go to, and the evidence a run ended with (plan revision 3.3, U3). */
const SHOW = {
  all: { label: "All", where: sql`true` },
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
        <div className="mx-auto h-96 w-full max-w-5xl animate-pulse rounded-xl bg-sheet shadow-card" />
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
  const [rows, total, names] = await Promise.all([
    runsOf(mine.scope, where, PAGE, (page - 1) * PAGE),
    countRuns(mine.scope, where),
    repoNamesOf(mine.scope),
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
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="eyebrow">Runs</span>
        <h1 className="heading text-2xl text-ink">
          {SHOW[show]?.label === "All" ? "Every run, newest first" : SHOW[show]?.label}
          <span className="ml-2 font-mono text-sm text-ink-3">{total}</span>
          {repo ? <span className="text-ink-3"> · {repo.split("/")[1]}</span> : null}
        </h1>
      </div>
      <nav aria-label="Filter runs" className="flex flex-col gap-2">
        <Chips
          items={Object.entries(SHOW).map(([k, v]) => ({
            label: v.label,
            href: href({ show: k }),
            on: show === k,
          }))}
        />
        <Chips
          items={[
            { label: "Any evidence", href: href({ evidence: null }), on: !evidence },
            ...Object.entries(EVIDENCE).map(([k, label]) => ({
              label,
              href: href({ evidence: k }),
              on: evidence === k,
            })),
          ]}
        />
        {repo ? (
          <Chips items={[{ label: `${repo} ✕`, href: href({ repo: null }), on: true }]} />
        ) : (
          <details className="group w-fit">
            <summary className="cursor-pointer list-none rounded-full bg-sheet px-3 py-1 text-xs text-ink-2 ring-1 ring-rule ring-inset hover:text-ink">
              Repository ▾
            </summary>
            <div className="mt-2 flex max-w-3xl flex-wrap gap-1.5">
              {names.map((n) => (
                <Link
                  key={n}
                  href={href({ repo: n })}
                  className="rounded-full bg-sheet px-2.5 py-0.5 font-mono text-[11px] text-ink-2 ring-1 ring-rule ring-inset hover:text-ink"
                >
                  {n.split("/")[1]}
                </Link>
              ))}
            </div>
          </details>
        )}
      </nav>
      {rows.length ? (
        <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
          {rows.map((r) => (
            <RunRowItem key={r.id} row={r} href={`/runs/${r.id}`} />
          ))}
        </ul>
      ) : null}
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
            page {page} of {pages}
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
      {rows.length ? null : (
        <p className="rounded-xl bg-sheet px-4 py-10 text-center text-sm text-ink-3 shadow-card">
          No run matches these filters.{" "}
          <Link href="/app/runs" className="text-link hover:underline">
            Show every run
          </Link>
        </p>
      )}
    </div>
  );
}

function Chips({ items }: { items: { label: string; href: string; on: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <Link
          key={i.label}
          href={i.href}
          aria-current={i.on ? "page" : undefined}
          className={cn(
            "rounded-full px-3 py-1 text-xs ring-1 ring-inset",
            i.on ? "bg-ink text-sheet ring-ink" : "bg-sheet text-ink-2 ring-rule hover:text-ink",
          )}
        >
          {i.label}
        </Link>
      ))}
    </div>
  );
}
