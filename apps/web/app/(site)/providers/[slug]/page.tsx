import { ExternalLink, FileText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { StaticFlow } from "@/components/flow/static-flow";
import { TileSquare } from "@/components/flow/tile";
import { Mark } from "@/components/teire/mark";
import { ecosystemOf, STACK } from "@/lib/brands";
import { type CatalogRow, listChanges } from "@/lib/catalog";
import { providerPage } from "@/lib/entities";
import type { FlowGraph } from "@/lib/flow/model";
import { providerLogo } from "@/lib/logos";
import { ago, until } from "@/lib/time";
import { cn } from "@/lib/utils";
import { ClassChip } from "../../changes/class-chip";

export async function generateMetadata({ params }: PageProps<"/providers/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${providerLogo(slug).name} changes` };
}

/**
 * A provider (plan revision 3.4, V5): how Teire reads it as a flow, the pages it watches with each
 * one's status and last check, its models with a change as old → new with a countdown, its SDKs as
 * chips, and its changes.
 */
export default function ProviderPage({ params }: PageProps<"/providers/[slug]">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-12">
      <Link href="/changes" className="text-sm text-ink-3 hover:text-ink">
        ← All changes
      </Link>
      <Suspense
        fallback={
          <div className="flex h-96 items-center justify-center rounded-xl bg-sheet shadow-card" aria-hidden>
            <GhostFlow tiles={4} />
          </div>
        }
      >
        <Provider params={params} />
      </Suspense>
    </main>
  );
}

