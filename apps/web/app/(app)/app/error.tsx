"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { BrokenFlow } from "@/components/state-page";
import { Button } from "@/components/ui/button";

/** A dashboard page failed to render: the broken flow inside the shell, so the sidebar and ⌘K stay. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 py-16 text-center" role="alert">
      <BrokenFlow kind="error" />
      <div className="flex flex-col gap-1.5">
        <h1 className="heading text-2xl text-ink">This page couldn&apos;t load.</h1>
        <p className="text-sm text-ink-2">Nothing you asked for was changed.</p>
        {error.digest ? <p className="font-mono text-xs text-ink-3">ref {error.digest}</p> : null}
      </div>
      <div className="flex gap-2">
        <Button onClick={reset}>
          <RotateCcw data-icon="inline-start" />
          Try again
        </Button>
        <Button variant="outline" asChild>
          <Link href="/app">Overview</Link>
        </Button>
      </div>
    </section>
  );
}
