import { and, asc, changes, desc, eq, sql } from "@teire/db";
import type { ChangeV2 } from "@teire/engine/contract";
import { cacheLife, cacheTag } from "next/cache";
import { database } from "./db";

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
  record: ChangeV2;
}

/** Display names for providers Teire can read; a source appears only once a repo uses it. */
export const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  "google-gemini": "Google Gemini",
  "nebius-token-factory": "Nebius Token Factory",
  stripe: "Stripe",
};

/** Where a change belongs in the filters: its provider, or the package registry it came from. */
export function sourceOf(row: Pick<CatalogRow, "provider" | "record">) {
  return row.provider ?? (row.record.subject.ecosystem ? `pkg:${row.record.subject.ecosystem}` : "other");
}

export function sourceLabel(key: string) {
  if (key.startsWith("pkg:"))
    return { npm: "npm packages", pypi: "PyPI packages" }[key.slice(4)] ?? `${key.slice(4)} packages`;
  return PROVIDER_NAMES[key] ?? key;
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
    record: r.record as ChangeV2,
  }));
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
