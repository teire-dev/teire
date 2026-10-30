import { Quote as QuoteIcon, Search } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { FilterSelect } from "@/components/app/filter-select";
import { ActivityLanes, WatchBand, WhatsNew, watchedOf } from "@/components/catalog/pulse";
import { YourReach } from "@/components/catalog/your-reach";
import { DeadlineRail } from "@/components/deadline-rail";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { TileSquare } from "@/components/flow/tile";
import { Mark } from "@/components/teire/mark";
import { Input } from "@/components/ui/input";
import { ECOSYSTEMS } from "@/lib/brands";
import {
  type CatalogRow,
  listChanges,
  plainQuote,
  providerNames,
  sourceLabel,
  sourceLogo,
  sourceOf,
  watchedSources,
} from "@/lib/catalog";
import { packageHref, providerHref } from "@/lib/links";
import { until } from "@/lib/time";
import { CLASSES, ClassChip } from "./class-chip";

export const metadata = {
  title: "Changes",
  description:
    "Every package, API and model change Teire has read for the repositories it scans, each confirmed against a quote from its source.",
};

const PAGE = 60;

/**
 * The public catalog (plan revision 3.4, V5): why a change is here as one small flow, the filters as
 * dropdowns, then a dated rail of cards (source, class, deadline, your reach, from → to) with each
 * quote folded into a chip that opens in place.
 */
export default function ChangesPage({ searchParams }: PageProps<"/changes">) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-10 px-4 py-10">
      <Suspense
        fallback={
          <div
            className="flex h-96 items-center justify-center rounded-feature bg-hero dark:ring-1 dark:ring-white/10"
            aria-hidden
          >
            <GhostFlow tiles={4} />
          </div>
        }
      >
        <ChangeList searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

const param = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

