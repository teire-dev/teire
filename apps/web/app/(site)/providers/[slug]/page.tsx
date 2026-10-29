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
import { listChanges } from "@/lib/catalog";
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
              <li key={src.url}>
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

      {models.length ? (
        <section className="flex flex-col gap-3" aria-label="Models with a change">
          <h2 className="heading text-xl text-ink">Models with a change</h2>
          <ul className="flex flex-col divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
            {models.slice(0, 40).map((m) => (
              <li key={m.id}>
                <Link
                  href={`/changes/${m.change.id}`}
                  className="flex flex-wrap items-center gap-2 px-4 py-2.5 font-mono text-xs hover:bg-hover"
                >
                  <span className="text-ink-3 line-through decoration-broke/60">{m.id}</span>
                  {m.replacement ? (
                    <>
                      <span className="text-ink-3" aria-hidden>
                        →
                      </span>
                      <span className="text-ink">{m.replacement}</span>
                    </>
                  ) : null}
                  {m.change.deadline ? (
                    <span className="ml-auto rounded-full bg-attention-soft px-2 py-0.5 text-[11px] text-attention">
                      {until(m.change.deadline)}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
        <h2 className="heading text-xl text-ink">
          Changes <span className="font-mono text-sm text-ink-3">{rows.length}</span>
        </h2>
        {rows.length ? (
          <ul className="flex flex-col divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
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
