import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { docsOptions } from "@/lib/docs-layout";
import { source } from "@/lib/source";

/** The docs: a top bar with the sections as tabs, a sidebar below (Fumadocs Notebook layout). */
export default function Layout({ children }: LayoutProps<"/docs">) {
  const { nav, ...base } = docsOptions();
  return (
    <DocsLayout tree={source.getPageTree()} tabMode="navbar" nav={{ ...nav, mode: "top" }} {...base}>
      {children}
    </DocsLayout>
  );
}
