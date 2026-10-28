"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/** The run page failed to render: said in the page, with a retry, the site around it kept. */
export default function RunError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex w-full flex-1 flex-col items-center px-4 py-16">
      <section
        className="flex w-full max-w-xl flex-col gap-3 rounded-xl bg-sheet p-6 shadow-card"
        role="alert"
      >
        <span className="eyebrow">Run</span>
        <h1 className="text-lg font-semibold">This run couldn't be shown.</h1>
        <p className="text-sm text-ink-2">
          Reading it failed on our side; the run itself is unaffected.
          {error.digest ? <span className="font-mono text-xs text-ink-3"> ref {error.digest}</span> : null}
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={reset}>
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href="/scan">Public scans</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
