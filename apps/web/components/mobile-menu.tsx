"use client";

import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  Menu,
  Play,
  ScanSearch,
  ScrollText,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { GithubMark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SPONSORS } from "@/lib/brands";
import { INSTALL_URL, SOURCE_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

/** What each section is for, in a line, so a phone menu says where it goes (Appwrite's menu rows). */
const ABOUT: Record<string, { said: string; Icon: typeof ScrollText }> = {
  "/changes": { said: "Upstream changes, each sourced", Icon: ScrollText },
  "/scan": { said: "Check a public repo, no install", Icon: ScanSearch },
  "/docs": { said: "How Teire works, end to end", Icon: BookOpen },
  "/trust": { said: "Live status and what Teire never does", Icon: ShieldCheck },
};

/**
 * Phones (revamp S4, the owner's "a dropdown, more creative than a side sheet"): the floating pill's
 * menu drops a card from under it, as TravelPerk's menu card: each section as a row with its icon and
 * what it's for, the page you're on marked with the lime bar the app's sidebar uses, then Install on
 * GitHub and the source and demo one tap away. The page dims below the pill, which stays crisp; Escape,
 * a tap outside or a link closes it, and focus stays inside while it's open.
 */
export function MobileMenu({ links }: { links: readonly { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden over-hero:text-hero-ink over-hero:hover:bg-white/10"
          aria-label={open ? "Close the menu" : "Menu"}
        >
          {open ? <X /> : <Menu />}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-x-0 top-16 bottom-0 z-50 bg-[rgb(13_15_19/0.45)] backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 md:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-3 top-[4.25rem] z-50 origin-top overflow-hidden rounded-[22px] bg-sheet shadow-float ring-1 ring-rule duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-2 md:hidden"
        >
          <Dialog.Title className="sr-only">Teire menu</Dialog.Title>
          <nav aria-label="Main" className="flex flex-col p-2">
            {links.map((l) => {
              const about = ABOUT[l.href];
              const here = path === l.href || path.startsWith(`${l.href}/`);
              const Icon = about?.Icon ?? ChevronRight;
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  aria-current={here ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center gap-3 rounded-2xl px-3 py-3 transition-colors active:bg-hover",
                    here ? "bg-hover" : "hover:bg-hover",
                  )}
                >
                  {here ? (
                    <span
                      aria-hidden
                      className="absolute inset-y-3 left-0 w-[3px] rounded-full bg-cta shadow-[0_0_0_1px_var(--cta-edge)]"
                    />
                  ) : null}
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sunken text-ink ring-1 ring-rule ring-inset">
                    <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[15px] font-medium text-ink">{l.label}</span>
                    {about ? <span className="truncate text-[12.5px] text-ink-3">{about.said}</span> : null}
                  </span>
                  <ChevronRight
                    className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </Link>
              );
            })}
          </nav>
          <div className="flex flex-col gap-3 border-t border-rule bg-canvas p-3">
            <Button asChild variant="cta" size="lg" shape="pill" className="w-full">
              <a href={INSTALL_URL}>
                <GithubMark className="size-4" />
                Install on GitHub
              </a>
            </Button>
            <div className="grid grid-cols-2 gap-2 text-[13px]">
              <a
                href={SOURCE_URL}
                className="flex items-center justify-center gap-2 rounded-full bg-sheet px-3 py-2 text-ink-2 ring-1 ring-rule hover:text-ink"
              >
                <BrandLogo
                  light={SPONSORS.github.light}
                  dark={SPONSORS.github.dark}
                  alt=""
                  className="h-3.5"
                />
                Source
                <ArrowUpRight className="size-3.5 text-ink-3" aria-hidden />
              </a>
              <Link
                href="/demo"
                onClick={() => setOpen(false)}
                className="flex items-center justify-center gap-2 rounded-full bg-sheet px-3 py-2 text-ink-2 ring-1 ring-rule hover:text-ink"
              >
                <Play className="size-3.5 fill-current" aria-hidden />
                Demo video
              </Link>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
