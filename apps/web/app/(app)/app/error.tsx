"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/** A dashboard page failed to render: said inside the shell, so the sidebar and ⌘K stay. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section
      className="mx-auto flex w-full max-w-xl flex-col gap-3 rounded-xl bg-sheet p-6 shadow-card"
      role="alert"
    >
      <span className="eyebrow">Dashboard</span>
      <h1 className="text-lg font-semibold text-ink">This page couldn&apos;t load.</h1>
      <p className="text-sm text-ink-2">
        Reading it failed on our side; nothing you asked for was changed.
        {error.digest ? <span className="font-mono text-xs text-ink-3"> ref {error.digest}</span> : null}
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={reset}>
          <RotateCcw data-icon="inline-start" />
          Try again
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href="/app">Overview</Link>
        </Button>
      </div>
    </section>
  );
}
