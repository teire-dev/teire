import { Loader } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AppProviders } from "@/components/app/providers";
import { AutoRefresh } from "@/components/auto-refresh";
import { ProofSheet } from "@/components/run/proof-sheet";
import { runSheet } from "@/lib/run-sheet";

export const metadata: Metadata = { title: "Run", robots: { index: false } };

/**
 * One run's proof sheet (plan revision 3.3, U2): what changed, where it reaches the code, what was
 * fixed, what proves it and what wasn't proven, live while it works and replayable after; for a dry
 * run, the PR it would open.
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
  if (!sheet) return <Pending id={id} />;
  return (
    <AppProviders>
      <ProofSheet initial={sheet} />
    </AppProviders>
  );
}

/** The sheet's shape while it loads: header, the chain, the two columns. */
function SheetLoading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6" role="status" aria-label="Loading the run">
      <div className="h-16 w-2/3 animate-pulse rounded-lg bg-sunken" />
      <div className="h-36 animate-pulse rounded-xl bg-sheet shadow-card" />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="h-96 animate-pulse rounded-xl bg-sheet shadow-card" />
        <div className="h-72 animate-pulse rounded-xl bg-sheet shadow-card" />
      </div>
    </div>
  );
}

function Pending({ id }: { id: string }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg bg-card p-6 shadow-card" aria-live="polite">
      <p className="flex items-center gap-2 font-medium">
        <Loader className="size-4 animate-spin text-running" aria-hidden />
        Starting the dry run · <AutoRefresh since={new Date().toISOString()} />
      </p>
      <p className="text-sm text-muted-foreground">
        The worker is picking it up. This page turns into the live run as soon as it starts: the fix, then
        your own checks before and after in a sandbox. If nothing appears within two minutes, the run id{" "}
        <span className="font-mono">{id.slice(0, 8)}</span> may not exist, or this run is on a private
        repository you cannot see.{" "}
        <Link href="/scan" className="text-link hover:underline">
          Back to public scans
        </Link>
        .
      </p>
    </section>
  );
}
