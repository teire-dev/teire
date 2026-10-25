import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/notebook/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import { SOURCE_URL } from "@/lib/site";
import { getPageImage, getPageMarkdownUrl, source } from "@/lib/source";

const SITE_URL = "https://teire.vercel.app";

export default async function Page({ params }: PageProps<"/docs/[[...slug]]">) {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      tableOfContent={{ style: "clerk" }}
      breadcrumb={{ includeRoot: true }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row flex-wrap items-center gap-2 border-b border-fd-border pt-4 pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          pageUrl={`${SITE_URL}${page.url}`}
          githubUrl={`${SOURCE_URL}/blob/main/apps/web/content/docs/${page.path}`}
        />
      </div>
      <DocsBody>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  const image = getPageImage(page).url;
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
    openGraph: { title: page.data.title, description: page.data.description, images: image },
    twitter: { card: "summary_large_image", images: image },
  };
}
