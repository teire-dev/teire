"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";

/** Something failed while rendering: say so plainly, offer a retry, keep the digest for support. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-svh flex-1 flex-col items-center justify-center gap-6 bg-canvas px-6 text-center">
      <LogoMark className="size-10" />
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Error</span>
        <h1 className="heading text-3xl text-ink">Something broke on our side.</h1>
        {error.digest ? <p className="font-mono text-xs text-ink-3">ref {error.digest}</p> : null}
      </div>
      <div className="flex gap-2">
        <Button onClick={reset}>
          <RotateCcw data-icon="inline-start" />
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Head home</Link>
        </Button>
      </div>
    </main>
  );
}
