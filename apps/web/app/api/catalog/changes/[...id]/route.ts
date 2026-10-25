import { getChange } from "@/lib/catalog";

/** One public change record by id (`teire explain <id>`, the MCP `get_change` tool). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string[] }> }) {
  const { id } = await params;
  const record = await getChange(id.map(decodeURIComponent).join("/"));
  if (!record) return Response.json({ error: "no public change with that id" }, { status: 404 });
  return Response.json(record, { headers: { "cache-control": "public, max-age=300, s-maxage=900" } });
}
