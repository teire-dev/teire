import type { BaseLayoutProps, LinkItemType } from "fumadocs-ui/layouts/shared";
import { LogoMark } from "@/components/logo";
import { SOURCE_URL } from "./site";

/** The one filled action in the docs bar: the site's lime call to action. */
const openApp: LinkItemType = {
  type: "custom",
  secondary: true,
  children: (
    <a
      href="/scan"
      className="inline-flex h-8 items-center rounded-full bg-cta px-3.5 text-[13px] font-semibold whitespace-nowrap text-cta-ink shadow-cta transition-colors hover:bg-cta-hover"
    >
      Try Teire
    </a>
  ),
};

/** The docs bar: Teire's mark (to the home page), the public sections, GitHub, and one action. */
export function docsOptions(): BaseLayoutProps {
  return {
    githubUrl: SOURCE_URL,
    nav: {
      title: (
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <LogoMark className="size-6" />
          Teire
          <span aria-hidden className="h-4 w-px bg-fd-border" />
          <span className="text-[13px] font-normal text-fd-muted-foreground">Docs</span>
        </span>
      ),
      url: "/",
    },
    links: [
      { text: "Changes", url: "/changes" },
      { text: "Scan", url: "/scan" },
      { text: "Dashboard", url: "/app" },
      openApp,
    ],
  };
}
