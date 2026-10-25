import { connection } from "next/server";
import { publicProviders } from "@/lib/catalog";

/** Public provider records as JSON: what `teire scan` matches a checkout's API hosts against. */
export async function GET() {
  await connection();
  const rows = await publicProviders();
  return Response.json(
    { count: rows.length, providers: rows.map((r) => r.record) },
    { headers: { "cache-control": "public, max-age=300, s-maxage=900" } },
  );
}
