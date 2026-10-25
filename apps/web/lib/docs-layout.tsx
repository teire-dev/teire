import type { BaseLayoutProps, LinkItemType } from "fumadocs-ui/layouts/shared";
import { SOURCE_URL } from "./site";

/** The one filled action in the docs bar, monochrome like the site's primary buttons. */
const openApp: LinkItemType = {
  type: "custom",
  secondary: true,
  children: (
    <a
      href="/scan"
      className="inline-flex h-8 items-center rounded-full bg-fd-foreground px-3.5 text-[13px] font-medium whitespace-nowrap text-fd-background transition-opacity hover:opacity-85"
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
          <svg viewBox="0 0 16 16" className="size-5" aria-hidden>
            <rect
              x="1.25"
              y="1.25"
              width="13.5"
              height="13.5"
              rx="3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M5 5.25h6M8 5.25v5.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
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
