import { PUBLIC_LIMITS } from "@teire/engine/constants";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { StaticFlow } from "@/components/flow/static-flow";
import { TileSquare } from "@/components/flow/tile";
import { GithubMark } from "@/components/icons";
import { SignInButton } from "@/components/sign-in-button";
import { recentReports } from "@/lib/reports";
import { getSession } from "@/lib/session";
import { INSTALL_URL } from "@/lib/site";
import { ago } from "@/lib/time";
import { ScanForm } from "./scan-form";

export const metadata = {
  title: "Scan a public repository",
  description:
    "See which package, API and model changes reach a public GitHub repository's code, then dry-run a fix: no install needed.",
};

/** What a scan does, as the flow a report then fills in. */
const STEPS = [
  { id: "repo", entity: "repository", label: "The repository", meta: "default branch" },
  { id: "deps", entity: "update", label: "Manifests", meta: "exact versions" },
  { id: "apis", entity: "change", label: "API changes", meta: "per upgrade" },
  { id: "providers", entity: "change", label: "Providers", meta: "hosts and models" },
  { id: "lines", entity: "code", label: "Your lines", meta: "what each reaches" },
  { id: "dry", entity: "sandbox", label: "Dry-run a fix", meta: "no PR opened" },
] as const;

/**
 * Scan a public repository (plan revision 3.4, V5): the form on the graphite band with its limits as
 * chips, what a scan does as a flow, and recent reports as cards.
 */
export default function ScanPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-10">
      <section className="relative overflow-hidden rounded-feature bg-hero p-6 text-hero-ink sm:p-10">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_60%_at_85%_0%,var(--hero-2),transparent)] opacity-80"
        />
        <div className="relative flex flex-col gap-6">
          <h1 className="display text-5xl">Scan a repo</h1>
          <ul className="flex flex-wrap gap-2 font-mono text-[11px] text-hero-ink-2">
            <li className="rounded-full bg-white/10 px-2.5 py-1">public repos</li>
            <li className="rounded-full bg-white/10 px-2.5 py-1">no install</li>
            <li className="rounded-full bg-white/10 px-2.5 py-1">
              {PUBLIC_LIMITS.scansPerUserPerDay} scans · {PUBLIC_LIMITS.dryRunsPerUserPerDay} dry run a day
            </li>
          </ul>
          <Suspense fallback={<div className="h-12 animate-pulse rounded-full bg-white/10" />}>
            <Gate />
          </Suspense>
        </div>
      </section>
      <section className="rounded-xl bg-sheet p-5 shadow-card">
        <StaticFlow
          size="sm"
          label="What a scan does"
          graph={{
            tiles: STEPS.map((t) => ({ ...t, state: "done" as const })),
            links: STEPS.slice(1).map((t, i) => ({
              from: STEPS[i]?.id as string,
              to: t.id,
              state: "done" as const,
            })),
          }}
        />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="heading text-xl text-ink">Recent reports</h2>
        <Suspense fallback={<div className="h-28 animate-pulse rounded-xl bg-sheet shadow-card" />}>
          <Recent />
        </Suspense>
      </section>
      <a href={INSTALL_URL} className="flex w-fit items-center gap-2 text-sm text-ink-2 hover:text-ink">
        <GithubMark className="size-4" />
        Private repos and fixes as PRs: install Teire ›
      </a>
    </main>
  );
}

async function Gate() {
  const session = await getSession();
  if (session) return <ScanForm />;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SignInButton next="/scan" label="Sign in with GitHub to scan" />
      <span className="font-mono text-[11px] text-hero-ink-2">no repository access asked</span>
    </div>
  );
}

async function Recent() {
  await connection();
  const rows = await recentReports();
  if (!rows.length)
    return (
      <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
        <TileSquare tile={{ entity: "repository", state: "pending", label: "" }} size="sm" />
        <span className="text-sm text-ink-2">No public reports yet</span>
      </div>
    );
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {rows.map((r) => (
        <li key={r.id}>
          <Link
            href={`/scan/${r.id}`}
            className="flex h-full flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card transition-shadow hover:shadow-card-hover"
          >
            <span className="flex items-center gap-2.5">
              <TileSquare
                tile={{ entity: "repository", state: r.affected ? "not_proven" : "proven", label: r.repo }}
                size="sm"
                className="!size-9"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-ink">{r.repo.split("/")[1]}</span>
                <span className="truncate font-mono text-[11px] text-ink-3">{r.repo.split("/")[0]}</span>
              </span>
            </span>
            <span className="mt-auto flex items-center justify-between font-mono text-[11px]">
              <span className={r.affected ? "text-attention" : "text-proven"}>
                {r.affected ? `${r.affected} reaching` : "nothing reaching"}
              </span>
              <span className="text-ink-3">{r.finishedAt ? ago(r.finishedAt) : ""}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
