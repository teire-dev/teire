import Link from "next/link";
import { Logo } from "@/components/logo";
import { INSTALL_URL, NPM_URL, SOURCE_URL } from "@/lib/site";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "/scan", label: "Scan a public repo" },
      { href: "/changes", label: "Public changes" },
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

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:grid-cols-[1.5fr_repeat(3,1fr)]">
        <div className="flex flex-col gap-3">
          <Logo />
          <p className="max-w-xs text-sm text-muted-foreground">
            When a package, API or model changes, Teire fixes your code. Built on NVIDIA Nemotron and Nebius
            Token Factory.
          </p>
        </div>
        {COLUMNS.map((c) => (
          <div key={c.title} className="flex flex-col gap-2 text-sm">
            <p className="font-medium">{c.title}</p>
            {c.links.map((l) =>
              l.href.startsWith("http") ? (
                <a key={l.href} href={l.href} className="text-muted-foreground hover:text-foreground">
                  {l.label}
                </a>
              ) : (
                <Link key={l.href} href={l.href} className="text-muted-foreground hover:text-foreground">
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
