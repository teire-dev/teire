import { and, eq, inArray, repos, runs, sql } from "@teire/db";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { RunRowItem } from "@/components/teire/run-row";
import { myScope } from "@/lib/app-shell";
import { getSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { NEEDS_YOU, runsOf } from "@/lib/workspace";
import { InstallCard, SignInCard } from "../gate";

export const metadata = { title: "Runs" };

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
  regression: "Regression",
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
  const rows = await runsOf(
    mine.scope,
    and(
      (SHOW[show] ?? SHOW.all).where,
      evidence && evidence in EVIDENCE ? eq(runs.evidenceKind, evidence as keyof typeof EVIDENCE) : undefined,
      repo ? eq(repos.fullName, repo) : undefined,
    ),
    80,
  );
  const href = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ show, evidence, repo, ...patch }))
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
        {repo ? <Chips items={[{ label: `${repo} ✕`, href: href({ repo: null }), on: true }]} /> : null}
      </nav>
      {rows.length ? (
        <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
          {rows.map((r) => (
            <RunRowItem key={r.id} row={r} href={`/runs/${r.id}`} />
          ))}
        </ul>
      ) : (
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
