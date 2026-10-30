import { ChevronRight, ExternalLink, Quote as QuoteIcon, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { YourPackageUse } from "@/components/catalog/your-reach";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { TileSquare } from "@/components/flow/tile";
import { Mark } from "@/components/teire/mark";
import { ECOSYSTEMS } from "@/lib/brands";
import { listChanges } from "@/lib/catalog";
import { packageFacts } from "@/lib/entities";
import { changeHref } from "@/lib/links";
import { cn } from "@/lib/utils";
import { ClassChip } from "../../../changes/class-chip";

type Params = PageProps<"/packages/[ecosystem]/[...name]">["params"];

const decode = (parts: string[]) => parts.map(decodeURIComponent).join("/");

/** What each kind of computed change means, in a few words. */
const KIND_SAID: Record<string, string> = {
  "symbol-removed": "Removes APIs",
  "symbol-changed": "Changes types",
  "symbol-deprecated": "Deprecates APIs",
  "parameter-change": "Changes arguments",
  "arity-changed": "Changes argument counts",
  "optional-to-required": "Makes arguments required",
  "required-added": "Adds required arguments",
  "deep-import-removed": "Removes import paths",
  "package-deprecated": "Package deprecated",
  "package-major": "A new major",
  "security-advisory": "Security advisory",
};

/** Versions in release order: numeric parts as numbers ("v1.10.0" after "v1.9.2"), the rest as text. */
function compareVersions(a: string, b: string) {
  const pa = a.replace(/^v/, "").split(/[.+-]/);
  const pb = b.replace(/^v/, "").split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = Number(x);
    const ny = Number(y);
    if (x === y) continue;
    if (!Number.isNaN(nx) && !Number.isNaN(ny) && x !== "" && y !== "") return nx - ny;
    // A release (no suffix) comes after its prereleases.
    if (x === "") return 1;
    if (y === "") return -1;
    return x.localeCompare(y);
  }
  return 0;
}

/** How many releases the reader's "Where you stand" counts back through, newest last. */
const USE_VERSIONS = 600;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { ecosystem, name } = await params;
  // The existence check here too (revamp S3): metadata blocks the response for crawlers, so a missing
  // package is a real 404, not a 200 that streams "not found" (the page's own check is in its boundary).
  if (!ECOSYSTEMS[ecosystem]) notFound();
  const pkg = decode(name);
  const [facts, all] = await Promise.all([packageFacts(ecosystem, pkg), listChanges()]);
  if (!facts && !all.some((r) => r.record.subject.ecosystem === ecosystem && r.record.subject.name === pkg))
    notFound();
  return { title: `${pkg} (${ECOSYSTEMS[ecosystem]?.label ?? ecosystem})` };
}

/** Where each ecosystem's registry shows a package. */
function registryUrl(ecosystem: string, name: string) {
  switch (ecosystem) {
    case "npm":
      return `https://www.npmjs.com/package/${name}`;
    case "pypi":
      return `https://pypi.org/project/${name}/`;
    case "go":
      return `https://pkg.go.dev/${name}`;
    case "cargo":
      return `https://crates.io/crates/${name}`;
    case "rubygems":
      return `https://rubygems.org/gems/${name}`;
    case "maven": {
      const [group, artifact] = name.split(":");
      return `https://central.sonatype.com/artifact/${group}/${artifact}`;
    }
    default:
      return null;
  }
}

/**
 * A package (plan revision 3.4, V5): how Teire reads it as a small flow, its versions as a rail (latest,
 * deprecated, the ones with computed changes), its advisories, the changes per target and the release
 * notes' own words folded; every version in a fold.
 */
export default function PackagePage({ params }: { params: Params }) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-12">
      <Link href="/changes" className="text-sm text-ink-3 hover:text-ink">
        ← All changes
      </Link>
      <Suspense
        fallback={
          <div className="flex h-96 items-center justify-center rounded-xl bg-sheet shadow-card" aria-hidden>
            <GhostFlow tiles={3} />
          </div>
        }
      >
        <Package params={params} />
      </Suspense>
    </main>
  );
}

