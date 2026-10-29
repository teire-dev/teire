"use client";

import { ArrowRight, House, MessageCircle, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { Connector } from "@/components/flow/static-flow";
import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { SOURCE_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

/**
 * The 404 and the error page (plan revision 3.4, V1): a flow that broke — Teire → a dashed red tile
 * where the page should be, the line cut → Home — then one line and the ways on: Head home, Try again
 * (errors), Get in touch (an issue on Teire's repository, with the error's reference when there is one).
 */
const contact = (ref?: string) =>
  `${SOURCE_URL}/issues/new?${new URLSearchParams({
    title: ref ? `Error on teire.vercel.app (ref ${ref})` : "Something on teire.vercel.app",
    body: ref ? `What I was doing:\n\n\nref ${ref}` : "What I was looking for:\n",
  })}`;

function Square({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "relative flex size-16 shrink-0 items-center justify-center rounded-tile bg-sheet shadow-tile",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function BrokenFlow({ kind }: { kind: "not-found" | "error" }) {
  return (
    <div
      role="img"
      aria-label={kind === "error" ? "The page broke on the way" : "There is no page here"}
      className="flex items-center [--tile:64px]"
    >
      <Square className="ring-[1.5px] ring-ink/70">
        <LogoMark className="size-9" />
      </Square>
      <Connector axis="x" link={{ state: "done" }} />
      <Square className="outline-dashed outline-2 -outline-offset-2 outline-broke">
        <span className="font-mono text-[15px] font-medium text-broke">
          {kind === "error" ? "500" : "404"}
        </span>
        <span className="absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full bg-broke text-white ring-2 ring-canvas dark:text-sheet">
          <X className="size-3" strokeWidth={3.25} />
        </span>
      </Square>
      <Connector axis="x" link={{ state: "failed" }} />
      <Square className="opacity-55 outline-dashed outline-[1.5px] -outline-offset-[1.5px] outline-ink-3/55">
        <House className="size-6 text-ink-3" strokeWidth={1.75} />
      </Square>
    </div>
  );
}

export function StatePage({
  kind,
  digest,
  reset,
  inset = false,
}: {
  kind: "not-found" | "error";
  digest?: string;
  reset?: () => void;
  /** Inside the site's header and footer, rather than the whole screen. */
  inset?: boolean;
}) {
  return (
    <main
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-8 bg-canvas px-6 text-center",
        inset ? "py-24" : "min-h-svh",
      )}
    >
      <BrokenFlow kind={kind} />
      <div className="flex flex-col gap-2">
        <h1 className="display text-5xl text-ink">
          {kind === "error" ? "Something broke." : "Nothing here."}
        </h1>
        {digest ? <p className="font-mono text-xs text-ink-3">ref {digest}</p> : null}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {reset ? (
          <Button onClick={reset} variant="cta" size="xl" shape="pill">
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
        ) : null}
        <Button asChild variant={reset ? "outline" : "cta"} size="xl" shape="pill">
          <Link href="/">
            Head home
            {reset ? null : <ArrowRight data-icon="inline-end" />}
          </Link>
        </Button>
        <Button asChild variant="outline" size="xl" shape="pill">
          <a href={contact(digest)}>
            <MessageCircle data-icon="inline-start" />
            Get in touch
          </a>
        </Button>
      </div>
    </main>
  );
}
