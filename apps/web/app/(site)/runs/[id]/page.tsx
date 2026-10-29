import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AppProviders } from "@/components/app/providers";
import { AskContext } from "@/components/assistant/assistant-provider";
import { AutoRefresh } from "@/components/auto-refresh";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { ProofSheet } from "@/components/run/proof-sheet";
import { BrokenFlow } from "@/components/state-page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { dryRunRequest, runSheet } from "@/lib/run-sheet";

export async function generateMetadata({ params }: PageProps<"/runs/[id]">): Promise<Metadata> {
  const { id } = await params;
  // The run's flow as its preview: a private repository's run draws only its steps' states.
  const image = `/og/run/${id}`;
  return {
    title: "Run",
    robots: { index: false },
    openGraph: { images: image },
    twitter: { card: "summary_large_image", images: image },
  };
}

/**
 * One run (plan revision 3.4, V3): its canvas, the selected tile's evidence and the console, live
 * while it works and replayable after; for a dry run, the PR it would open.
 */
export default function RunPage({ params }: PageProps<"/runs/[id]">) {
  return (
    <main className="flex w-full flex-1 flex-col gap-6 px-4 py-10 md:px-8">
      <Suspense fallback={<SheetLoading />}>
        <Run params={params} />
      </Suspense>
    </main>
  );
}

async function Run({ params }: { params: PageProps<"/runs/[id]">["params"] }) {
  const { id } = await params;
  await connection();
  const sheet = await runSheet(id);
  if (!sheet) {
    // A dry run just asked for has no run yet; anything else is missing, or private to its members.
    const request = await dryRunRequest(id);
    return request && !request.error ? <Pending id={id} /> : <NoRun error={request?.error ?? null} />;
  }
  return (
    <AppProviders>
      <AskContext
        kind="run"
        id={sheet.run.id}
        label={`${sheet.repo.fullName.split("/")[1]} ${sheet.run.groupKey?.split("/").slice(-2).join(" ") ?? "run"}`}
      />
      <ProofSheet initial={sheet} />
    </AppProviders>
  );
}

/** The page's shape while it loads: the header, the canvas with its ghost flow, the console. */
function SheetLoading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5" role="status" aria-label="Loading the run">
      <div className="flex items-center gap-4">
        <Skeleton className="size-11 rounded-[12px]" />
        <Skeleton className="h-9 w-1/2" />
      </div>
      <div className="flex h-[300px] items-center justify-center rounded-feature bg-sheet shadow-card">
        <GhostFlow tiles={6} />
      </div>
      <Skeleton className="h-48 w-full rounded-feature" />
    </div>
  );
}

/** A dry run asked for and not started yet: the spine waiting, one line, the time it has waited. */
function Pending({ id }: { id: string }) {
  return (
    <section
      className="mx-auto flex w-full max-w-6xl flex-col items-center gap-6 rounded-feature bg-sheet px-6 py-14 text-center shadow-card"
      aria-live="polite"
    >
      <GhostFlow tiles={6} />
      <div className="flex flex-col gap-1.5">
        <h1 className="heading text-2xl">Starting the dry run</h1>
        <p className="font-mono text-xs text-ink-3">
          {id.slice(0, 8)} · <AutoRefresh since={new Date().toISOString()} />
        </p>
      </div>
      <Link href="/scan" className="text-[13px] text-link hover:underline">
        Back to public scans
      </Link>
    </section>
  );
}

/** No run to show: it doesn't exist, it's private to its installation, or the dry run couldn't start. */
function NoRun({ error }: { error: string | null }) {
  return (
    <section className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 py-14 text-center">
      <BrokenFlow kind="not-found" />
      <div className="flex flex-col gap-1.5">
        <h1 className="heading text-2xl">{error ? "The dry run couldn't start" : "No run here"}</h1>
        <p className="text-sm text-ink-2">
          {error ?? "Private runs open for people with access, signed in."}
        </p>
      </div>
      <div className="flex gap-2">
        <Button asChild>
          <Link href="/signin">Sign in</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/scan">Scan a public repo</Link>
        </Button>
      </div>
    </section>
  );
}
