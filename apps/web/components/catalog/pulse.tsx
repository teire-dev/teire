import Link from "next/link";
import { ClassChip } from "@/app/(site)/changes/class-chip";
import { BrandLogo } from "@/components/brand-logo";
import { ecosystemOfSite } from "@/lib/brands";
import { type CatalogRow, sourceLabel, sourceLogo, sourceOf } from "@/lib/catalog";
import { packageHref, providerHref } from "@/lib/links";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * The catalog's pulse (plan revision 3.4, V5; the owner: "let you know our stuff is working, it checks
 * periodically, these are the latest changes"): every source Teire watches with when it last checked,
 * what is new, and a 30-day lane per source of the days it picked something up. Rendered per request
 * from cached rows, so "3 h ago" is always now.
 */
const DAY = 86_400_000;
const LANE_DAYS = 30;

export interface Watched {
  key: string;
  label: string;
  logo: { light: string; dark: string };
  checked: string | null;
  /** ok, or the reason a dot is amber or red; "demand" for registries Teire reads only when a scan needs them. */
  status: "ok" | "stale" | "failing" | "demand";
  /** What Teire reads there: deprecation pages, changelogs, the registry. */
  what: string;
  changes: number;
}

/** Sources from the provider pages Teire checks and from the catalog's own package ecosystems. */
export function watchedOf(
  rows: CatalogRow[],
  pages: { slug: string; kinds: string[]; failing: number; stale: number; checked: string | null }[],
  names: Record<string, string>,
): Watched[] {
  const count = new Map<string, number>();
  const lastRead = new Map<string, string>();
  for (const r of rows) {
    const k = sourceOf(r);
    count.set(k, (count.get(k) ?? 0) + 1);
    for (const s of r.record.sources)
      if (s.checkedAt && (lastRead.get(k) ?? "") < s.checkedAt) lastRead.set(k, s.checkedAt);
  }
  // A registry's own website (rubygems.org's deprecations page) is the same source as its ecosystem:
  // one tile, not "Rubygems · 0" beside "RubyGems · 23" (V7 final review).
  const keyOf = (slug: string) => {
    const eco = ecosystemOfSite(slug);
    return eco ? `pkg:${eco}` : slug;
  };
  const fromPages: Watched[] = pages.map((p) => {
    const key = keyOf(p.slug);
    const folded = key !== p.slug;
    return {
      key,
      label: sourceLabel(key, names).replace(/ packages$/, ""),
      logo: sourceLogo(key),
      checked: p.checked,
      status: p.failing ? "failing" : p.stale ? "stale" : "ok",
      what: folded ? `registry · release notes · ${p.kinds.join(" · ")}` : p.kinds.join(" · "),
      changes: (count.get(key) ?? 0) + (folded ? (count.get(p.slug) ?? 0) : 0),
    };
  });
  const fromCatalog: Watched[] = [...count.keys()]
    .filter((k) => !pages.some((p) => p.slug === k || keyOf(p.slug) === k) && k !== "other")
    .map((k) => ({
      key: k,
      label: sourceLabel(k, names).replace(/ packages$/, ""),
      logo: sourceLogo(k),
      // Registries have no scheduled check to report on: they are read when a scan needs them (V7 review).
      checked: lastRead.get(k) ?? null,
      status: "demand" as const,
      what: k.startsWith("pkg:")
        ? "registry · release notes"
        : k === "runtime"
          ? "end-of-life dates"
          : "pages",
      changes: count.get(k) ?? 0,
    }));
  return [...fromPages, ...fromCatalog].sort((a, b) => (b.checked ?? "").localeCompare(a.checked ?? ""));
}

