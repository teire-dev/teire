import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { YourPackageReach } from "@/components/catalog/your-reach";
import { Badge } from "@/components/ui/badge";
import { ECOSYSTEMS } from "@/lib/brands";
import { listChanges } from "@/lib/catalog";
import { packageVersions } from "@/lib/entities";
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

/** A package (C2, C10): its versions as the registry lists them, and every change Teire computed for it. */
export default function PackagePage({ params }: { params: Params }) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-12">
      <Link href="/changes" className="text-sm text-muted-foreground hover:text-foreground">
        ← All changes
      </Link>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />}>
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

  return (
    <>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <BrandLogo light={eco.light} dark={eco.dark} alt="" className="h-7" />
          <h1 className="font-mono text-2xl font-semibold tracking-tight break-all">{name}</h1>
          <Badge variant="outline">{eco.label}</Badge>
        </div>
        <p className="text-subtle">
          Teire diffs the public API between versions with {eco.reads}, locates each change in the code of the
          repositories it scans, and reads the release notes for what the diff cannot show.
        </p>
        {registry ? (
          <a href={registry} className="flex w-fit items-center gap-1 text-sm text-link hover:underline">
            {new URL(registry).host} <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : null}
      </header>

      <YourPackageReach pkg={`${ecosystem}/${name}`} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">
          Security advisories <span className="text-muted-foreground">({advisories.length})</span>
        </h2>
        {advisories.length ? (
          <ul className="divide-y overflow-hidden rounded-lg bg-card shadow-card">
            {advisories.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/changes/${r.id}`}
                  className="row-link flex flex-col gap-1 px-4 py-3 pr-10 hover:bg-accent"
                >
                  <span className="text-sm">{r.title}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {r.record.applicability.affectedRange
                      ? `affects ${r.record.applicability.affectedRange}`
                      : null}
                    {r.record.applicability.fixedIn.length
                      ? ` · fixed in ${r.record.applicability.fixedIn.join(", ")}`
                      : " · no fixed version yet"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            None in Teire's catalog for the versions it has read; advisories are read when a scanned
            repository uses this package.
          </p>
        )}
      </section>

      {notes.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">From the release notes</h2>
          <ul className="flex flex-col gap-2">
            {notes.map((n) => (
              <li
                key={`${n.changeId}-${n.url}`}
                className="flex flex-col gap-1.5 rounded-lg bg-card p-4 shadow-card"
              >
                <blockquote className="border-l-2 pl-3 text-sm break-words text-subtle">
                  “{n.quote.length > 320 ? `${n.quote.slice(0, 320)}…` : n.quote}”
                </blockquote>
                <span className="text-xs text-muted-foreground">
                  {n.version ? <span className="font-mono">{n.version} · </span> : null}
                  {n.host} · checked {n.checkedAt.slice(0, 10)} ·{" "}
                  <Link href={`/changes/${n.changeId}`} className="entity-link">
                    the change
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">
          Changes Teire computed <span className="text-muted-foreground">({rows.length})</span>
        </h2>
        {rows.length ? (
          [...byTarget].map(([target, list]) => (
            <div key={target} className="flex flex-col gap-2">
              <p className="font-mono text-xs text-muted-foreground">→ {target}</p>
              <ul className="divide-y overflow-hidden rounded-lg bg-card shadow-card">
                {list.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/changes/${r.id}`}
                      className="row-link flex flex-col gap-1 px-4 py-3 pr-10 hover:bg-accent sm:flex-row sm:items-center sm:justify-between"
                    >
                      <span className="text-sm">{r.title}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <ClassChip value={r.class} />
                        <span className="font-mono text-xs text-muted-foreground">
                          {r.kind.replace(/-/g, " ")}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No change computed yet: Teire diffs a version only when a scanned repository could upgrade to it.
          </p>
        )}
      </section>

      {listed.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Versions</h2>
          <table className="w-full overflow-hidden rounded-lg bg-card font-mono text-xs shadow-card">
            <thead className="bg-muted/60 text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-normal">version</th>
                <th className="px-4 py-2 text-left font-normal">published</th>
                <th className="px-4 py-2 text-left font-normal">flags</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((v) => (
                <tr key={v.version} className="border-t">
                  <td className="px-4 py-2">{v.version}</td>
                  <td className="px-4 py-2 text-muted-foreground">{v.publishedAt?.slice(0, 10) ?? "—"}</td>
                  <td className="px-4 py-2">
                    {v.isDefault ? <span className="text-clear">latest </span> : null}
                    {v.deprecated !== null ? (
                      <span className="text-human" title={v.deprecated || undefined}>
                        deprecated
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {versions ? (
            <p className="text-xs text-muted-foreground">
              From {versions.info.source.name}, read {versions.fetchedAt?.slice(0, 10)}. Newest 30 shown.
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
