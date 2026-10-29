"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { BrokenFlow } from "@/components/state-page";
import { Button } from "@/components/ui/button";

/** The run page failed to render: the broken flow, one line, a retry; the run itself is unaffected. */
export default function RunError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex w-full flex-1 flex-col items-center gap-6 px-4 py-20 text-center" role="alert">
      <BrokenFlow kind="error" />
      <div className="flex flex-col gap-1.5">
        <h1 className="heading text-2xl">This run couldn&apos;t be shown.</h1>
        <p className="text-sm text-ink-2">The run itself is unaffected.</p>
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