/** The navy band: what Teire watches, each source's last check, and the catalog in three figures. */
export function WatchBand({
  watched,
  total,
  week,
  checkedToday,
  ahead,
}: {
  watched: Watched[];
  total: number;
  week: number;
  /** Watched sources whose pages Teire checked in the last day (their own last-check time): the figure when everything is new. */
  checkedToday: number;
  ahead: number;
}) {
  const latest = watched.find((w) => w.checked && w.status !== "demand")?.checked ?? null;
  return (
    <section className="relative overflow-hidden rounded-feature bg-hero p-6 text-hero-ink sm:p-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_60%_at_85%_0%,var(--hero-2),transparent)] opacity-80"
      />
      <div className="relative flex flex-col gap-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-3">
            <span className="flex w-fit items-center gap-2 rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] text-hero-ink-2">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-hero-proven opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex size-2 rounded-full bg-hero-proven" />
              </span>
              Watching {watched.length} sources{latest ? ` · checked ${ago(latest)}` : ""}
            </span>
            <h1 className="display text-5xl">Changes</h1>
          </div>
          <dl className="flex gap-6">
            {[
              ["in the catalog", total],
              // A catalog built this week makes "new this week" the total; then the day's source checks say more.
              week < total ? ["new this week", week] : ["sources checked today", checkedToday],
              ["dated ahead", ahead],
            ].map(([k, v]) => (
              <div key={k as string} className="flex flex-col">
                <dd className="font-mono text-3xl leading-none tabular-nums">{v}</dd>
                <dt className="mt-1 font-mono text-[11px] text-hero-ink-2">{k}</dt>
              </div>
            ))}
          </dl>
        </div>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {watched.slice(0, 15).map((w, i) => (
            <li key={w.key}>
              <Link
                href={`/changes?source=${encodeURIComponent(w.key)}#browse`}
                className="flex items-center gap-2.5 rounded-xl bg-white/[0.06] p-2.5 ring-1 ring-white/10 transition-colors hover:bg-white/[0.11]"
                title={`${w.label}: ${w.what}${w.status === "demand" ? ", read when a scan needs it" : w.checked ? `, checked ${ago(w.checked)}` : ""}`}
              >
                <span className="relative flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white">
                  <BrandLogo light={w.logo.light} dark={w.logo.light} alt="" className="h-5 max-w-7 w-auto" />
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -right-1 -bottom-1 size-3 rounded-full ring-2 ring-hero",
                      w.status === "failing"
                        ? "bg-broke"
                        : w.status === "stale"
                          ? "bg-attention"
                          : w.status === "demand"
                            ? "bg-hero-ink-2"
                            : "bg-hero-proven",
                      i === 0 && w.status === "ok" && "animate-live",
                    )}
                  />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium">{w.label}</span>
                  <span className="truncate font-mono text-[11px] text-hero-ink-2">
                    {w.status === "demand" ? "on demand" : w.checked ? ago(w.checked) : "not yet"} ·{" "}
                    {w.changes}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The newest changes Teire picked up, as a row of cards you scroll sideways. */
export function WhatsNew({ rows, names }: { rows: CatalogRow[]; names: Record<string, string> }) {
  // The newest change per provider or package, so a big release is one card, not a row of its own;
  // the card counts the rest and links to the page that lists them (V7 final review).
  const groups = new Map<string, CatalogRow[]>();
  for (const r of [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    // A provider is one card however many of its models changed; a package is one card per package.
    const who = r.provider ? sourceOf(r) : `${sourceOf(r)}:${r.record.subject.name}`;
    groups.set(who, [...(groups.get(who) ?? []), r]);
  }
  const latest = [...groups.values()].slice(0, 12);
  if (!latest.length) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="What's new">
      <h2 className="heading text-xl text-ink">What&apos;s new</h2>
      <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none]">
        {latest.map(([r, ...rest]) => {
          if (!r) return null;
          const key = sourceOf(r);
          const logo = sourceLogo(key);
          const eco = r.record.subject.ecosystem;
          const more = rest.length
            ? r.provider
              ? providerHref(r.provider)
              : eco
                ? packageHref(eco, r.record.subject.name)
                : null
            : null;
          return (
            <li key={r.id} className="relative w-64 shrink-0 snap-start">
              <Link
                href={`/changes/${r.id}`}
                className="flex h-full flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card transition-shadow hover:shadow-card-hover"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-[11px] text-ink-3">
                    <BrandLogo light={logo.light} dark={logo.dark} alt="" className="h-4 max-w-6 w-auto" />
                    <span className="truncate">{sourceLabel(key, names)}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-3">{ago(r.createdAt)}</span>
                </span>
                <span className="line-clamp-2 text-sm font-medium text-ink">{r.title}</span>
                <span className="mt-auto">
                  <ClassChip value={r.class} />
                </span>
              </Link>
              {more ? (
                <Link
                  href={more}
                  title={`${rest.length} more ${rest.length === 1 ? "change" : "changes"}`}
                  className="absolute right-3 bottom-3 rounded-full bg-sunken px-2 py-0.5 font-mono text-[11px] text-ink-2 ring-1 ring-rule hover:text-ink"
                >
                  +{rest.length}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * One lane per source over the last 30 days: a dot on each day Teire picked something up, bigger for
 * more. The lanes are the checking made visible: steady sources, quiet ones, a burst after a release.
 */
export function ActivityLanes({ rows, watched }: { rows: CatalogRow[]; watched: Watched[] }) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = today.getTime() - (LANE_DAYS - 1) * DAY;
  // Each day by its date, so a cell is keyed by the day it stands for.
  const days = Array.from({ length: LANE_DAYS }, (_, i) =>
    new Date(start + i * DAY).toISOString().slice(0, 10),
  );
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const day = r.createdAt.slice(0, 10);
    if (day < (days[0] as string)) continue;
    const k = sourceOf(r);
    const lane = counts.get(k) ?? new Map<string, number>();
    lane.set(day, (lane.get(day) ?? 0) + 1);
    counts.set(k, lane);
  }
  const sum = (k: string) => [...(counts.get(k)?.values() ?? [])].reduce((n, v) => n + v, 0);
  const lanes = watched
    .filter((w) => counts.has(w.key))
    .sort((a, b) => sum(b.key) - sum(a.key))
    .slice(0, 10);
  if (!lanes.length) return null;
  const size = (n: number) => (n >= 20 ? 14 : n >= 8 ? 11 : n >= 3 ? 8 : n ? 6 : 2);
  return (
    <section className="flex flex-col gap-3" aria-label="Picked up, last 30 days">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="heading text-xl text-ink">Picked up, last 30 days</h2>
        <span className="font-mono text-[11px] text-ink-3">one dot per day · bigger is more</span>
      </div>
      <div className="overflow-x-auto rounded-xl bg-sheet p-4 shadow-card">
        <ul className="flex flex-col gap-1 sm:min-w-[540px]">
          {lanes.map((w) => {
            const lane = counts.get(w.key) ?? new Map<string, number>();
            const total = sum(w.key);
            return (
              <li key={w.key}>
                <Link
                  href={`/changes?source=${encodeURIComponent(w.key)}#browse`}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-1.5 hover:bg-hover sm:grid-cols-[9rem_1fr_2.5rem]"
                >
                  <span className="flex min-w-0 items-center gap-2 text-xs text-ink-2">
                    <BrandLogo
                      light={w.logo.light}
                      dark={w.logo.dark}
                      alt=""
                      className="h-4 max-w-6 w-auto"
                    />
                    <span className="truncate">{w.label}</span>
                  </span>
                  <span
                    className="order-last col-span-2 grid items-center sm:order-none sm:col-span-1"
                    style={{ gridTemplateColumns: `repeat(${LANE_DAYS}, minmax(0, 1fr))` }}
                    aria-hidden
                  >
                    {days.map((d) => {
                      const n = lane.get(d) ?? 0;
                      return (
                        <span key={d} className="flex h-4 items-center justify-center">
                          <span
                            className={cn("rounded-full", n ? "bg-signal" : "bg-rule-strong")}
                            style={{
                              width: size(n),
                              height: size(n),
                              opacity: n ? 0.55 + Math.min(n, 20) / 45 : 1,
                            }}
                            title={n ? `${n} on ${d}` : undefined}
                          />
                        </span>
                      );
                    })}
                  </span>
                  <span className="text-right font-mono text-[11px] text-ink-3">{total}</span>
                  {/* The dots' figures in words, for screen readers (the dots carry them as titles). */}
                  <span className="sr-only">
                    {`: ${days
                      .filter((d) => lane.get(d))
                      .map((d) => `${lane.get(d)} on ${d}`)
                      .join(", ")}`}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-2 grid grid-cols-1 gap-3 px-2 font-mono text-[11px] text-ink-3 sm:min-w-[540px] sm:grid-cols-[9rem_1fr_2.5rem]">
          <span className="hidden sm:block" />
          <span className="flex justify-between">
            <span>{(days[0] ?? "").slice(5)}</span>
            <span>today</span>
          </span>
          <span />
        </div>
      </div>
    </section>
  );
}
