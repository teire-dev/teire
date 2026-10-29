import { getChange, providerNames } from "@/lib/catalog";
import { changeLife } from "@/lib/change-flow";
import { flowCard } from "@/lib/og/flow-card";

/** A change's link preview (plan revision 3.4, V6): its title over its life flow, from the public catalog. */
export async function GET(req: Request, { params }: RouteContext<"/og/change/[...id]">) {
  const { id } = await params;
  const [record, names] = await Promise.all([
    getChange(id.map(decodeURIComponent).join("/")),
    providerNames(),
  ]);
  if (!record) return new Response("Not found", { status: 404 });
  const { graph, ownerName } = changeLife(record, names);
  return flowCard({
    origin: new URL(req.url).origin,
    eyebrow: `Change · ${ownerName}`,
    title: record.title,
    graph,
    footer: "Quoted from its source. Teire finds the lines it reaches and fixes them.",
  });
}
