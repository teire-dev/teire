import { and, asc, changes, desc, eq, sql } from "@teire/db";
import type { ChangeV2 } from "@teire/engine/contract";
import { cacheLife, cacheTag } from "next/cache";
import { database } from "./db";

/**
 * The public catalog (plan feature 7): every confirmed public change, read through Cache Components
 * and refreshed when the worker writes (`catalog` tag via /api/revalidate).
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

export const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  "google-gemini": "Google Gemini",
  "nebius-token-factory": "Nebius Token Factory",
  stripe: "Stripe",
};

export async function listChanges(provider: string | null): Promise<CatalogRow[]> {
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
      and(
        eq(changes.schemaVersion, 2),
        eq(changes.status, "confirmed"),
        eq(changes.visibility, "public"),
        provider ? eq(changes.providerSlug, provider) : sql`${changes.providerSlug} is not null`,
      ),
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