async function Provider({ params }: { params: PageProps<"/providers/[slug]">["params"] }) {
  const { slug } = await params;
  // "Upcoming" is relative to today: rendered per request, while the data stays cached.
  await connection();
  const [page, all] = await Promise.all([providerPage(slug), listChanges()]);
  if (!page) notFound();
  const { record, sources } = page;
  const logo = providerLogo(slug);
  const rows = all.filter((r) => r.provider === slug);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = rows.filter((r) => r.deadline && r.deadline.slice(0, 10) >= today);
  const models = rows
    .flatMap((r) =>
      r.record.signatures
        .filter((s) => s.kind === "string-literal")
        .map((s) => ({ id: s.value, change: r, replacement: r.record.replacement?.value ?? null })),
    )
    .filter((m, i, list) => list.findIndex((x) => x.id === m.id) === i);
  const discovered = Boolean(record.discovery);

  const failing = sources.filter((x) => x.status === "failing").length;
  const checked = sources
    .map((x) => x.lastCheckedAt)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);
  const graph: FlowGraph = {
    tiles: [
      {
        id: "pages",
        entity: "change",
        state: failing ? "not_proven" : "done",
        label: `${record.sources.length} page${record.sources.length === 1 ? "" : "s"}`,
        meta: checked ? `checked ${ago(checked)}` : "not read yet",
        brand: { label: record.name, light: logo.light, dark: logo.dark },
      },
      {
        id: "reader",
        entity: "fix",
        state: "done",
        label: discovered ? "Nemotron reads" : "Teire's reader",
        ...(discovered ? { brand: STACK.nemotron } : {}),
      },
      { id: "quote", entity: "check", state: "proven", label: "Quotes checked" },
      {
        id: "changes",
        entity: "outcome",
        state: rows.length ? "done" : "pending",
        label: `${rows.length} change${rows.length === 1 ? "" : "s"}`,
        ...(upcoming.length ? { caption: `${upcoming.length} upcoming` } : {}),
      },
    ],
    links: [
      { from: "pages", to: "reader", state: "done" },
      { from: "reader", to: "quote", state: "done" },
      { from: "quote", to: "changes", state: "proven" },
    ],
  };

  return (
    <>
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Mark brand={{ label: record.name, light: logo.light, dark: logo.dark }} size="lg" />
          <h1 className="heading text-3xl text-ink">{record.name}</h1>
          <span className="rounded-full bg-sunken px-2.5 py-0.5 text-xs text-ink-2">
            {discovered ? "discovered in code" : "hand-written reader"}
          </span>
          <a href={record.homepage} className="flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
            {new URL(record.homepage).host} <ExternalLink className="size-3" aria-hidden />
          </a>
        </div>
        <div className="rounded-xl bg-sheet p-5 shadow-card">
          <StaticFlow graph={graph} size="sm" label={`How Teire reads ${record.name}`} />
        </div>
      </header>

      <section className="flex flex-col gap-3" aria-label="Pages Teire watches">
        <h2 className="heading text-xl text-ink">Pages it watches</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {record.sources.map((src) => {
            const health = sources.find((x) => x.url === src.url);
            const status = health?.status ?? "stale";
            return (
              <li key={src.url} className="min-w-0">
                <a
                  href={src.url}
                  className="flex items-center gap-3 rounded-xl bg-sheet p-3 shadow-card hover:shadow-card-hover"
                >
                  <span className="relative flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-sunken">
                    <FileText className="size-4 text-ink-2" aria-hidden />
                    <span
                      aria-hidden
                      className={cn(
                        "absolute -right-1 -bottom-1 size-3 rounded-full ring-2 ring-sheet",
                        status === "ok" ? "bg-proven" : status === "failing" ? "bg-broke" : "bg-attention",
                      )}
                    />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-ink">
                      {new URL(src.url).host}
                      <span className="text-ink-3">{new URL(src.url).pathname}</span>
                    </span>
                    <span className="font-mono text-[11px] text-ink-3">
                      {src.kind} ·{" "}
                      {health?.lastCheckedAt ? `${status} · ${ago(health.lastCheckedAt)}` : "not read yet"}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </section>

      {models.length ? <RetirementRail models={models} today={today} /> : null}

      {record.sdks.length ? (
        <section className="flex flex-col gap-3" aria-label="SDK packages">
          <h2 className="heading text-xl text-ink">Its SDKs</h2>
          <ul className="flex flex-wrap gap-2">
            {record.sdks.map((sdk) => {
              const e = ecosystemOf(sdk.ecosystem);
              return (
                <li key={`${sdk.ecosystem}:${sdk.name}`}>
                  <Link
                    href={`/packages/${sdk.ecosystem}/${sdk.name.split("/").map(encodeURIComponent).join("/")}`}
                    className="flex items-center gap-2 rounded-full bg-sheet py-1 pr-3 pl-1.5 text-xs shadow-tile ring-1 ring-rule hover:ring-rule-strong"
                  >
                    {e ? (
                      <span className="flex size-5 items-center justify-center rounded-full bg-sunken">
                        <BrandLogo light={e.light} dark={e.dark} alt="" className="h-3 w-auto" />
                      </span>
                    ) : null}
                    <span className="font-mono text-ink">{sdk.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Changes">
        {rows.length ? (
          <details className="group/all flex flex-col gap-3">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
              <h2 className="heading text-xl text-ink">All its changes</h2>
              <span className="font-mono text-sm text-ink-3">{rows.length}</span>
              <span aria-hidden className="text-ink-3 transition-transform group-open/all:rotate-90">
                ›
              </span>
            </summary>
            <ul className="mt-3 flex flex-col divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
              {rows.slice(0, 100).map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/changes/${r.id}`}
                    className="flex flex-col gap-1 px-4 py-2.5 hover:bg-hover sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="text-sm text-ink">{r.title}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <ClassChip value={r.class} />
                      {r.deadline ? (
                        <span className="font-mono text-[11px] text-attention">{until(r.deadline)}</span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
            <TileSquare tile={{ entity: "change", state: "pending", label: "" }} size="sm" />
            <span className="text-sm text-ink-2">Read again when a scanned repository uses it</span>
            <Link href="/scan" className="ml-auto text-xs text-ink-2 hover:text-ink">
              Scan ›
            </Link>
          </div>
        )}
      </section>
    </>
  );
}

type Retiring = { id: string; change: CatalogRow; replacement: string | null };

/**
 * The provider's models on a retirement timeline (plan revision 3.4, V5: "models as tiles on a
 * retirement timeline; each tile → its change"): one stop per shutdown date along a rail, today
 * marked between what is gone and what is coming, each stop's models as old → new chips.
 */
function RetirementRail({ models, today }: { models: Retiring[]; today: string }) {
  const byDate = new Map<string, Retiring[]>();
  for (const m of models) {
    const d = m.change.deadline?.slice(0, 10) ?? "undated";
    byDate.set(d, [...(byDate.get(d) ?? []), m]);
  }
  const dates = [...byDate.keys()].filter((d) => d !== "undated").sort();
  const past = dates.filter((d) => d < today);
  const ahead = dates.filter((d) => d >= today);
  // The latest shutdown, today, then everything ahead (the past count is in the heading).
  const shownPast = past.slice(-1);
  const stops: (string | "today")[] = [...shownPast, "today", ...ahead];
  const undated = byDate.get("undated") ?? [];
  return (
    <section className="flex flex-col gap-3" aria-label="Retirement timeline">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="heading text-xl text-ink">Retirements</h2>
        <span className="font-mono text-[11px] text-ink-3">
          {ahead.length} ahead{past.length ? ` · ${past.length} past` : ""}
        </span>
      </div>
      <ol className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pt-3 pb-2 [scrollbar-width:thin]">
        {stops.map((d) =>
          d === "today" ? (
            <li key="today" className="relative flex w-16 shrink-0 flex-col items-center pt-1">
              <span aria-hidden className="absolute top-[13px] -right-3 -left-3 h-px bg-rule-strong" />
              <span className="relative size-3 rounded-full bg-signal ring-4 ring-signal-soft" />
              <span className="mt-2 font-mono text-[11px] text-signal">today</span>
            </li>
          ) : (
            <li key={d} className="relative flex w-56 shrink-0 snap-start flex-col gap-2 pt-1">
              <span aria-hidden className="absolute top-[13px] -right-3 left-0 h-px bg-rule-strong" />
              <span
                aria-hidden
                className={cn(
                  "relative ml-3 size-3 rounded-full ring-4",
                  d < today ? "bg-broke ring-broke-soft" : "bg-attention ring-attention-soft",
                )}
              />
              <div
                className={cn(
                  "flex flex-col gap-2 rounded-xl bg-sheet p-3 shadow-card ring-1",
                  d < today ? "ring-broke/25" : "ring-attention/30",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-ink">{d}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 font-mono text-[11px]",
                      d < today ? "bg-broke-soft text-broke" : "bg-attention-soft text-attention",
                    )}
                  >
                    {until(d)}
                  </span>
                </div>
                <ul className="flex flex-col gap-1">
                  {(byDate.get(d) ?? []).slice(0, 5).map((m) => (
                    <li key={m.id}>
                      <Link
                        href={`/changes/${m.change.id}`}
                        className="flex flex-wrap items-center gap-1 rounded-md px-1 py-0.5 font-mono text-[11px] hover:bg-hover"
                      >
                        <span className="text-ink-3 line-through decoration-broke/60">{m.id}</span>
                        {m.replacement ? (
                          <>
                            <span aria-hidden className="text-ink-3">
                              →
                            </span>
                            <span className="text-proven">{m.replacement}</span>
                          </>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                  {(byDate.get(d)?.length ?? 0) > 5 ? (
                    <li className="px-1 font-mono text-[11px] text-ink-3">
                      +{(byDate.get(d)?.length ?? 0) - 5}
                    </li>
                  ) : null}
                </ul>
              </div>
            </li>
          ),
        )}
      </ol>
      {undated.length ? (
        <p className="flex flex-wrap gap-1.5 font-mono text-[11px] text-ink-3">
          <span>No date yet:</span>
          {undated.slice(0, 12).map((m) => (
            <Link
              key={m.id}
              href={`/changes/${m.change.id}`}
              className="rounded-full bg-sunken px-2 py-0.5 hover:text-ink"
            >
              {m.id}
            </Link>
          ))}
        </p>
      ) : null}
    </section>
  );
}
