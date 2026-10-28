import {
  and,
  artifacts,
  asc,
  desc,
  eq,
  llmCalls,
  publicScans,
  runEvents,
  sandboxExecs,
  userInstallations,
} from "@teire/db";
import { ArrowRight, ExternalLink, Loader } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ActionButton } from "@/components/app/action-button";
import { AutoRefresh } from "@/components/auto-refresh";
import { Markdown } from "@/components/markdown";
import { DiffView } from "@/components/run/diff-view";
import { EvidenceBadge } from "@/components/run/evidence-badge";
import { Receipt } from "@/components/run/receipt";
import { VerificationTable } from "@/components/run/verification-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { visibleRun } from "@/lib/access";
import { database } from "@/lib/db";
import { groupHref } from "@/lib/links";
import { getSession } from "@/lib/session";
import { INSTALL_URL } from "@/lib/site";
import { backendName } from "@/lib/utils";
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
  stopping: "text-running",
  succeeded: "text-clear",
  failed: "text-affected",
  cancelled: "text-muted-foreground",
};

async function Run({ params }: { params: PageProps<"/runs/[id]">["params"] }) {
  const { id } = await params;
  await connection();
  const row = await visibleRun(id);
  if (!row) return <Pending id={id} />;
  const { run, repo } = row;
  const db = database();
  const dry = run.kind === "dry_run";
  const [[pr], calls, execs, dryRunEvents, [report]] = await Promise.all([
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
    // A dry run starts from a public report; the latest finished one is the way back.
    dry
      ? db
          .select({ id: publicScans.id })
          .from(publicScans)
          .where(and(eq(publicScans.repoId, repo.id), eq(publicScans.status, "done")))
          .orderBy(desc(publicScans.createdAt))
          .limit(1)
      : Promise.resolve([]),
  ]);
  const preview = dryRunEvents[0]?.payload as { title?: string; body?: string; mode?: string } | undefined;
  const [head, ...rest] = (run.groupKey ?? "").split("/");
  const isApi = head === "models" || head === "api";
  const subject = isApi ? (rest[0] ?? "") : rest.slice(0, -1).join("/");
  const subjectHref = run.groupKey ? groupHref(run.groupKey) : null;
  const ms = run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null;
  const secs = ms === null ? null : Math.round(ms / 1000);
  // The worker's note when a cancel reached it: what it was doing.
  const [stoppingEvent] =
    run.status === "stopping"
      ? await db
          .select({ payload: runEvents.payload })
          .from(runEvents)
          .where(and(eq(runEvents.runId, run.id), eq(runEvents.step, "run"), eq(runEvents.type, "stopping")))
          .orderBy(desc(runEvents.seq))
          .limit(1)
      : [];
  const stopping = stoppingEvent?.payload as { during?: string; doing?: string | null } | undefined;
  const duration = secs === null ? "—" : secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const active = run.status === "queued" || run.status === "running" || run.status === "stopping";
  // Cancel and Retry (U1) for people who can see the installation; the worker checks write access.
  const session = await getSession();
  const member =
    !dry && session && repo.installationId
      ? (
          await db
            .select({ id: userInstallations.installationId })
            .from(userInstallations)
            .where(
              and(
                eq(userInstallations.userId, session.user.id),
                eq(userInstallations.installationId, repo.installationId),
              ),
            )
            .limit(1)
        ).length > 0
      : false;

  return (
    <>
      <header className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <a
            href={`https://github.com/${repo.fullName}`}
            className="flex items-center gap-1 font-mono entity-link hover:text-foreground"
          >
            {repo.fullName}
            <ExternalLink className="size-3" aria-hidden />
          </a>
          <span>/</span>
          <span>{dry ? "dry run" : "fix run"}</span>
          {dry ? <Badge variant="outline">no PR opened</Badge> : null}
          {report ? (
            <Link href={`/scan/${report.id}`} className="text-link hover:underline">
              ← Back to the report
            </Link>
          ) : null}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {subjectHref ? (
            <Link href={subjectHref} className="font-mono entity-link">
              {subject}
            </Link>
          ) : (
            <span className="font-mono">{subject}</span>
          )}{" "}
          {run.fromVersion ? (
            <span className="font-mono text-muted-foreground line-through">{run.fromVersion}</span>
          ) : null}
          {run.fromVersion ? " → " : ""}
          <span className="font-mono">{run.targetVersion}</span>
        </h1>
        {run.status === "stopping" ? (
          // Plan "Cancel is honest": what a stopping run was doing, and that it ends within 30 s.
          <p className="text-sm text-running">
            Stopping: {run.cancelledBy ? `@${run.cancelledBy} asked` : "asked"} during{" "}
            {stopping?.during ?? run.step ?? "its work"}
            {stopping?.doing ? (
              <>
                {" "}
                (<span className="font-mono text-xs">{stopping.doing}</span>)
              </>
            ) : null}
            . Its model calls, updater job and sandbox commands are being stopped; this takes up to 30
            seconds.
          </p>
        ) : null}
        {member ? (
          <div className="flex gap-2">
            {active ? (
              <ActionButton
                kind="cancel-run"
                params={{ runId: run.id }}
                repo={repo.fullName}
                disabled={run.status === "stopping"}
              >
                {run.status === "stopping" ? "Stopping…" : "Cancel"}
              </ActionButton>
            ) : run.status === "failed" || run.status === "cancelled" ? (
              <ActionButton kind="retry-run" params={{ runId: run.id }} repo={repo.fullName}>
                Retry
              </ActionButton>
            ) : null}
          </div>
        ) : null}
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
            <span>{backendName(run.backend)}</span>
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
          {preview ? (
            <TabsTrigger value="pr">{preview.mode === "issue" ? "The issue" : "The PR"}</TabsTrigger>
          ) : null}
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
          <p className="mt-3 text-xs text-muted-foreground">
            The evidence comes from these results by fixed rules, never from a model.{" "}
            <Link href="/docs/build/verification" className="text-link hover:underline">
              How the evidence is decided
            </Link>
          </p>
        </TabsContent>
        <TabsContent value="receipt">
          <Receipt calls={calls} execs={execs} total={Number(run.costUsd)} />
        </TabsContent>
        {preview ? (
          <TabsContent value="pr">
            <article className="flex flex-col gap-4 rounded-lg bg-card p-5 shadow-card">
              <p className="text-xs text-muted-foreground">
                {preview.mode === "issue"
                  ? "A dry run opens nothing. The evidence was not enough for a pull request, so once installed Teire would open this as an issue for a person:"
                  : `A dry run opens nothing. This is the ${preview.mode === "draft" ? "draft " : ""}pull request Teire would open once installed:`}
              </p>
              <h2 className="text-lg font-semibold">
                {preview.mode === "issue"
                  ? `Teire needs a human: ${preview.title?.toLowerCase()}`
                  : preview.title}
              </h2>
              <Markdown>{preview.body ?? ""}</Markdown>
            </article>
            <aside className="mt-4 flex flex-col gap-3 rounded-lg bg-card p-5 shadow-card sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <p className="font-medium">Get changes like this as pull requests</p>
                <p className="text-sm text-muted-foreground">
                  Installed on {repo.fullName}, Teire opens this on GitHub, with the same evidence.{" "}
                  <Link href="/docs/guide/anatomy-of-a-pr" className="text-link hover:underline">
                    How to read a Teire PR
                  </Link>
                </p>
              </div>
              <Button asChild shape="pill" size="sm" className="shrink-0">
                <a href={INSTALL_URL}>
                  Install on GitHub
                  <ArrowRight data-icon="inline-end" />
                </a>
              </Button>
            </aside>
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
