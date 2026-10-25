import Link from "next/link";
import { Suspense } from "react";
import { listChanges, plainQuote, providerNames, sourceLabel, sourceOf } from "@/lib/catalog";
import { ClassChip } from "./class-chip";

export const metadata = {
  title: "Changes · Teire",
  description:
    "Changes Teire found in what the repositories it watches depend on: package upgrades and API changes, each quoted from its source.",
};

/** Changes Teire has read for watched repositories, each with its source quoted (card C10). */
export default function ChangesPage({ searchParams }: PageProps<"/changes">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Changes</h1>
        <p className="text-sm text-foreground/70">
          Every change here was read because a repository Teire watches depends on it: a package it can
          upgrade, or an API it calls. Teire reads nothing else. Each change quotes its source, and Teire
          checks the quote against that page before it touches any code.
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-foreground/60">Loading changes…</p>}>
        <ChangeList searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function ChangeList({ searchParams }: { searchParams: PageProps<"/changes">["searchParams"] }) {
  const params = await searchParams;
  const [all, names] = await Promise.all([listChanges(), providerNames()]);
  const sources = [...new Set(all.map(sourceOf))];
  const source = typeof params.source === "string" && sources.includes(params.source) ? params.source : null;
  const rows = source ? all.filter((r) => sourceOf(r) === source) : all;
  if (!all.length)
    return (
      <p className="rounded-lg border border-foreground/10 p-6 text-sm text-foreground/70">
        Nothing yet. Changes appear here once Teire scans a repository that depends on them.
      </p>
    );
  return (
    <>
      {sources.length > 1 ? (
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter by source">
          <Link
            href="/changes"
            className={`rounded-full border px-3 py-1 ${source ? "border-foreground/15 text-foreground/70" : "border-foreground bg-foreground text-background"}`}
          >
            All
          </Link>
          {sources.map((key) => (
            <Link
              key={key}
              href={`/changes?source=${encodeURIComponent(key)}`}
              className={`rounded-full border px-3 py-1 ${source === key ? "border-foreground bg-foreground text-background" : "border-foreground/15 text-foreground/70"}`}
            >
              {sourceLabel(key, names)}
            </Link>
          ))}
        </nav>
      ) : null}
      <p className="text-sm text-foreground/60">
        {rows.length} change{rows.length === 1 ? "" : "s"}
        {source ? ` from ${sourceLabel(source, names)}` : ""}
      </p>
      <ul className="flex flex-col divide-y divide-foreground/10 rounded-lg border border-foreground/10">
        {rows.map((r) => {
          const raw = r.record.sources.find((s) => s.quote)?.quote;
          const quote = raw ? plainQuote(raw) : null;
          return (
            <li key={r.id} className="flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/60">
                <span>{sourceLabel(sourceOf(r), names)}</span>
                <ClassChip value={r.class} />
                {r.deadline ? <span className="font-mono">{r.deadline}</span> : null}
              </div>
              <Link href={`/changes/${r.id}`} className="font-medium hover:underline">
                {r.title}
              </Link>
              {r.record.replacement ? (
                <p className="text-sm text-foreground/70">
                  Replacement: <span className="font-mono">{r.record.replacement.value}</span>
                </p>
              ) : null}
              {quote ? (
                <blockquote className="border-l-2 border-foreground/15 pl-3 text-sm text-foreground/70 break-words">
                  “{quote.length > 280 ? `${quote.slice(0, 280)}…` : quote}”
                </blockquote>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
