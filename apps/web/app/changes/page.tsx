import { Search } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { Input } from "@/components/ui/input";
import { listChanges, plainQuote, providerNames, sourceLabel, sourceLogo, sourceOf } from "@/lib/catalog";
import { CLASSES, ClassChip } from "./class-chip";

export const metadata = {
  title: "Changes",
  description:
    "Every package, API and model change Teire has read for the repositories it scans, each confirmed against a quote from its source.",
};

const PAGE = 120;

/** The public catalog (C10): a dated rail of changes, filterable by source, class and text. */
export default function ChangesPage({ searchParams }: PageProps<"/changes">) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-12">
      <header className="flex max-w-3xl flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Changes</h1>
        <p className="text-subtle">
          Teire reads a change only because a repository it scans depends on it: a package it could upgrade,
          or an API its code calls. Each one is kept only when its quote matches the source page, and each is
          what Teire searches your code for.
        </p>
      </header>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <ChangeList searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

const param = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

async function ChangeList({ searchParams }: { searchParams: PageProps<"/changes">["searchParams"] }) {
  const params = await searchParams;
  const [all, names] = await Promise.all([listChanges(), providerNames()]);
  if (!all.length)
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg bg-card p-6 shadow-card">
        <p className="font-medium">No changes yet</p>
        <p className="text-sm text-muted-foreground">
          Changes appear here once Teire scans a repository that depends on them.
        </p>
        <Link href="/scan" className="text-sm text-link hover:underline">
          Scan a public repository
        </Link>
      </div>
    );
  const sources = [...new Set(all.map(sourceOf))].sort((a, b) =>
    sourceLabel(a, names).localeCompare(sourceLabel(b, names)),
  );
  const source = param(params.source);
  const cls = param(params.class);
  const q = param(params.q)?.trim().toLowerCase() ?? "";
  const rows = all.filter(
    (r) =>
      (!source || sourceOf(r) === source) &&
      (!cls || r.class === cls) &&
      (!q || r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)),
  );
  const href = (next: Record<string, string | null>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ source, class: cls, q: q || null, ...next })) if (v) sp.set(k, v);
    return sp.size ? `/changes?${sp}` : "/changes";
  };
  // Month groups along a dated rail: by deadline, else by when the source was read.
  const months = new Map<string, typeof rows>();
  for (const r of rows.slice(0, PAGE)) {
    const when = (r.deadline ?? r.record.sources[0]?.checkedAt ?? "").slice(0, 7) || "undated";
    months.set(when, [...(months.get(when) ?? []), r]);
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[14rem_1fr]">
      <aside className="flex flex-col gap-6 text-sm lg:sticky lg:top-20 lg:self-start">
        <form action="/changes" className="relative">
          {source ? <input type="hidden" name="source" value={source} /> : null}
          {cls ? <input type="hidden" name="class" value={cls} /> : null}
          <Search
            className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            name="q"
            defaultValue={q}
            placeholder="Model, package, title"
            aria-label="Search changes"
            className="pl-8"
          />
        </form>
        <nav aria-label="Filter by source" className="flex flex-col gap-0.5">
          <p className="mb-1 text-xs text-muted-foreground">Source</p>
          <FilterLink href={href({ source: null })} active={!source}>
            All sources
          </FilterLink>
          {sources.map((key) => {
            const logo = sourceLogo(key);
            return (
              <FilterLink key={key} href={href({ source: key })} active={source === key}>
                <BrandLogo light={logo.light} dark={logo.dark} alt="" className="h-3.5" />
                {sourceLabel(key, names)}
              </FilterLink>
            );
          })}
        </nav>
        <nav aria-label="Filter by class" className="flex flex-col gap-0.5">
          <p className="mb-1 text-xs text-muted-foreground">Class</p>
          <FilterLink href={href({ class: null })} active={!cls}>
            Any class
          </FilterLink>
          {CLASSES.map((c) => (
            <FilterLink key={c.value} href={href({ class: c.value })} active={cls === c.value}>
              {c.label}
            </FilterLink>
          ))}
        </nav>
      </aside>

      <section className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">
          {rows.length} change{rows.length === 1 ? "" : "s"}
          {source ? ` from ${sourceLabel(source, names)}` : ""}
          {rows.length > PAGE ? ` · the first ${PAGE} shown; narrow with a filter or search` : ""}
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing matches.{" "}
            <Link href="/changes" className="text-link hover:underline">
              Clear the filters
            </Link>
            .
          </p>
        ) : null}
        {[...months].map(([month, list]) => (
          <div key={month} className="grid gap-3 sm:grid-cols-[5.5rem_1fr]">
            <p className="pt-3 font-mono text-xs text-muted-foreground sm:sticky sm:top-20 sm:self-start">
              {month}
            </p>
            <ul className="flex flex-col divide-y overflow-hidden rounded-lg bg-card shadow-card">
              {list.map((r) => {
                const key = sourceOf(r);
                const logo = sourceLogo(key);
                const raw = r.record.sources.find((s) => s.quote)?.quote;
                const quote = raw ? plainQuote(raw) : null;
                const from =
                  r.record.signatures.find((s) => s.kind === "string-literal")?.value ??
                  r.record.applicability.fromVersion ??
                  null;
                return (
                  <li key={r.id} className="flex flex-col gap-2 p-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <BrandLogo light={logo.light} dark={logo.dark} alt="" className="h-3.5" />
                      <span>{sourceLabel(key, names)}</span>
                      <ClassChip value={r.class} />
                      {r.deadline ? (
                        <span className="font-mono text-human">{r.deadline.slice(0, 10)}</span>
                      ) : null}
                    </div>
                    <Link href={`/changes/${r.id}`} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                    {r.record.replacement ? (
                      <p className="font-mono text-sm">
                        {from ? (
                          <span className="text-muted-foreground line-through decoration-affected/60">
                            {from}
                          </span>
                        ) : null}
                        {from ? " → " : "→ "}
                        {r.record.replacement.value}
                      </p>
                    ) : null}
                    {quote ? (
                      <blockquote className="border-l-2 pl-3 text-sm break-words text-muted-foreground">
                        “{quote.length > 240 ? `${quote.slice(0, 240)}…` : quote}”
                      </blockquote>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent ${active ? "font-medium text-link" : "text-muted-foreground"}`}
    >
      {children}
    </Link>
  );
}
