import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { Logo } from "@/components/logo";
import { SPONSORS, STACK } from "@/lib/brands";
import { INSTALL_URL, NPM_URL, SOURCE_URL } from "@/lib/site";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "/scan", label: "Scan a repo" },
      { href: "/changes", label: "Changes" },
      { href: INSTALL_URL, label: "Install on GitHub" },
      { href: "/app", label: "Dashboard" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/docs", label: "Docs" },
      { href: "/docs/build/cli", label: "CLI and MCP" },
      { href: "/schema.json", label: "teire.yml schema" },
      { href: NPM_URL, label: "npm" },
    ],
  },
  {
    title: "Trust",
    links: [
      { href: "/trust", label: "How Teire runs" },
      { href: SOURCE_URL, label: "Source code" },
    ],
  },
] as const;

/** What a run is built on, as marks (plan revision 3.4: the footer names the stack, never in prose). */
const BUILT_ON = [
  { brand: SPONSORS.nvidia, label: "NVIDIA Nemotron", height: "h-4" },
  { brand: SPONSORS.nebius, label: "Nebius Token Factory", height: "h-3.5" },
  { brand: STACK.dependabot, label: "dependabot-core", height: "h-4" },
  { brand: STACK.cloudflare, label: "Cloudflare", height: "h-4" },
];

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-rule bg-canvas">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 sm:grid-cols-[1.6fr_repeat(3,1fr)]">
        <div className="flex flex-col gap-4">
          <Logo />
          <p className="max-w-xs text-sm text-ink-2">When upstream breaks, Teire fixes your code.</p>
          <div className="flex flex-col gap-2">
            <span className="eyebrow">Built on</span>
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-3">
              {BUILT_ON.map((b) => (
                <li key={b.label} title={b.label}>
                  <BrandLogo light={b.brand.light} dark={b.brand.dark} alt={b.label} className={b.height} />
                </li>
              ))}
            </ul>
          </div>
        </div>
        {COLUMNS.map((c) => (
          <div key={c.title} className="flex flex-col gap-2.5 text-sm">
            <p className="font-medium text-ink">{c.title}</p>
            {c.links.map((l) =>
              l.href.startsWith("http") ? (
                <a key={l.href} href={l.href} className="text-ink-2 hover:text-ink">
                  {l.label}
                </a>
              ) : (
                <Link key={l.href} href={l.href} className="text-ink-2 hover:text-ink">
                  {l.label}
                </Link>
              ),
            )}
          </div>
        ))}
      </div>
    </footer>
  );
}
