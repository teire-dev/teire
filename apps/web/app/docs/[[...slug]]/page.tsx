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
import { Suspense } from "react";
import { getMDXComponents } from "@/components/mdx";
import { SOURCE_URL } from "@/lib/site";
import { getPageImage, getPageMarkdownUrl, source } from "@/lib/source";

const SITE_URL = "https://teire.vercel.app";

/**
 * The slug is URL data, so the page reads it inside Suspense: the docs bar and sidebar (the layout)
 * stay instant on navigation, and every known page is still prerendered from generateStaticParams.
 */
export default function Page({ params }: PageProps<"/docs/[[...slug]]">) {
  return (
    <Suspense fallback={<div className="flex-1" aria-hidden />}>
      <DocsContent params={params} />
    </Suspense>
  );
}

async function DocsContent({ params }: Pick<PageProps<"/docs/[[...slug]]">, "params">) {
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
      {/* The serif, as every public headline (plan revision 3.4, B8: 32px and up). */}
      <DocsTitle className="display text-[2.5rem] font-normal">{page.data.title}</DocsTitle>
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
