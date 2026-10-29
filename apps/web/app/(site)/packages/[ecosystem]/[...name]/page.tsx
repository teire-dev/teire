import { ChevronDown, ExternalLink, Quote as QuoteIcon, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { YourPackageReach } from "@/components/catalog/your-reach";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { StaticFlow } from "@/components/flow/static-flow";
import { TileSquare } from "@/components/flow/tile";
import { Mark } from "@/components/teire/mark";
import { ECOSYSTEMS } from "@/lib/brands";
import { listChanges } from "@/lib/catalog";
import { packageVersions } from "@/lib/entities";
import { cn } from "@/lib/utils";
import { ClassChip } from "../../../changes/class-chip";

type Params = PageProps<"/packages/[ecosystem]/[...name]">["params"];

const decode = (parts: string[]) => parts.map(decodeURIComponent).join("/");

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

  const targets = new Set(byTarget.keys());
  // The rail: oldest left to newest right, the last 16 the registry lists.
  const rail = [...(versions?.info.versions ?? [])].slice(-16);
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
        <StaticFlow
          size="sm"
          className="max-w-2xl"
          label={`How Teire reads ${name}`}
          graph={{
            tiles: [
              { id: "diff", entity: "update", state: "done", label: "API diff", meta: eco.reads, brand: eco },
              { id: "code", entity: "code", state: "done", label: "Your code", meta: "each change located" },
              {
                id: "notes",
                entity: "change",
                state: "done",
                label: "Release notes",
                meta: "what a diff can't show",
              },
            ],
            links: [
              { from: "diff", to: "code", state: "done" },
              { from: "code", to: "notes", state: "done" },
            ],
          }}
        />
      </header>

      <YourPackageReach pkg={`${ecosystem}/${name}`} />

      {rail.length ? (
        <section className="flex flex-col gap-2" aria-label="Versions">
          <div className="relative overflow-x-auto rounded-xl bg-sheet px-5 pt-6 pb-4 shadow-card">
            <span aria-hidden className="absolute top-[30px] right-5 left-5 h-px bg-rule-strong" />
            <ol className="relative flex min-w-max justify-between gap-6">
              {rail.map((v) => {
                const changed = targets.has(v.version);
                const dot = v.isDefault
                  ? "bg-proven ring-proven"
                  : v.deprecated !== null
                    ? "bg-attention ring-attention"
                    : changed
                      ? "bg-sheet ring-signal ring-2"
                      : "bg-sheet ring-rule-strong";
                const body = (
                  <>
                    <span className={cn("size-3 rounded-full ring-1", dot)} />
                    <span className={cn("font-mono text-[11px]", changed ? "text-ink" : "text-ink-3")}>
                      {v.version}
                    </span>
                    <span className="font-mono text-[10px] text-ink-3">
                      {v.isDefault
                        ? "latest"
                        : v.deprecated !== null
                          ? "deprecated"
                          : (v.publishedAt?.slice(0, 7) ?? "")}
                    </span>
                  </>
                );
                return (
                  <li key={v.version} className="flex flex-col items-center gap-1.5">
                    {changed ? (
                      <a
                        href={`#${anchor(v.version)}`}
                        className="flex flex-col items-center gap-1.5 hover:opacity-80"
                        title="Its changes"
                      >
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
          {versions ? (
            <p className="font-mono text-[11px] text-ink-3">
              {versions.info.source.name} · read {versions.fetchedAt?.slice(0, 10)}
            </p>
          ) : null}
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
                <details className="group/note rounded-xl bg-sheet shadow-card">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-xs text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
                    {n.version ? <span className="font-mono text-ink">{n.version}</span> : null}
                    <span>{n.host}</span>
                    <span className="font-mono text-ink-3">{n.checkedAt.slice(0, 10)}</span>
                    <ChevronDown
                      aria-hidden
                      className="ml-auto size-3.5 transition-transform group-open/note:rotate-180"
                    />
                  </summary>
                  <div className="flex flex-col gap-2 border-t border-rule px-4 py-3">
                    <blockquote className="border-l-2 border-rule-strong pl-3 text-sm break-words text-ink-2">
                      “{n.quote.length > 480 ? `${n.quote.slice(0, 480)}…` : n.quote}”
                    </blockquote>
                    <Link href={`/changes/${n.changeId}`} className="w-fit text-xs text-ink-3 hover:text-ink">
                      The change ›
                    </Link>
                  </div>
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
