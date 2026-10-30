import { generateOGImage } from "fumadocs-ui/og";
import { notFound } from "next/navigation";
import { getPageImage, source } from "@/lib/source";

/** A docs page's link preview: its title and description on the hero graphite, the lime accent (3.4). */
export async function GET(_req: Request, { params }: RouteContext<"/og/docs/[...slug]">) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();
  return generateOGImage({
    title: page.data.title,
    description: page.data.description,
    site: "Teire docs",
    primaryColor: "rgba(212, 245, 60, 0.32)",
    primaryTextColor: "#d4f53c",
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: getPageImage(page).segments }));
}
