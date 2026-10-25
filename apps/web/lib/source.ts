import { createGetUrl, llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";

const docs = defineDocs({
  dir: "content/docs",
  docs: { schema: pageSchema, postprocess: { includeProcessedMarkdown: true } },
  meta: { schema: metaSchema },
});

/** Every page in content/docs, under /docs. Icons in meta.json and frontmatter are lucide names. */
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

export type DocsPage = (typeof source)["$inferPage"];

/** The same pages as plain text for language models (/llms.txt, /llms-full.txt, per page). */
export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})\n\n${await page.data.getText("processed")}`,
});

/** A page's link preview (app/og/docs/[...slug]). */
export function getPageImage(page: DocsPage) {
  const segments = [...page.slugs, "image.png"];
  return { segments, url: `/og/docs/${segments.join("/")}` };
}

const markdownUrl = createGetUrl("/llms.mdx/docs");

/** A page as Markdown, for "Copy Markdown" and "Open in ChatGPT / Claude". */
export function getPageMarkdownUrl(page: DocsPage) {
  const segments = [...page.slugs, "content.md"];
  return { segments, url: markdownUrl(segments) };
}
