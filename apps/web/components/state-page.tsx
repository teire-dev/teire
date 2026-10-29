"use client";

import { ArrowRight, MessageCircle, RotateCcw } from "lucide-react";
import Link from "next/link";
import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { SOURCE_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

/**
 * The 404 and the error page (plan revision 3.3, U5): the mark, one line, and the ways on: Head home,
 * Get in touch (an issue on Teire's repository, with the error's reference when there is one).
 */
const contact = (ref?: string) =>
  `${SOURCE_URL}/issues/new?${new URLSearchParams({
    title: ref ? `Error on teire.vercel.app (ref ${ref})` : "Something on teire.vercel.app",
    body: ref ? `What I was doing:\n\n\nref ${ref}` : "What I was looking for:\n",
  })}`;

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
        "flex flex-1 flex-col items-center justify-center gap-6 bg-canvas px-6 text-center",
        inset ? "py-20" : "min-h-svh",
      )}
    >
      <LogoMark className="size-10" />
      <div className="flex flex-col gap-2">
        <span className="eyebrow">{kind === "error" ? "Error" : "404"}</span>
        <h1 className="heading text-3xl text-ink">
          {kind === "error" ? "Something broke on our side." : "This page isn't here."}
        </h1>
        {digest ? <p className="font-mono text-xs text-ink-3">ref {digest}</p> : null}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {reset ? (
          <Button onClick={reset}>
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
        ) : null}
        <Button asChild variant={reset ? "outline" : "default"}>
          <Link href="/">
            Head home
            {reset ? null : <ArrowRight data-icon="inline-end" />}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <a href={contact(digest)}>
            <MessageCircle data-icon="inline-start" />
            Get in touch
          </a>
        </Button>
      </div>
    </main>
  );
}
