import { generateOGImage } from "fumadocs-ui/og";
import { notFound } from "next/navigation";
import { getPageImage, source } from "@/lib/source";

/** A docs page's link preview: its title and description on Teire's dark canvas, the link accent. */
export async function GET(_req: Request, { params }: RouteContext<"/og/docs/[...slug]">) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();
  return generateOGImage({
    title: page.data.title,
    description: page.data.description,
    site: "Teire docs",
    primaryColor: "rgba(82, 168, 255, 0.22)",
    primaryTextColor: "#52a8ff",
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: getPageImage(page).segments }));
}
