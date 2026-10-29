import { ChevronDown, ExternalLink, Quote as QuoteIcon, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { YourPackageReach } from "@/components/catalog/your-reach";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { TileSquare } from "@/components/flow/tile";
import { Mark } from "@/components/teire/mark";
import { ECOSYSTEMS } from "@/lib/brands";
import { listChanges } from "@/lib/catalog";
import { packageVersions } from "@/lib/entities";
import { cn } from "@/lib/utils";
import { ClassChip } from "../../../changes/class-chip";

type Params = PageProps<"/packages/[ecosystem]/[...name]">["params"];

const decode = (parts: string[]) => parts.map(decodeURIComponent).join("/");

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

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { ecosystem, name } = await params;
  return { title: `${decode(name)} (${ECOSYSTEMS[ecosystem]?.label ?? ecosystem})` };
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
  const [versions, all] = await Promise.all([packageVersions(ecosystem, name), listChanges()]);
  const rows = all.filter((r) => r.record.subject.ecosystem === ecosystem && r.record.subject.name === name);
  if (!versions && !rows.length) notFound();
  const registry = registryUrl(ecosystem, name);
  const listed = [...(versions?.info.versions ?? [])].reverse().slice(0, 30);
  // Advisories, and what the release notes, changelogs and migration guides said, in their words (U5).
  const advisories = rows.filter((r) => r.kind === "security-advisory");
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
  for (const r of rows) {
    const t = r.record.applicability.toVersion ?? r.record.applicability.fixedIn?.[0] ?? "other";
    byTarget.set(t, [...(byTarget.get(t) ?? []), r]);
  }

  // The rail (plan revision 3.4, V5): version tiles oldest to newest — the registry's last 16 when it
  // is cached, and always every target with changes and every version an advisory is fixed in, so
  // the rail stands on Teire's own data when the registry list is missing (V5–V6 review).
  const BREAKING = new Set(["breaks-on-upgrade", "already-broken", "breaks-on-date"]);
  // Releases only: a canary, beta or rc stays off the rail unless Teire computed changes for it.
  // npm/Cargo/Go "-beta.1", Maven "-SNAPSHOT"/"-M2"/"-RC1", PyPI "2.0.0a1"/"rc1"/".dev3", RubyGems ".pre".
  const PRE =
    /[-.](alpha|beta|canary|rc|next|dev|pre|preview|insiders|experimental|snapshot|nightly|m\d+|cr\d*)|\d(a|b|rc)\d+$|\.dev\d*$/i;
  const registryRail = [...(versions?.info.versions ?? [])]
    .filter((v) => !PRE.test(v.version) || byTarget.has(v.version))
    .slice(-16);
  const meta = new Map(registryRail.map((v) => [v.version, v]));
  const fixesAt = new Map<string, string[]>();
  for (const r of advisories)
    for (const v of r.record.applicability.fixedIn) fixesAt.set(v, [...(fixesAt.get(v) ?? []), r.id]);
  const stops = [...new Set([...registryRail.map((v) => v.version), ...byTarget.keys(), ...fixesAt.keys()])]
    .filter((v) => v !== "other")
    .sort(compareVersions)
    .slice(-18)
    .map((version) => {
      const m = meta.get(version);
      const list = byTarget.get(version) ?? [];
      return {
        version,
        latest: m?.isDefault ?? false,
        deprecated: m ? m.deprecated !== null : false,
        month: m?.publishedAt?.slice(0, 7),
        changes: list.length,
        breaking: list.filter((r) => BREAKING.has(r.class ?? "")).length,
        fixes: fixesAt.get(version) ?? [],
      };
    });
  const rail = registryRail;
  const anchor = (v: string) => `target-${v.replace(/[^\w.-]/g, "-")}`;

  return (
    <>
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Mark brand={eco} size="lg" />
          <h1 className="heading font-mono text-3xl break-all text-ink">{name}</h1>
          <span className="rounded-full bg-sunken px-2.5 py-0.5 text-xs text-ink-2">{eco.label}</span>
          {registry ? (
            <a href={registry} className="flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
              {new URL(registry).host} <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </div>
        <p className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-ink-3">
          <span>read with</span>
          <span className="rounded-full bg-sunken px-2 py-0.5 text-ink-2">{eco.reads}</span>
          <span>· your code located per change · release notes for what a diff can't show</span>
        </p>
      </header>

      <YourPackageReach pkg={`${ecosystem}/${name}`} brand={eco} />

      {stops.length ? (
        <section className="flex flex-col gap-2" aria-label="Versions">
          <div className="-mx-4 overflow-x-auto px-4 pb-2">
            <ol className="flex min-w-max items-start gap-3 pt-3">
              {stops.map((v) => {
                const tone = v.fixes.length
                  ? "ring-broke/40"
                  : v.latest
                    ? "ring-proven/50"
                    : v.changes
                      ? "ring-signal/40"
                      : "ring-rule";
                const body = (
                  <span
                    className={cn(
                      "flex w-36 flex-col gap-1.5 rounded-xl bg-sheet p-3 shadow-card ring-1 transition-shadow",
                      tone,
                      v.changes && "hover:shadow-card-hover",
                    )}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span className="truncate font-mono text-xs text-ink">{v.version}</span>
                      {v.latest ? (
                        <span className="rounded-full bg-proven-soft px-1.5 font-mono text-[11px] text-proven">
                          latest
                        </span>
                      ) : v.deprecated ? (
                        <span className="rounded-full bg-attention-soft px-1.5 font-mono text-[11px] text-attention">
                          deprecated
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
                        v.fixes.length
                          ? "bg-broke"
                          : v.latest
                            ? "bg-proven"
                            : v.changes
                              ? "bg-signal"
                              : "bg-rule-strong",
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
          <p className="font-mono text-[11px] text-ink-3">
            {versions
              ? `${versions.info.source.name} · read ${versions.fetchedAt?.slice(0, 10)}`
              : "from Teire's own changes; the registry's list isn't cached yet"}
          </p>
        </section>
      ) : null}

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
                  href={`/changes/${r.id}`}
                  className="flex flex-wrap items-center gap-2 rounded-xl bg-sheet px-4 py-3 shadow-card hover:shadow-card-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{r.title}</span>
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
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-ink">
          Changes Teire computed <span className="font-mono text-xs text-ink-3">{rows.length}</span>
        </h2>
        {rows.length ? (
          [...byTarget].map(([target, list]) => (
            <div key={target} id={anchor(target)} className="flex scroll-mt-24 flex-col gap-2">
              <p className="font-mono text-xs text-ink-3">→ {target}</p>
              <ul className="flex flex-col divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
                {list.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/changes/${r.id}`}
                      className="flex flex-col gap-1 px-4 py-2.5 hover:bg-hover sm:flex-row sm:items-center sm:justify-between"
                    >
                      <span className="text-sm text-ink">{r.title}</span>
                      <ClassChip value={r.class} />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
            <TileSquare tile={{ entity: "update", state: "pending", label: "" }} size="sm" />
            <span className="text-sm text-ink-2">Diffed when a scanned repository could upgrade</span>
          </div>
        )}
      </section>

      {notes.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
            <QuoteIcon className="size-4 text-ink-3" aria-hidden />
            From the release notes
          </h2>
          <ul className="flex flex-col gap-2">
            {notes.map((n) => (
              <li key={`${n.changeId}-${n.url}`}>
                {/* Two lines of the notes' own words; More opens the rest (plan revision 3.4, V5). */}
                <details className="group/note rounded-xl bg-sheet shadow-card">
                  <summary className="flex cursor-pointer list-none flex-col gap-1.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
                    <span className="flex items-center gap-2 text-xs text-ink-2">
                      {n.version ? <span className="font-mono text-ink">{n.version}</span> : null}
                      <span>{n.host}</span>
                      <span className="font-mono text-ink-3">{n.checkedAt.slice(0, 10)}</span>
                    </span>
                    <blockquote className="line-clamp-2 border-l-2 border-rule-strong pl-3 text-sm break-words text-ink-2 group-open/note:line-clamp-none">
                      “{n.quote.length > 480 ? `${n.quote.slice(0, 480)}…` : n.quote}”
                    </blockquote>
                    <span className="flex items-center gap-1 text-[11px] text-ink-3 group-open/note:hidden">
                      More <ChevronDown aria-hidden className="size-3" />
                    </span>
                  </summary>
                  <Link
                    href={`/changes/${n.changeId}`}
                    className="mx-4 mb-3 block w-fit text-xs text-ink-3 hover:text-ink"
                  >
                    The change ›
                  </Link>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {listed.length > rail.length ? (
        <details className="group/all rounded-xl bg-sheet shadow-card">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
            All versions <span className="font-mono text-xs text-ink-3">{listed.length}</span>
            <ChevronDown
              aria-hidden
              className="ml-auto size-3.5 transition-transform group-open/all:rotate-180"
            />
          </summary>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-rule px-4 py-3 font-mono text-xs sm:grid-cols-3">
            {listed.map((v) => (
              <li key={v.version} className="flex justify-between gap-2">
                <span className="text-ink">{v.version}</span>
                <span className="text-ink-3">{v.publishedAt?.slice(0, 10) ?? "—"}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
