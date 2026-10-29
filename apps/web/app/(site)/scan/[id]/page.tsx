import { PUBLIC_LIMITS } from "@teire/engine/constants";
import { ChevronDown, FlaskConical, GitPullRequest } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { BrandLogo } from "@/components/brand-logo";
import { FindingFlow } from "@/components/findings/finding-flow";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { StaticFlow } from "@/components/flow/static-flow";
import { TileSquare } from "@/components/flow/tile";
import { GithubMark } from "@/components/icons";
import { ShareLink } from "@/components/run/share-run";
import { SignInButton } from "@/components/sign-in-button";
import { BrokenFlow } from "@/components/state-page";
import { Mark } from "@/components/teire/mark";
import { Button } from "@/components/ui/button";
import { ecosystemOf } from "@/lib/brands";
import { bucketGroups, type FindingGroup, groupFindings } from "@/lib/findings";
import type { FlowState } from "@/lib/flow/model";
import { subjectMark } from "@/lib/marks";
import { proofOfRun } from "@/lib/proof";
import { dryRunsFor, publicReport, usageToday } from "@/lib/reports";
import { getSession } from "@/lib/session";
import { INSTALL_URL } from "@/lib/site";
import { cn } from "@/lib/utils";
import { startDryRun } from "../actions";

export async function generateMetadata({ params }: PageProps<"/scan/[id]">): Promise<Metadata> {
  const { id } = await params;
  const image = `/og/scan/${id}`;
  return {
    title: `Scan report ${id.slice(0, 8)}`,
    robots: { index: false },
    openGraph: { images: image },
    twitter: { card: "summary_large_image", images: image },
  };
}

/**
 * A public scan report (plan revision 3.4, V5): what the scan read and found as one flow, then each
 * change reaching the code as its change → code → fix → PR-preview flow with a dry run beside it; what
 * Teire couldn't check and what doesn't reach folded; the install band last.
 */
export default function ReportPage({ params }: PageProps<"/scan/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-12">
      <Suspense fallback={<ReportSkeleton />}>
        <Report params={params} />
      </Suspense>
    </main>
  );
}

