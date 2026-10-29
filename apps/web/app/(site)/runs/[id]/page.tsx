import { Loader } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AppProviders } from "@/components/app/providers";
import { AskContext } from "@/components/assistant/assistant-provider";
import { AutoRefresh } from "@/components/auto-refresh";
import { ProofSheet } from "@/components/run/proof-sheet";
import { dryRunRequest, runSheet } from "@/lib/run-sheet";

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
        your own checks before and after in a sandbox. Run <span className="font-mono">{id.slice(0, 8)}</span>
        .{" "}
        <Link href="/scan" className="text-link hover:underline">
          Back to public scans
        </Link>
        .
      </p>
    </section>
  );
}

function NoRun({ error }: { error: string | null }) {
  return (
    <section className="mx-auto flex w-full max-w-xl flex-col gap-3 rounded-xl bg-sheet p-6 shadow-card">
      <h1 className="text-lg font-semibold">{error ? "The dry run couldn't start" : "No run here"}</h1>
      <p className="text-sm text-ink-2">
        {error ??
          "This run doesn't exist, or it is on a private repository: its runs open for people with access to the installation, once signed in."}
      </p>
      <p className="flex gap-4 text-sm">
        <Link href="/signin" className="text-link hover:underline">
          Sign in
        </Link>
        <Link href="/scan" className="text-link hover:underline">
          Scan a public repository
        </Link>
      </p>
    </section>
  );
}