async function Package({ params }: { params: Params }) {
  // Per request, as the provider page: the header's session and the reader's reach are request data.
  await connection();
  const { ecosystem, name: parts } = await params;
  const eco = ECOSYSTEMS[ecosystem];
  if (!eco) notFound();
  const name = decode(parts);
  const [versions, all] = await Promise.all([packageFacts(ecosystem, name), listChanges()]);
  const rows = all.filter((r) => r.record.subject.ecosystem === ecosystem && r.record.subject.name === name);
  if (!versions && !rows.length) notFound();
  const registry = registryUrl(ecosystem, name);
  const releases = versions?.info.versions ?? [];
  const latest = releases.find((v) => v.isDefault) ?? null;
  // Advisories, and what the release notes, changelogs and migration guides said, in their words (U5).
  const advisories = rows.filter((r) => r.kind === "security-advisory");
  const computed = rows.filter((r) => r.kind !== "security-advisory");
  const notes = rows
    .flatMap((r) =>
      r.record.sources
        .filter((src) => src.quote && ["release-notes", "changelog", "migration-guide"].includes(src.kind))
        .map((src) => ({
          changeId: r.id,
          quote: src.quote as string,
          url: src.url,
          host: new URL(src.url).host,
          checkedAt: src.checkedAt,
          version: r.record.applicability.toVersion ?? null,
        })),
    )
    .filter((n, i, all) => all.findIndex((m) => m.quote === n.quote) === i)
    .slice(0, 6);
  // Changes per target version, newest target first.
  const byTarget = new Map<string, typeof rows>();
  for (const r of computed) {
    const t = r.record.applicability.toVersion ?? "other";
    byTarget.set(t, [...(byTarget.get(t) ?? []), r]);
  }
  const fixesAt = new Map<string, string[]>();
  for (const r of advisories)
    for (const v of r.record.applicability.fixedIn) fixesAt.set(v, [...(fixesAt.get(v) ?? []), r.id]);
  // The rail (revamp S3): only versions that carry something — computed changes or an advisory fix —
  // so every stop is worth reading; the full list stays on the registry.
  const BREAKING = new Set(["breaks-on-upgrade", "already-broken", "breaks-on-date"]);
  const meta = new Map(releases.map((v) => [v.version, v]));
  const stops = [...new Set([...byTarget.keys(), ...fixesAt.keys()])]
    .filter((v) => v !== "other")
    .sort(compareVersions)
    .slice(-14)
    .map((version) => {
      const m = meta.get(version);
      const list = byTarget.get(version) ?? [];
      return {
        version,
        latest: m?.isDefault ?? false,
        month: m?.publishedAt?.slice(0, 7),
        changes: list.length,
        breaking: list.filter((r) => BREAKING.has(r.class ?? "")).length,
        fixes: fixesAt.get(version) ?? [],
      };
    });
  const anchor = (v: string) => `target-${v.replace(/[^\w.-]/g, "-")}`;

  return (
    <>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Mark brand={eco} size="lg" />
          <h1 className="heading font-mono text-3xl break-all text-ink">{name}</h1>
          <span className="rounded-full bg-sunken px-2.5 py-0.5 text-xs text-ink-2">{eco.label}</span>
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-xs text-ink-2">
          {latest ? (
            <span>
              latest <span className="text-ink">{latest.version}</span>
              {latest.publishedAt ? (
                <span className="text-ink-3"> · {latest.publishedAt.slice(0, 10)}</span>
              ) : null}
            </span>
          ) : null}
          {latest?.deprecated !== null && latest?.deprecated !== undefined ? (
            <span className="rounded-full bg-attention-soft px-2 py-0.5 text-attention">deprecated</span>
          ) : null}
          {registry ? (
            <a href={registry} className="flex items-center gap-1 text-link hover:underline">
              {new URL(registry).host}
              {releases.length ? ` · all ${releases.length} versions` : ""}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </p>
      </header>

      <YourPackageUse
        pkg={`${ecosystem}/${name}`}
        versions={releases.slice(-USE_VERSIONS).map((v) => v.version)}
        latest={latest?.version ?? null}
      />

      {advisories.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
            <ShieldAlert className="size-4 text-broke" aria-hidden />
            Security advisories
            <span className="font-mono text-xs text-ink-3">{advisories.length}</span>
          </h2>
          <ul className="flex flex-col gap-2">
            {advisories.map((r) => (
              <li key={r.id}>
                <Link
                  href={changeHref(r.id)}
                  className="group flex flex-wrap items-center gap-2 rounded-xl bg-sheet px-4 py-3 shadow-card hover:shadow-card-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink group-hover:underline">
                    {r.title}
                  </span>
                  {r.record.applicability.affectedRange ? (
                    <span className="rounded-full bg-broke-soft px-2 py-0.5 font-mono text-[11px] text-broke">
                      {r.record.applicability.affectedRange}
                    </span>
                  ) : null}
                  <span className="rounded-full bg-proven-soft px-2 py-0.5 font-mono text-[11px] text-proven">
                    {r.record.applicability.fixedIn.length
                      ? `fixed in ${r.record.applicability.fixedIn.join(", ")}`
                      : "no fix yet"}
                  </span>
                  <ChevronRight className="size-4 text-ink-3 group-hover:text-ink" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {stops.length ? (
        <section className="flex flex-col gap-2" aria-label="Versions that change something">
          <h2 className="text-sm font-medium text-ink">Versions that change something</h2>
          <div className="-mx-4 overflow-x-auto px-4 pb-2">
            <ol className="flex min-w-max items-start gap-3 pt-3">
              {stops.map((v) => {
                const tone = v.fixes.length
                  ? "ring-broke/40"
                  : v.latest
                    ? "ring-proven/50"
                    : "ring-signal/40";
                const body = (
                  <span
                    className={cn(
                      "flex w-36 flex-col gap-1.5 rounded-xl bg-sheet p-3 ring-1",
                      tone,
                      v.changes ? "shadow-card transition-shadow hover:shadow-card-hover" : "",
                    )}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span className="truncate font-mono text-xs text-ink">{v.version}</span>
                      {v.latest ? (
                        <span className="rounded-full bg-proven-soft px-1.5 font-mono text-[11px] text-proven">
                          latest
                        </span>
                      ) : null}
                    </span>
                    <span className="font-mono text-[11px] text-ink-3">{v.month ?? " "}</span>
                    {v.changes ? (
                      <span className="flex flex-wrap gap-1 font-mono text-[11px]">
                        <span className="rounded-full bg-signal-soft px-1.5 text-signal">
                          {v.changes} change{v.changes === 1 ? "" : "s"}
                        </span>
                        {v.breaking ? (
                          <span className="rounded-full bg-attention-soft px-1.5 text-attention">
                            {v.breaking} breaking
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                    {v.fixes.length ? (
                      <span className="rounded-full bg-broke-soft px-1.5 font-mono text-[11px] text-broke">
                        fixes {v.fixes.length} advisor{v.fixes.length === 1 ? "y" : "ies"}
                      </span>
                    ) : null}
                  </span>
                );
                return (
                  <li key={v.version} className="relative flex flex-col items-center gap-2">
                    <span aria-hidden className="absolute top-[5px] -right-3 left-0 h-px bg-rule-strong" />
                    <span
                      aria-hidden
                      className={cn(
                        "relative size-2.5 rounded-full ring-4 ring-canvas",
                        v.fixes.length ? "bg-broke" : v.latest ? "bg-proven" : "bg-signal",
                      )}
                    />
                    {v.changes ? (
                      <a href={`#${anchor(v.version)}`} title="Its changes">
                        {body}
                      </a>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </section>
      ) : null}

      {computed.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-ink">What each upgrade changes in its API</h2>
          {/* One row per kind of change, its target versions as chips; each chip is that change. */}
          <ul className="flex flex-col divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
            {(() => {
              const anchored = new Set<string>();
              const byKind = new Map<string, typeof rows>();
              for (const r of computed) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
              return [...byKind].map(([kind, list]) => (
                <li key={kind} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                  <span className="flex min-w-0 items-center gap-2 sm:w-80 sm:shrink-0">
                    <span className="text-sm whitespace-nowrap text-ink">
                      {KIND_SAID[kind] ?? kind.replace(/-/g, " ")}
                    </span>
                    <ClassChip value={list[0]?.class ?? null} />
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {[...list]
                      .sort((x, y) =>
                        compareVersions(
                          x.record.applicability.toVersion ?? "",
                          y.record.applicability.toVersion ?? "",
                        ),
                      )
                      .map((r) => {
                        const target = r.record.applicability.toVersion ?? "";
                        const figure = /(\d[\d,]*)/.exec(r.title.split(": ").slice(1).join(": "))?.[1];
                        const id = target && !anchored.has(target) ? anchor(target) : undefined;
                        if (id) anchored.add(target);
                        return (
                          <Link
                            key={r.id}
                            id={id}
                            href={changeHref(r.id)}
                            title={r.title}
                            className="flex scroll-mt-24 items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 font-mono text-[11px] text-ink-2 ring-1 ring-rule ring-inset hover:text-ink hover:ring-rule-strong"
                          >
                            → {target || "?"}
                            {figure ? <span className="text-ink-3">· {figure}</span> : null}
                          </Link>
                        );
                      })}
                  </span>
                </li>
              ));
            })()}
          </ul>
        </section>
      ) : null}

      {notes.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
            <QuoteIcon className="size-4 text-ink-3" aria-hidden />
            From the release notes
          </h2>
          <ul className="flex flex-col gap-2">
            {notes.map((n) => (
              <li
                key={`${n.changeId}-${n.url}`}
                className="flex flex-col gap-1.5 rounded-xl bg-sheet px-4 py-3 shadow-card"
              >
                <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-3">
                  {n.version ? <span className="text-ink">{n.version}</span> : null}
                  <a
                    href={n.url}
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-link hover:underline"
                  >
                    {n.host}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                  <span>checked {n.checkedAt.slice(0, 10)}</span>
                  <Link href={changeHref(n.changeId)} className="ml-auto text-ink-2 hover:text-ink">
                    The change ›
                  </Link>
                </span>
                <blockquote className="max-h-40 overflow-auto border-l-2 border-signal/60 pl-3 text-sm break-words whitespace-pre-wrap text-ink-2">
                  {n.quote.length > 900 ? `${n.quote.slice(0, 900)}…` : n.quote}
                </blockquote>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!advisories.length && !computed.length ? (
        <p className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 text-sm text-ink-2 shadow-card">
          <TileSquare tile={{ entity: "update", state: "pending", label: "" }} size="sm" />
          No advisories, and no upgrade a scanned repository could make has been diffed yet.
        </p>
      ) : null}
    </>
  );
}
