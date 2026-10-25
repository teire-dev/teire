import { PUBLIC_LIMITS } from "@teire/engine/constants";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { SignInButton } from "@/components/sign-in-button";
import { recentReports } from "@/lib/reports";
import { getSession } from "@/lib/session";
import { INSTALL_URL } from "@/lib/site";
import { ScanForm } from "./scan-form";

export const metadata = {
  title: "Scan a public repository",
  description:
    "See which package, API and model changes reach a public GitHub repository's code, then dry-run a fix: no install needed.",
};

export default function ScanPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-14">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Scan a public repository</h1>
        <p className="text-subtle">
          Teire reads its lockfiles, compares each dependency with the version it would upgrade to, checks the
          APIs and models its code calls, and lists the exact lines each change reaches. Then dry-run a fix on
          any affected finding: the same fix and sandbox verification as a pull request, without opening one.
        </p>
      </header>
      <section className="rounded-lg bg-card p-5 shadow-card">
        <Suspense fallback={<div className="h-[74px] animate-pulse rounded-md bg-muted" />}>
          <Gate />
        </Suspense>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Recent public reports</h2>
        <Suspense fallback={<div className="h-24 animate-pulse rounded-lg bg-muted" />}>
          <Recent />
        </Suspense>
      </section>
      <p className="text-sm text-muted-foreground">
        For private repositories, and for fixes as pull requests,{" "}
        <a href={INSTALL_URL} className="text-link hover:underline">
          install Teire on GitHub
        </a>
        .
      </p>
    </main>
  );
}

async function Gate() {
  const session = await getSession();
  if (session) return <ScanForm />;
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-subtle">
        Sign in with GitHub to start a scan. It keeps the service fair: {PUBLIC_LIMITS.scansPerUserPerDay}{" "}
        scans and {PUBLIC_LIMITS.dryRunsPerUserPerDay} dry run a day per person, and GitHub is read with your
        own rate limit. Teire asks for no repository access to do this.
      </p>
      <SignInButton next="/scan" label="Sign in with GitHub" />
    </div>
  );
}

async function Recent() {
  await connection();
  const rows = await recentReports();
  if (!rows.length)
    return <p className="text-sm text-muted-foreground">No public reports yet. Yours will be the first.</p>;
  return (
    <ul className="divide-y overflow-hidden rounded-lg bg-card shadow-card">
      {rows.map((r) => (
        <li key={r.id}>
          <Link
            href={`/scan/${r.id}`}
            className="row-link flex items-center justify-between gap-4 px-4 py-3 pr-10 text-sm hover:bg-accent"
          >
            <span className="truncate font-mono">{r.repo}</span>
            <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              <span className={r.affected ? "text-affected" : "text-clear"}>
                {r.affected ? `${r.affected} affected` : "nothing affected"}
              </span>
              <span className="hidden sm:inline">{r.finishedAt?.toISOString().slice(0, 10)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
