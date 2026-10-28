import { FlaskConical, GitPullRequest, Loader } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { BrandLogo } from "@/components/brand-logo";
import { FindingGroupCard } from "@/components/findings/finding-group";
import { GithubMark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ecosystemOf } from "@/lib/brands";
import { bucketGroups, type FindingGroup, groupFindings } from "@/lib/findings";
import { dryRunsFor, publicReport } from "@/lib/reports";
import { getSession } from "@/lib/session";
import { INSTALL_URL } from "@/lib/site";
import { startDryRun } from "../actions";

export async function generateMetadata({ params }: PageProps<"/scan/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: `Scan report ${id.slice(0, 8)}`, robots: { index: false } };
}

/** A public scan report (C9): findings grouped as Teire opens PRs, a dry run per affected group. */
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
  const { id } = await params;
  const report = await publicReport(id);
  if (!report) notFound();
  const { request, scan, repo } = report;
  const name = repo?.fullName ?? request.repoFullName;

  if (request.status === "queued" || request.status === "running")
    return (
      <>
        <RepoHeader name={name} />
        <section className="flex flex-col gap-4 rounded-lg bg-card p-6 shadow-card" aria-live="polite">
          <p className="flex items-center gap-2 font-medium">
            <Loader className="size-4 animate-spin text-running" aria-hidden />
            {request.status === "queued" ? "Waiting for the worker" : "Scanning"} ·{" "}
            <AutoRefresh since={request.createdAt.toISOString()} />
          </p>
          <ol className="flex flex-col gap-2 text-sm text-muted-foreground">
            <li>Downloading the repository at its default branch</li>
            <li>Reading every manifest and lockfile, and the exact versions they pin</li>
            <li>Comparing each dependency's API with the version it would upgrade to</li>
            <li>Checking the API hosts and model IDs the code calls against their providers' pages</li>
            <li>Finding the lines each change reaches</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            Most repositories take one to five minutes. This page updates by itself.
          </p>
        </section>
      </>
    );

  if (request.status === "failed")
    return (
      <>
        <RepoHeader name={name} />
        <section className="flex flex-col items-start gap-3 rounded-lg bg-card p-6 shadow-card">
          <p className="font-medium">The scan did not finish</p>
          <p className="text-sm text-muted-foreground">{request.error ?? scan?.error ?? "Unknown error."}</p>
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

  return (
    <>
      <RepoHeader name={name} sha={sha} finishedAt={request.finishedAt} />

      <section className="grid gap-px overflow-hidden rounded-lg bg-border shadow-card sm:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-3 bg-card p-5">
          <p className="text-xs text-muted-foreground">Dependencies read</p>
          {report.inventory.length ? (
            <ul className="flex flex-wrap gap-x-6 gap-y-3">
              {report.inventory.map((i) => {
                const e = ecosystemOf(i.ecosystem);
                return (
                  <li key={i.ecosystem} className="flex items-center gap-2 text-sm">
                    {e ? <BrandLogo light={e.light} dark={e.dark} alt="" className="h-4" /> : null}
                    <span>{e?.label ?? i.ecosystem}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {i.direct} direct{i.transitive ? ` · ${i.transitive} transitive` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No manifest or lockfile Teire reads was found.</p>
          )}
          {coverage?.filesScanned ? (
            <p className="font-mono text-xs text-muted-foreground">
              {coverage.filesScanned} files searched
              {coverage.languages?.length ? ` · ${coverage.languages.join(", ")}` : ""}
              {coverage.resolutionLevel ? ` · ${coverage.resolutionLevel}-level resolution` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col justify-center gap-1 bg-card p-5">
          <p
            className={`text-3xl font-semibold tabular-nums ${b.affected.length ? "text-affected" : "text-clear"}`}
          >
            {b.affected.length}
          </p>
          <p className="text-sm text-muted-foreground">
            change{b.affected.length === 1 ? "" : "s"} reaching this code
            {b.human.length ? ` · ${b.human.length} for a person to decide` : ""}
          </p>
        </div>
      </section>

      {coverage?.gaps?.length ? (
        <section className="flex flex-col gap-2 rounded-lg bg-card p-5 shadow-card">
          <h2 className="text-sm font-medium">
            What Teire could not check
            {coverage.advisoryStatus && coverage.advisoryStatus !== "complete"
              ? ` · advisories ${coverage.advisoryStatus}`
              : ""}
          </h2>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {coverage.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {b.deadlines.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Deadlines</h2>
          <ul className="divide-y overflow-hidden rounded-lg bg-card text-sm shadow-card">
            {b.deadlines.slice(0, 8).map((g) => {
              const row = (
                <>
                  <span className="truncate">{g.title}</span>
                  <span className="shrink-0 font-mono text-xs text-human">{g.deadline?.slice(0, 10)}</span>
                </>
              );
              return (
                <li key={g.key}>
                  {g.changeIds[0] ? (
                    <Link
                      href={`/changes/${g.changeIds[0]}`}
                      className="row-link flex items-center justify-between gap-4 px-4 py-2.5 pr-10 hover:bg-accent"
                    >
                      {row}
                    </Link>
                  ) : (
                    <div className="flex items-center justify-between gap-4 px-4 py-2.5">{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <Section
        title="Affected"
        count={b.affected.length}
        empty="Nothing Teire knows about reaches this code right now."
      >
        {b.affected.map((g) => (
          <FindingGroupCard
            key={g.key}
            group={g}
            repo={name}
            sha={sha}
            action={<DryRun publicScanId={request.id} group={g} existing={runFor.get(g.key)} />}
          />
        ))}
      </Section>

      {b.undecided.length ? (
        <Section title="Decided in the sandbox" count={b.undecided.length}>
          <p className="text-sm text-muted-foreground">
            The code alone doesn&apos;t settle these: some references could not be resolved. A dry run
            upgrades and runs this repo&apos;s checks before and after; that result decides.
          </p>
          {b.undecided.map((g) => (
            <FindingGroupCard
              key={g.key}
              group={g}
              repo={name}
              sha={sha}
              action={<DryRun publicScanId={request.id} group={g} existing={runFor.get(g.key)} />}
            />
          ))}
        </Section>
      ) : null}

      {b.human.length ? (
        <Section title="Needs a person" count={b.human.length}>
          {b.human.map((g) => (
            <FindingGroupCard key={g.key} group={g} repo={name} sha={sha} />
          ))}
        </Section>
      ) : null}

      {b.quiet.length || b.outside.length ? (
        <details className="group rounded-lg bg-card shadow-card">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm">
            <span className="font-medium">Checked, not reaching this code</span>{" "}
            <span className="text-muted-foreground">
              · {b.quiet.length} change{b.quiet.length === 1 ? "" : "s"}
              {b.outside.length ? ` · ${b.outside.length} outside the installed versions` : ""}
            </span>
          </summary>
          <div className="flex flex-col gap-3 border-t p-4">
            {[...b.quiet, ...b.outside].map((g) => (
              <FindingGroupCard key={g.key} group={g} repo={name} sha={sha} />
            ))}
          </div>
        </details>
      ) : null}

      <section className="flex flex-col items-start justify-between gap-4 rounded-lg bg-card p-5 shadow-card sm:flex-row sm:items-center">
        <div>
          <p className="font-medium">Get these as pull requests</p>
          <p className="text-sm text-muted-foreground">
            Installed, Teire rescans when a push to your default branch changes dependencies or code, and
            opens a pull request per change, ready once your own checks pass before and after.{" "}
            <Link href="/docs/guide/how-it-works" className="text-link hover:underline">
              How Teire works
            </Link>
          </p>
        </div>
        <Button asChild shape="pill">
          <a href={INSTALL_URL}>
            <GithubMark className="size-4" />
            Install on GitHub
          </a>
        </Button>
      </section>
    </>
  );
}

function RepoHeader({
  name,
  sha,
  finishedAt,
}: {
  name: string;
  sha?: string | null;
  finishedAt?: Date | null;
}) {
  return (
    <header className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        <Link href="/scan" className="entity-link hover:text-foreground">
          Public scan
        </Link>
      </p>
      <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
        <a href={`https://github.com/${name}`} className="font-mono entity-link">
          {name}
        </a>
      </h1>
      {sha ? (
        <p className="font-mono text-xs text-muted-foreground">
          {sha.slice(0, 7)}
          {finishedAt ? ` · scanned ${finishedAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}
        </p>
      ) : null}
    </header>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">
        {title} <span className="text-muted-foreground">({count})</span>
      </h2>
      {count ? children : <p className="text-sm text-muted-foreground">{empty}</p>}
    </section>
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
  if (group.key.startsWith("runtime/"))
    return (
      <span className="text-xs text-muted-foreground">A notice: Teire does not change runtimes for you.</span>
    );
  if (existing)
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={`/runs/${existing.id}`}>
          <GitPullRequest data-icon="inline-start" />
          See the dry run ({existing.evidenceKind?.replace(/_/g, " ") ?? existing.status})
        </Link>
      </Button>
    );
  const session = await getSession();
  return (
    <form action={startDryRun} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="publicScanId" value={publicScanId} />
      <input type="hidden" name="groupKey" value={group.key} />
      <Button type="submit" size="sm" disabled={!session}>
        <FlaskConical data-icon="inline-start" />
        Dry-run a fix
      </Button>
      <span className="text-xs text-muted-foreground">
        {session
          ? "Fix and verify in a sandbox, no PR opened."
          : "Sign in with GitHub to dry-run a fix (one a day)."}
      </span>
    </form>
  );
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      <div className="h-28 animate-pulse rounded-lg bg-muted" />
      <div className="h-40 animate-pulse rounded-lg bg-muted" />
      <div className="h-40 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
