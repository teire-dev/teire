import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { Badge } from "@/components/ui/badge";
import { ecosystemOf } from "@/lib/brands";
import { listChanges } from "@/lib/catalog";
import { providerPage } from "@/lib/entities";
import { providerLogo } from "@/lib/logos";
import { ClassChip } from "../../changes/class-chip";

export async function generateMetadata({ params }: PageProps<"/providers/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${providerLogo(slug).name} changes` };
}

/** A provider (C10): the pages Teire reads for it and their health, its models, SDKs and changes. */
export default function ProviderPage({ params }: PageProps<"/providers/[slug]">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-12">
      <Link href="/changes" className="text-sm text-muted-foreground hover:text-foreground">
        ← All changes
      </Link>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <Provider params={params} />
      </Suspense>
    </main>
  );
}

const TONE = { ok: "bg-clear", stale: "bg-human", failing: "bg-affected" } as const;

async function Provider({ params }: { params: PageProps<"/providers/[slug]">["params"] }) {
  const { slug } = await params;
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

  return (
    <>
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <BrandLogo light={logo.light} dark={logo.dark} alt="" className="h-8" />
          <h1 className="text-3xl font-semibold tracking-tight">{record.name}</h1>
          {discovered ? <Badge variant="outline">discovered from code</Badge> : null}
        </div>
        <p className="text-subtle">
          {discovered
            ? `Teire found ${record.name} in a scanned repository's code or SDKs and read its notices with Nemotron, keeping only quotes that match each page.`
            : `Teire reads ${record.name}'s change pages with a reader written for them, and keeps only quotes that match each page.`}{" "}
          It reads them again whenever a scanned repository uses {record.name}.
        </p>
        <a href={record.homepage} className="flex w-fit items-center gap-1 text-sm text-link hover:underline">
          {new URL(record.homepage).host} <ExternalLink className="size-3" aria-hidden />
        </a>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Pages Teire reads</h2>
        <ul className="divide-y overflow-hidden rounded-lg bg-card shadow-card">
          {record.sources.map((s) => {
            const health = sources.find((x) => x.url === s.url);
            return (
              <li
                key={s.url}
                className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={`size-2 shrink-0 rounded-full ${health ? (TONE[health.status as keyof typeof TONE] ?? "bg-muted-foreground") : "bg-muted-foreground"}`}
                    aria-hidden
                  />
                  <a href={s.url} className="truncate text-link hover:underline">
                    {new URL(s.url).host}
                    {new URL(s.url).pathname}
                  </a>
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {s.kind} ·{" "}
                  {health?.lastCheckedAt
                    ? `${health.status} · checked ${health.lastCheckedAt.slice(0, 10)}`
                    : "not read yet"}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {models.length || record.sdks.length ? (
        <section className="grid gap-6 md:grid-cols-2">
          {models.length ? (
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">Models with a change</h2>
              <ul className="divide-y overflow-hidden rounded-lg bg-card font-mono text-xs shadow-card">
                {models.slice(0, 40).map((m) => (
                  <li key={m.id}>
                    <Link
                      href={`/changes/${m.change.id}`}
                      className="flex flex-col gap-0.5 px-4 py-2 hover:bg-accent"
                    >
                      <span>
                        <span className="text-muted-foreground line-through decoration-affected/60">
                          {m.id}
                        </span>
                        {m.replacement ? ` → ${m.replacement}` : ""}
                      </span>
                      {m.change.deadline ? (
                        <span className="text-human">{m.change.deadline.slice(0, 10)}</span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {record.sdks.length ? (
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">SDK packages Teire recognises</h2>
              <ul className="divide-y overflow-hidden rounded-lg bg-card text-sm shadow-card">
                {record.sdks.map((s) => {
                  const e = ecosystemOf(s.ecosystem);
                  return (
                    <li key={`${s.ecosystem}:${s.name}`}>
                      <Link
                        href={`/packages/${s.ecosystem}/${s.name.split("/").map(encodeURIComponent).join("/")}`}
                        className="flex items-center gap-2 px-4 py-2 hover:bg-accent"
                      >
                        {e ? <BrandLogo light={e.light} dark={e.dark} alt="" className="h-3.5" /> : null}
                        <span className="font-mono text-xs">{s.name}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">
          Changes{" "}
          <span className="text-muted-foreground">
            ({rows.length}
            {upcoming.length ? `, ${upcoming.length} upcoming` : ""})
          </span>
        </h2>
        {rows.length ? (
          <ul className="divide-y overflow-hidden rounded-lg bg-card shadow-card">
            {rows.slice(0, 100).map((r) => (
              <li key={r.id}>
                <Link
                  href={`/changes/${r.id}`}
                  className="flex flex-col gap-1 px-4 py-3 hover:bg-accent sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="text-sm">{r.title}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <ClassChip value={r.class} />
                    {r.deadline ? (
                      <span className="font-mono text-xs text-human">{r.deadline.slice(0, 10)}</span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No confirmed public change yet.</p>
        )}
      </section>
    </>
  );
}
