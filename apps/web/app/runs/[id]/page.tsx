import { and, artifacts, asc, eq, llmCalls, runEvents, sandboxExecs } from "@teire/db";
import { ExternalLink, Loader } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { Markdown } from "@/components/markdown";
import { DiffView } from "@/components/run/diff-view";
import { EvidenceBadge } from "@/components/run/evidence-badge";
import { Receipt } from "@/components/run/receipt";
import { VerificationTable } from "@/components/run/verification-table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { visibleRun } from "@/lib/access";
import { database } from "@/lib/db";
import { Timeline } from "./timeline";

export const metadata: Metadata = { title: "Run", robots: { index: false } };

/**
 * One fix run, live while it works and replayable after (C4, C5, C12): summary row, then the
 * timeline, the diff, the verification table and the receipt; for a dry run, the PR it would open.
 */
export default function RunPage({ params }: PageProps<"/runs/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-12">
      <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <Run params={params} />
      </Suspense>
    </main>
  );
}

const STATUS_TONE: Record<string, string> = {
  queued: "text-running",
  running: "text-running",
  succeeded: "text-clear",
  failed: "text-affected",
  cancelled: "text-muted-foreground",
};

async function Run({ params }: { params: PageProps<"/runs/[id]">["params"] }) {
  const { id } = await params;
  const row = await visibleRun(id);
  if (!row) return <Pending id={id} />;
  const { run, repo } = row;
  const db = database();
  const [[pr], calls, execs, dryRunEvents] = await Promise.all([
    db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.repoId, repo.id), eq(artifacts.runId, run.id)))
      .limit(1),
    db.select().from(llmCalls).where(eq(llmCalls.runId, run.id)).orderBy(asc(llmCalls.createdAt)),
    db.select().from(sandboxExecs).where(eq(sandboxExecs.runId, run.id)).orderBy(asc(sandboxExecs.createdAt)),
    db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.step, "pr"), eq(runEvents.type, "dry-run")))
      .limit(1),
  ]);
  const preview = dryRunEvents[0]?.payload as { title?: string; body?: string; mode?: string } | undefined;
  const dry = run.kind === "dry_run";
  const [head, ...rest] = (run.groupKey ?? "").split("/");
  const isApi = head === "models" || head === "api";
  const subject = isApi ? (rest[0] ?? "") : rest.slice(0, -1).join("/");
  const ms = run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null;
  const duration =
    ms === null
      ? "—"
      : ms < 60_000
        ? `${Math.round(ms / 1000)}s`
        : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  const active = run.status === "queued" || run.status === "running";

  return (
    <>
      <header className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <a href={`https://github.com/${repo.fullName}`} className="font-mono hover:text-foreground">
            {repo.fullName}
          </a>
          <span>/</span>
          <span>{dry ? "dry run" : "fix run"}</span>
          {dry ? <Badge variant="outline">no PR opened</Badge> : null}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          <span className="font-mono">{subject}</span>{" "}
          {run.fromVersion ? (
            <span className="font-mono text-muted-foreground line-through">{run.fromVersion}</span>
          ) : null}
          {run.fromVersion ? " → " : ""}
          <span className="font-mono">{run.targetVersion}</span>
        </h1>
      </header>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border text-sm shadow-card sm:grid-cols-5">
        <Fact label="Status">
          <span className={`flex items-center gap-1.5 ${STATUS_TONE[run.status] ?? ""}`}>
            {active ? (
              <Loader className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <span className="size-2 rounded-full bg-current" />
            )}
            {run.status}
          </span>
          {run.step ? <span className="block truncate text-xs text-muted-foreground">{run.step}</span> : null}
        </Fact>
        <Fact label="Evidence">
          {run.evidenceKind ? (
            <EvidenceBadge kind={run.evidenceKind} />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Fact>
        <Fact label="Duration">
          <span className="font-mono">{duration}</span>
        </Fact>
        <Fact label="Model cost">
          <span className="font-mono">${Number(run.costUsd).toFixed(4)}</span>
        </Fact>
        <Fact label={pr ? (pr.kind === "issue" ? "Issue" : "Pull request") : "Sandbox"}>
          {pr?.url ? (
            <a href={pr.url} className="flex items-center gap-1 text-link hover:underline">
              #{pr.number} <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : (
            <span className="font-mono">{run.backend ?? "—"}</span>
          )}
        </Fact>
      </dl>
      {run.error ? (
        <p className="rounded-md bg-affected-soft px-3 py-2 text-sm text-affected">{run.error}</p>
      ) : null}

      <Tabs defaultValue={active ? "timeline" : dry && preview ? "pr" : "verification"} className="gap-4">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="diff">Diff</TabsTrigger>
          <TabsTrigger value="verification">Verification</TabsTrigger>
          <TabsTrigger value="receipt">Receipt</TabsTrigger>
          {preview ? <TabsTrigger value="pr">The PR</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="timeline">
          <Timeline runId={run.id} initialStatus={run.status} />
        </TabsContent>
        <TabsContent value="diff">
          <DiffView patch={run.diff} />
        </TabsContent>
        <TabsContent value="verification">
          <VerificationTable
            verification={run.verification as Parameters<typeof VerificationTable>[0]["verification"]}
          />
        </TabsContent>
        <TabsContent value="receipt">
          <Receipt calls={calls} execs={execs} total={Number(run.costUsd)} />
        </TabsContent>
        {preview ? (
          <TabsContent value="pr">
            <article className="flex flex-col gap-4 rounded-lg bg-card p-5 shadow-card">
              <p className="text-xs text-muted-foreground">
                A dry run opens nothing. This is the {preview.mode === "draft" ? "draft " : ""}pull request
                Teire would open once installed:
              </p>
              <h2 className="text-lg font-semibold">{preview.title}</h2>
              <Markdown>{preview.body ?? ""}</Markdown>
            </article>
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-card p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** The web chose this run's id; until the worker records it, the page waits for it. */
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
