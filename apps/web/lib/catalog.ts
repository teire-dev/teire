import { and, asc, changes, desc, eq, providers, sql } from "@teire/db";
import type { ChangeV2 } from "@teire/engine/contract";
import { cacheLife, cacheTag } from "next/cache";
import { ECOSYSTEMS } from "./brands";
import { database } from "./db";
import { providerLogo } from "./logos";

/**
 * Public changes (plan feature 7): every confirmed public change Teire has read, which is only ever
 * a change to something a watched repository depends on (D82: package diffs and provider pages are
 * read on demand during scans). Cache Components, refreshed when the worker writes (`catalog` tag).
 */
export interface CatalogRow {
  id: string;
  provider: string | null;
  kind: string;
  class: string | null;
  title: string;
  deadline: string | null;
  /** When Teire first read it (ISO): "new this week" and the activity lanes count from this. */
  createdAt: string;
  record: ChangeV2;
}

/** A provider a repository named in its own teire.yml: private to that repository (D53). */
const declaredByRepo = sql`coalesce(${providers.record} -> 'discovery' -> 'via' @> '["teire.yml"]'::jsonb, false)`;

/**
 * Provider names as stored with each provider's record: curated readers and providers discovered from
 * a scanned repo alike, never one a repo declared (D53). A provider appears only once a repo uses it
 * (D82).
 */
export async function providerNames(): Promise<Record<string, string>> {
  "use cache";
  cacheTag("catalog");
  cacheLife("hours");
  const rows = await database()
    .select({ slug: providers.slug, name: providers.name })
    .from(providers)
    .where(sql`not ${declaredByRepo}`);
  return Object.fromEntries(rows.map((r) => [r.slug, r.name]));
}

/**
 * Public provider records (cards C10, C11): curated readers and providers discovered from scanned
 * repos, never a source a repo named in its own teire.yml (D53). The CLI matches a local scan's API
 * hosts against them, so it finds the providers the service already reads.
 */
export async function publicProviders(): Promise<{ slug: string; record: Record<string, unknown> }[]> {
  "use cache";
  cacheTag("catalog");
  cacheLife("hours");
  const rows = await database().select({ slug: providers.slug, record: providers.record }).from(providers);
  return rows
    .map((r) => ({
      slug: r.slug,
      record: r.record as Record<string, unknown> & { discovery?: { via?: string[] } },
    }))
    .filter((r) => !r.record.discovery?.via?.includes("teire.yml"));
}

/** Where a change belongs in the filters: its provider, the package registry, or the runtimes. */
export function sourceOf(row: Pick<CatalogRow, "provider" | "record">) {
  if (row.provider) return row.provider;
  if (row.record.subject.ecosystem) return `pkg:${row.record.subject.ecosystem}`;
  return row.record.subject.kind === "runtime" ? "runtime" : "other";
}

export function sourceLabel(key: string, names: Record<string, string>) {
  if (key.startsWith("pkg:")) return `${ECOSYSTEMS[key.slice(4)]?.label ?? key.slice(4)} packages`;
  if (key === "runtime") return "Runtimes";
  return names[key] ?? readableSlug(key);
}

/**
 * A provider Teire discovered in someone's code has a slug, not yet a name: `perplexity-ai` reads
 * "Perplexity", `github-com` "GitHub". Curated providers keep their own names.
 */
export function readableSlug(slug: string) {
  const curated = providerLogo(slug).name;
  if (curated !== slug) return curated;
  const words = slug
    .split("-")
    .filter((w, i, all) => !(i === all.length - 1 && /^(com|ai|io|tv|dev|net|org|co|app)$/.test(w)));
  const KNOWN: Record<string, string> = { github: "GitHub", openai: "OpenAI", openrouter: "OpenRouter" };
  return words.map((w) => KNOWN[w] ?? `${w[0]?.toUpperCase() ?? ""}${w.slice(1)}`).join(" ");
}

/** The logo for a source: the provider's own mark, the package ecosystem's, or a generic glyph. */
export function sourceLogo(key: string) {
  if (key.startsWith("pkg:")) {
    const e = ECOSYSTEMS[key.slice(4)];
    return e
      ? { light: e.light, dark: e.dark }
      : { light: "/logos/provider-light.svg", dark: "/logos/provider-dark.svg" };
  }
  if (key === "runtime") return { light: "/logos/runtime-light.svg", dark: "/logos/runtime-dark.svg" };
  return providerLogo(key);
}

export async function listChanges(): Promise<CatalogRow[]> {
  "use cache";
  cacheTag("catalog");
  cacheLife("hours");
  const rows = await database()
    .select({
      id: changes.id,
      provider: changes.providerSlug,
      kind: changes.kind,
      class: changes.class,
      title: changes.title,
      deadline: changes.deadline,
      createdAt: changes.createdAt,
      record: changes.record,
    })
    .from(changes)
    .where(
      and(eq(changes.schemaVersion, 2), eq(changes.status, "confirmed"), eq(changes.visibility, "public")),
    )
    // Upcoming shutdowns first (soonest first), then the rest newest first.
    .orderBy(
      sql`case when ${changes.deadline} >= now() then 0 else 1 end`,
      sql`case when ${changes.deadline} >= now() then ${changes.deadline} end asc`,
      desc(changes.deadline),
      asc(changes.id),
    );
  return rows.map((r) => ({
    ...r,
    deadline: r.deadline?.toISOString().slice(0, 10) ?? null,
    createdAt: r.createdAt.toISOString(),
    record: r.record as ChangeV2,
  }));
}

/**
 * The upstream pages Teire checks for each provider (changelogs, deprecation pages, feeds), with when
 * each was last checked and whether it answered: the catalog's "watching" band. A page a repository
 * named in its teire.yml isn't listed (D53). Cached for minutes,
 * since its point is that the checking is live.
 */
export async function watchedSources() {
  "use cache";
  cacheTag("catalog");
  cacheLife("minutes");
  const { rows } = await database().execute<{
    slug: string;
    kinds: string[];
    pages: number;
    failing: number;
    stale: number;
    checked: string | null;
  }>(sql`
    select provider_slug as slug, array_agg(distinct kind) as kinds, count(*)::int as pages,
      count(*) filter (where status = 'failing')::int as failing,
      count(*) filter (where status = 'stale')::int as stale,
      to_char(max(last_checked_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as checked
    from provider_sources
    where provider_slug not in (select ${providers.slug} from ${providers} where ${declaredByRepo})
    group by provider_slug order by max(last_checked_at) desc nulls last`);
  return rows;
}

export async function getChange(id: string): Promise<ChangeV2 | null> {
  "use cache";
  cacheTag("catalog");
  cacheLife("hours");
  const [row] = await database()
    .select({ record: changes.record, visibility: changes.visibility, status: changes.status })
    .from(changes)
    .where(eq(changes.id, id))
    .limit(1);
  return row && row.visibility === "public" ? (row.record as ChangeV2) : null;
}

/**
 * A quote for reading in a list: the same words, without markdown link targets, code ticks and
 * table pipes. The detail page shows the exact text the gate checked.
 */
export function plainQuote(quote: string) {
  return quote
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\\\|/g, "/")
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(" · ");
}