async function ChangeList({ searchParams }: { searchParams: PageProps<"/changes">["searchParams"] }) {
  // Countdowns read the clock, so the list renders per request; the catalog itself stays cached.
  await connection();
  const params = await searchParams;
  const [all, names, pages] = await Promise.all([listChanges(), providerNames(), watchedSources()]);
  if (!all.length)
    return (
      <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
        <TileSquare tile={{ entity: "change", state: "pending", label: "" }} size="sm" />
        <span className="text-sm text-ink-2">No changes yet</span>
        <Link href="/scan" className="ml-auto text-xs text-ink-2 hover:text-ink">
          Scan a public repo ›
        </Link>
      </div>
    );
  const sources = [...new Set(all.map(sourceOf))].sort((a, b) =>
    sourceLabel(a, names).localeCompare(sourceLabel(b, names)),
  );
  const source = param(params.source);
  const cls = param(params.class);
  // When it bites (plan revision 3.4, V5: the deadline filter): dated, the next 30 days, past, undated.
  const when = param(params.when);
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const day = (r: CatalogRow) => r.deadline?.slice(0, 10) ?? null;
  const today0 = new Date().toISOString().slice(0, 10);
  const byWhen = (r: CatalogRow) =>
    !when ||
    (when === "dated" && !!day(r)) ||
    (when === "soon" && !!day(r) && (day(r) as string) >= today0 && (day(r) as string) <= soon) ||
    (when === "past" && !!day(r) && (day(r) as string) < today0) ||
    (when === "undated" && !day(r));
  const q = param(params.q)?.trim().toLowerCase() ?? "";
  const rows = all.filter(
    (r) =>
      (!source || sourceOf(r) === source) &&
      (!cls || r.class === cls) &&
      byWhen(r) &&
      (!q || r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)),
  );
  // Every change can be reached a page at a time; a filter starts again from the first page.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE));
  const page = Math.min(pageCount, Math.max(1, Number(param(params.page)) || 1));
  const href = (next: Record<string, string | null>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ source, class: cls, when, q: q || null, ...next }))
      if (v) sp.set(k, v);
    return `${sp.size ? `/changes?${sp}` : "/changes"}#browse`;
  };
  const at = (n: number) => href({ page: n > 1 ? String(n) : null });
  const shown = rows.slice((page - 1) * PAGE, page * PAGE);
  // Month groups along a dated rail: by deadline, else by when the source was read.
  const months = new Map<string, typeof rows>();
  for (const r of shown) {
    const when = (r.deadline ?? r.record.sources[0]?.checkedAt ?? "").slice(0, 7) || "undated";
    months.set(when, [...(months.get(when) ?? []), r]);
  }

  const watched = watchedOf(all, pages, names);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <WatchBand
        watched={watched}
        total={all.length}
        week={all.filter((r) => r.createdAt >= weekAgo).length}
        checkedToday={
          pages.filter((x) => x.checked && x.checked >= new Date(Date.now() - 86_400_000).toISOString())
            .length
        }
        ahead={all.filter((r) => r.deadline && r.deadline >= today).length}
      />
      <WhatsNew rows={all} names={names} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <ActivityLanes rows={all} watched={watched} />
        <section className="flex flex-col gap-3" aria-label="Coming up">
          <h2 className="heading text-xl text-ink">Coming up</h2>
          <div className="rounded-xl bg-sheet p-5 shadow-card">
            <DeadlineRail max={5} />
          </div>
        </section>
      </div>
      <section id="browse" className="flex scroll-mt-24 flex-col gap-4">
        <h2 className="heading text-xl text-ink">Every change</h2>
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Filter changes">
          <form action="/changes" className="relative">
            {source ? <input type="hidden" name="source" value={source} /> : null}
            {cls ? <input type="hidden" name="class" value={cls} /> : null}
            {when ? <input type="hidden" name="when" value={when} /> : null}
            <Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-ink-3" aria-hidden />
            <Input
              name="q"
              defaultValue={q}
              placeholder="Model, package, title"
              aria-label="Search changes"
              className="h-7 w-56 rounded-full pl-8 text-xs"
            />
          </form>
          <FilterSelect
            label="Source"
            value={source ?? "all"}
            options={[
              { value: "all", label: "Every source", href: href({ source: null }) },
              ...sources.map((key) => {
                const logo = sourceLogo(key);
                return {
                  value: key,
                  label: sourceLabel(key, names),
                  href: href({ source: key }),
                  brand: { label: sourceLabel(key, names), light: logo.light, dark: logo.dark },
                };
              }),
            ]}
          />
          <FilterSelect
            label="Class"
            value={cls ?? "all"}
            options={[
              { value: "all", label: "Any class", href: href({ class: null }) },
              ...CLASSES.map((c) => ({ value: c.value, label: c.label, href: href({ class: c.value }) })),
            ]}
          />
          <FilterSelect
            label="When"
            value={when ?? "all"}
            options={[
              { value: "all", label: "Any time", href: href({ when: null }) },
              { value: "soon", label: "Next 30 days", href: href({ when: "soon" }) },
              { value: "dated", label: "Has a date", href: href({ when: "dated" }) },
              { value: "past", label: "Already past", href: href({ when: "past" }) },
              { value: "undated", label: "No date", href: href({ when: "undated" }) },
            ]}
          />
          <span className="ml-auto font-mono text-xs text-ink-3">
            {pageCount > 1
              ? `${(page - 1) * PAGE + 1}–${(page - 1) * PAGE + shown.length} of ${rows.length}`
              : rows.length}
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
            <TileSquare tile={{ entity: "change", state: "pending", label: "" }} size="sm" />
            <span className="text-sm text-ink-2">Nothing matches</span>
            <Link href="/changes" className="ml-auto text-xs text-ink-2 hover:text-ink">
              Clear
            </Link>
          </div>
        ) : null}
        {[...months].map(([month, list]) => (
          <div key={month} className="grid gap-3 sm:grid-cols-[5.5rem_1fr]">
            <p className="pt-3 font-mono text-xs text-ink-3 sm:sticky sm:top-24 sm:self-start">{month}</p>
            <ul className="flex flex-col gap-2">
              {list.map((r) => {
                const key = sourceOf(r);
                const logo = sourceLogo(key);
                const quoted = r.record.sources.find((s) => s.quote);
                const raw = quoted?.quote;
                const quote = raw ? plainQuote(raw) : null;
                const from =
                  r.record.signatures.find((s) => s.kind === "string-literal")?.value ??
                  r.record.applicability.fromVersion ??
                  null;
                return (
                  <li key={r.id} className="flex flex-col gap-2 rounded-xl bg-sheet p-4 shadow-card">
                    <div className="flex items-start gap-3">
                      <Mark brand={{ label: sourceLabel(key, names), light: logo.light, dark: logo.dark }} />
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <Link
                          href={`/changes/${r.id}`}
                          className="text-sm font-medium text-ink hover:underline"
                        >
                          {r.title}
                        </Link>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                          <SourceName row={r} sourceKey={key} names={names} />
                          <ClassChip value={r.class} />
                          {r.deadline ? (
                            <span className="rounded-full bg-attention-soft px-2 py-0.5 font-mono text-[11px] text-attention">
                              {until(r.deadline)}
                            </span>
                          ) : null}
                          {r.record.replacement ? (
                            <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[11px]">
                              {from ? (
                                <span className="text-ink-3 line-through decoration-broke/60">{from}</span>
                              ) : null}
                              {from ? " → " : "→ "}
                              <span className="text-ink">{r.record.replacement.value}</span>
                            </span>
                          ) : null}
                          <YourReach changeId={r.id} />
                        </div>
                      </div>
                    </div>
                    {quote ? (
                      <details className="group/quote">
                        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-full bg-sunken px-2.5 py-0.5 text-[11px] text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
                          <QuoteIcon className="size-3" aria-hidden />
                          Quote
                        </summary>
                        <blockquote className="mt-2 border-l-2 border-rule-strong pl-3 text-sm break-words text-ink-2">
                          “{quote.length > 400 ? `${quote.slice(0, 400)}…` : quote}”
                        </blockquote>
                        {quoted ? (
                          <a
                            href={quoted.url}
                            rel="noreferrer"
                            className="mt-1.5 ml-3 block w-fit font-mono text-[11px] text-ink-3 hover:text-ink"
                          >
                            {new URL(quoted.url).host} ›
                          </a>
                        ) : null}
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {pageCount > 1 ? (
          <nav aria-label="Pages" className="flex items-center justify-center gap-2 font-mono text-xs">
            {page > 1 ? (
              <Link
                href={at(page - 1)}
                className="rounded-full bg-sheet px-3 py-1.5 text-ink-2 shadow-tile hover:text-ink"
              >
                ‹ Previous
              </Link>
            ) : null}
            <span className="px-2 text-ink-3" aria-current="page">
              {page} / {pageCount}
            </span>
            {page < pageCount ? (
              <Link
                href={at(page + 1)}
                className="rounded-full bg-sheet px-3 py-1.5 text-ink-2 shadow-tile hover:text-ink"
              >
                Next ›
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </>
  );
}

/** Who the change belongs to, leading to its page: the provider, or the package (not the ecosystem). */
function SourceName({
  row,
  sourceKey,
  names,
}: {
  row: CatalogRow;
  sourceKey: string;
  names: Record<string, string>;
}) {
  if (sourceKey.startsWith("pkg:")) {
    const eco = sourceKey.slice(4);
    const href = packageHref(eco, row.record.subject.name);
    const label = `${ECOSYSTEMS[eco]?.label ?? eco} · ${row.record.subject.name}`;
    return href ? (
      <Link href={href} className="hover:text-ink hover:underline">
        {label}
      </Link>
    ) : (
      <span>{label}</span>
    );
  }
  const href = providerHref(sourceKey);
  const label = sourceLabel(sourceKey, names);
  return href && sourceKey !== "runtime" && sourceKey !== "other" ? (
    <Link href={href} className="hover:text-ink hover:underline">
      {label}
    </Link>
  ) : (
    <span>{label}</span>
  );
}
