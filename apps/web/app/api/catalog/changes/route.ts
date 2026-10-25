import { listChanges } from "@/lib/catalog";

/**
 * The public catalog as JSON (cards C10, C11): confirmed, public change records, for the CLI
 * (`teire changes`, `teire scan`'s API checks) and the MCP server. Filters: `provider` (comma list
 * of slugs), `ecosystem`, `kind`, `subject` (package or model name).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const providers = url.searchParams.get("provider")?.split(",").filter(Boolean) ?? [];
  const ecosystem = url.searchParams.get("ecosystem");
  const kind = url.searchParams.get("kind");
  const subject = url.searchParams.get("subject");
  const rows = (await listChanges()).filter(
    (r) =>
      (!providers.length || (r.provider && providers.includes(r.provider))) &&
      (!ecosystem || (r.record.subject as { ecosystem?: string }).ecosystem === ecosystem) &&
      (!kind || r.kind === kind) &&
      (!subject || (r.record.subject as { name?: string; model?: string }).name === subject),
  );
  return Response.json(
    { count: rows.length, changes: rows.map((r) => r.record) },
    { headers: { "cache-control": "public, max-age=300, s-maxage=900" } },
  );
}