async function Report({ params }: { params: PageProps<"/scan/[id]">["params"] }) {
  // Per request: the report follows the worker and says how long it has been.
  await connection();
  const { id } = await params;
  const report = await publicReport(id);
  if (!report) notFound();
  const { request, scan, repo } = report;
  const name = repo?.fullName ?? request.repoFullName;

  if (request.status === "queued" || request.status === "running") {
    const running = request.status === "running";
    // What a scan does, as the flow it is; the first step works while the rest wait.
    const steps = [
      { id: "repo", entity: "repository", label: "The repository", meta: "default branch" },
      { id: "deps", entity: "update", label: "Manifests", meta: "exact versions" },
      { id: "apis", entity: "change", label: "API changes", meta: "per upgrade" },
      { id: "providers", entity: "change", label: "Providers", meta: "hosts and models" },
      { id: "lines", entity: "code", label: "Your lines", meta: "what each reaches" },
    ] as const;
    // The worker's step (V5–V6 review): the tiles it covers pulse, the ones before are done. Reading
    // packages and diffing their APIs is one pass, so those two tiles work together.
    const SPAN: Record<string, [number, number]> = {
      repo: [0, 0],
      deps: [1, 2],
      providers: [3, 3],
      lines: [4, 4],
    };
    const [from, to] = running ? (SPAN[request.step ?? "repo"] ?? [0, 0]) : [-1, -1];
    const tileState = (i: number) => (i < from ? "done" : i <= to ? "live" : "pending") as FlowState;
    const quietMin = Math.floor((Date.now() - request.createdAt.getTime()) / 60_000);
    return (
      <>
        <RepoHeader name={name} />
        <section className="flex flex-col gap-5 rounded-xl bg-sheet p-6 shadow-card" aria-live="polite">
          <StaticFlow
            label="What the scan is doing"
            graph={{
              tiles: steps.map((t, i) => ({ ...t, state: tileState(i) })),
              links: steps.slice(1).map((t, i) => ({
                from: steps[i]?.id as string,
                to: t.id,
                state:
                  tileState(i + 1) === "pending" ? "pending" : tileState(i + 1) === "live" ? "live" : "done",
              })),
            }}
          />
          <p className="flex items-center gap-2 font-mono text-xs text-ink-3">
            {running ? "scanning" : "waiting for the worker"} ·{" "}
            {quietMin >= 15 ? `${quietMin} min so far: the worker may be busy or down` : "usually 1–5 min"} ·{" "}
            <AutoRefresh since={request.createdAt.toISOString()} />
          </p>
        </section>
      </>
    );
  }

  if (request.status === "failed")
    return (
      <>
        <RepoHeader name={name} />
        <section className="flex flex-col items-start gap-4 rounded-xl bg-sheet p-6 shadow-card">
          <BrokenFlow kind="error" />
          <p className="max-w-xl font-mono text-xs text-broke">
            {request.error ?? scan?.error ?? "unknown error"}
          </p>
          <Button asChild variant="outline">
            <Link href="/scan">Scan another repository</Link>
          </Button>
        </section>
      </>
    );

  const groups = groupFindings(report.findings);
  const b = bucketGroups(groups);
  const sha = scan?.sha ?? null;
  const coverage = scan?.coverage as {
    filesScanned?: number;
    languages?: string[];
    resolutionLevel?: string;
    advisoryStatus?: "complete" | "partial" | "unavailable";
    gaps?: string[];
  } | null;
  const runs = repo ? await dryRunsFor(repo.id, sha) : [];
  const runFor = new Map(runs.map((r) => [r.groupKey, r]));
  // Each group's dry run as the flow reads it (a dry run opens no PR, only its preview).
  const runOf = (g: FindingGroup) => {
    const run = runFor.get(g.key);
    if (!run) return undefined;
    const advisory = g.key.startsWith("advisory/") || g.changeIds.some((c) => c.includes("advisor"));
    return {
      id: run.id,
      status: run.status,
      proof: proofOfRun({
        kind: "dry_run",
        status: run.status,
        step: run.step,
        evidenceKind: run.evidenceKind,
        prMode: null,
        sites: g.sites.length,
        advisory,
        artifact: null,
        runHref: `/runs/${run.id}`,
      }),
    };
  };
  const deps = report.inventory.reduce((n, i) => n + i.direct + (i.transitive ?? 0), 0);
  const reaching = b.affected.length + b.human.length;
  const couldnt = [
    ...(coverage?.advisoryStatus && coverage.advisoryStatus !== "complete"
      ? [`Security advisories: ${coverage.advisoryStatus}`]
      : []),
    ...(coverage?.gaps ?? []),
  ];
  const flow = (g: FindingGroup, opts: { undecided?: boolean; action?: boolean } = {}) => (
    <FindingFlow
      key={g.key}
      group={g}
      repo={name}
      sha={sha}
      latest={runOf(g)}
      mode="auto"
      preview
      {...(opts.undecided ? { undecided: true } : {})}
      {...(opts.action
        ? { actions: <DryRun publicScanId={request.id} group={g} existing={runFor.get(g.key)} /> }
        : {})}
    />
  );

  return (
    <>
      <RepoHeader name={name} sha={sha} finishedAt={request.finishedAt} reportId={request.id} />

      <section className="flex flex-col gap-4 rounded-xl bg-sheet p-5 shadow-card">
        <StaticFlow
          label="What the scan found"
          graph={{
            tiles: [
              {
                id: "deps",
                entity: "update",
                state: "done",
                label: "Dependencies",
                meta: `${deps.toLocaleString()} read`,
              },
              {
                id: "files",
                entity: "code",
                state: "done",
                label: "Your code",
                ...(coverage?.filesScanned
                  ? { meta: `${coverage.filesScanned.toLocaleString()} files` }
                  : {}),
              },
              {
                id: "reach",
                entity: "change",
                state: reaching ? "not_proven" : "proven",
                label: reaching ? `${reaching} reaching` : "Nothing reaching",
                meta: `${groups.length} checked`,
              },
              {
                id: "dry",
                entity: "sandbox",
                state: runs.length ? "done" : "pending",
                label: "Dry runs",
                meta: String(runs.length),
              },
            ],
            links: [
              { from: "deps", to: "files", state: "done" },
              { from: "files", to: "reach", state: reaching ? "not_proven" : "proven" },
              { from: "reach", to: "dry", state: runs.length ? "done" : "pending" },
            ],
          }}
        />
        {report.inventory.length ? (
          <ul className="flex flex-wrap gap-2">
            {report.inventory.map((i) => {
              const e = ecosystemOf(i.ecosystem);
              return (
                <li
                  key={i.ecosystem}
                  className="flex items-center gap-2 rounded-full bg-sunken py-1 pr-3 pl-1.5 text-xs"
                  title={`${i.direct} direct${i.transitive ? `, ${i.transitive} transitive` : ""}`}
                >
                  <span className="flex size-5 items-center justify-center rounded-full bg-sheet">
                    {e ? <BrandLogo light={e.light} dark={e.dark} alt="" className="h-3 w-auto" /> : null}
                  </span>
                  <span className="text-ink">{e?.label ?? i.ecosystem}</span>
                  <span className="font-mono text-ink-3">{i.direct + (i.transitive ?? 0)}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {b.affected.length || b.undecided.length || b.human.length ? (
        <div className="flex flex-col gap-3">
          {b.affected.map((g) => flow(g, { action: true }))}
          {b.undecided.map((g) => flow(g, { undecided: true, action: true }))}
          {b.human.map((g) => flow(g))}
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
          <TileSquare tile={{ entity: "check", state: "proven", label: "" }} size="sm" />
          <span className="text-sm text-ink-2">Nothing Teire knows about reaches this code</span>
        </div>
      )}

      {couldnt.length || b.quiet.length || b.outside.length ? (
        <div className="flex flex-col gap-2">
          {couldnt.length ? (
            <Fold tone="attention" label="Couldn't check" count={couldnt.length}>
              <ul className="flex flex-col gap-1 p-4 text-sm text-ink-2">
                {couldnt.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </Fold>
          ) : null}
          {b.quiet.length || b.outside.length ? (
            <Fold tone="proven" label="Checked, not reaching" count={b.quiet.length + b.outside.length}>
              <ul className="divide-y divide-rule">
                {[...b.quiet, ...b.outside].map((g) => (
                  <li key={g.key} className="flex items-center gap-2.5 px-4 py-2">
                    <Mark brand={subjectMark(g.key)} size="sm" />
                    {g.changeIds[0] ? (
                      <Link
                        href={`/changes/${g.changeIds[0]}`}
                        className="min-w-0 truncate text-sm text-ink hover:underline"
                      >
                        {g.title}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate text-sm text-ink">{g.title}</span>
                    )}
                    {g.verdict === "not_applicable" ? (
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-3">
                        other versions
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Fold>
          ) : null}
        </div>
      ) : null}

      <section className="flex flex-col items-start justify-between gap-4 rounded-xl bg-hero p-6 text-hero-ink sm:flex-row sm:items-center">
        <div className="flex flex-col gap-3">
          <p className="display text-2xl">Get these as pull requests</p>
          <ul className="flex flex-wrap gap-2 font-mono text-[11px] text-hero-ink-2">
            <li className="rounded-full bg-white/10 px-2.5 py-1">rescans on push</li>
            <li className="rounded-full bg-white/10 px-2.5 py-1">one PR per change</li>
            <li className="rounded-full bg-white/10 px-2.5 py-1">ready when your checks pass</li>
          </ul>
        </div>
        <Button asChild variant="cta" size="xl" shape="pill">
          <a href={INSTALL_URL}>
            <GithubMark className="size-4" />
            Install on GitHub
          </a>
        </Button>
      </section>
    </>
  );
}

/** A folded list under the findings: a chip with its count that opens in place. */
function Fold({
  label,
  count,
  tone,
  children,
}: {
  label: string;
  count: number;
  tone: "attention" | "proven";
  children: React.ReactNode;
}) {
  return (
    <details className="group/fold overflow-hidden rounded-xl bg-sheet shadow-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className={cn("size-2 rounded-full", tone === "attention" ? "bg-attention" : "bg-proven")}
        />
        {label}
        <span className="font-mono text-xs text-ink-3">{count}</span>
        <ChevronDown
          aria-hidden
          className="ml-auto size-3.5 text-ink-3 transition-transform group-open/fold:rotate-180"
        />
      </summary>
      <div className="border-t border-rule">{children}</div>
    </details>
  );
}

function RepoHeader({
  name,
  sha,
  finishedAt,
  reportId,
}: {
  name: string;
  sha?: string | null;
  finishedAt?: Date | null;
  /** A finished report can be shared (plan revision 3.3, U5). */
  reportId?: string;
}) {
  return (
    <header className="flex flex-col gap-2">
      <p className="flex items-center justify-between gap-3 text-xs text-ink-3">
        <Link href="/scan" className="hover:text-ink">
          Public scan
        </Link>
        {reportId ? (
          <ShareLink
            path={`/scan/${reportId}`}
            title="Share this report"
            description="What changed upstream, where it reaches this repository's code, and a dry run per change."
            isPrivate={false}
            label="Share report"
            secondary={
              <Button asChild size="sm">
                <a href={INSTALL_URL}>Install Teire on it</a>
              </Button>
            }
          />
        ) : null}
      </p>
      <h1 className="heading flex flex-wrap items-center gap-3 text-3xl text-ink">
        <TileSquare tile={{ entity: "repository", state: "done", label: name }} size="sm" />
        <a href={`https://github.com/${name}`} className="hover:underline">
          {name}
        </a>
      </h1>
      {sha ? (
        <p className="font-mono text-xs text-ink-3">
          {sha.slice(0, 7)}
          {finishedAt ? ` · scanned ${finishedAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}
        </p>
      ) : null}
    </header>
  );
}

async function DryRun({
  publicScanId,
  group,
  existing,
}: {
  publicScanId: string;
  group: FindingGroup;
  existing?: { id: string; status: string; evidenceKind: string | null } | undefined;
}) {
  // A runtime's end of life is a notice: Teire never changes the runtime a repo runs on.
  if (group.key.startsWith("runtime/")) return null;
  if (existing)
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={`/runs/${existing.id}`}>
          <GitPullRequest data-icon="inline-start" />
          Its dry run
        </Link>
      </Button>
    );
  const session = await getSession();
  // The same daily limit the action and the worker apply (review R23).
  const spent = session
    ? (await usageToday(session.user.id)).dryRuns >= PUBLIC_LIMITS.dryRunsPerUserPerDay
    : false;
  // The limit is said where the action is (C2), never only in a tooltip (V5–V6 review).
  const limit = (
    <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[11px] text-ink-2">
      {PUBLIC_LIMITS.dryRunsPerUserPerDay} dry run a day
    </span>
  );
  if (!session)
    return (
      <span className="flex items-center gap-2">
        {limit}
        <SignInButton size="sm" next={`/scan/${publicScanId}`} label="Sign in to dry-run" />
      </span>
    );
  if (spent)
    return (
      <span className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-ink-2">
          Today&apos;s dry run is used · installed, Teire opens PRs
        </span>
        <Button size="sm" disabled>
          <FlaskConical data-icon="inline-start" />
          Used today
        </Button>
      </span>
    );
  return (
    <form action={startDryRun} className="flex items-center gap-2">
      <input type="hidden" name="publicScanId" value={publicScanId} />
      <input type="hidden" name="groupKey" value={group.key} />
      {limit}
      <Button type="submit" size="sm" title="Fix and verify it in a sandbox; no PR is opened">
        <FlaskConical data-icon="inline-start" />
        Dry-run a fix
      </Button>
    </form>
  );
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <div className="h-9 w-72 animate-pulse rounded-lg bg-sunken" />
      <div className="flex h-40 items-center justify-center rounded-xl bg-sheet shadow-card">
        <GhostFlow tiles={4} />
      </div>
    </div>
  );
}
