"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * "Reaches N of your repositories" on a public catalog row (plan revision 3.3, U5), for the signed-in
 * reader only. The page stays cached for everyone; one request fills every row rendered together.
 * The shared answer lives two seconds, never longer: a switch of installation (or a sign-out) between
 * pages must not show the previous scope's counts (V5–V6 review).
 */
const SHARED_MS = 2_000;
let pending: { at: number; reach: Promise<Record<string, number>> } | null = null;
const reachOnce = () => {
  if (!pending || Date.now() - pending.at > SHARED_MS)
    pending = {
      at: Date.now(),
      reach: fetch("/api/app/reach", { cache: "no-store" })
        .then(async (r) => (r.ok ? ((await r.json()) as { reach: Record<string, number> }).reach : {}))
        .catch(() => ({})),
    };
  return pending.reach;
};

export function YourReach({ changeId }: { changeId: string }) {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void reachOnce().then((reach) => alive && setN(reach[changeId] ?? 0));
    return () => {
      alive = false;
    };
  }, [changeId]);
  if (!n) return null;
  return (
    <Link
      href="/app/changes"
      className="rounded-full bg-broke-soft px-2 py-0.5 font-medium text-broke hover:underline"
    >
      Reaches {n} of your repositor{n === 1 ? "y" : "ies"}
    </Link>
  );
}

/** On a package page: which of the reader's repositories the package's open findings are in. */
export function YourPackageReach({ pkg }: { pkg: string }) {
  const [repos, setRepos] = useState<{ repo: string; groups: number }[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/app/reach?package=${encodeURIComponent(pkg)}`, { cache: "no-store" })
      .then(async (r) =>
        r.ok ? ((await r.json()) as { repos: { repo: string; groups: number }[] }).repos : [],
      )
      .then((list) => alive && setRepos(list))
      .catch(() => alive && setRepos([]));
    return () => {
      alive = false;
    };
  }, [pkg]);
  if (!repos?.length) return null;
  return (
    <section className="flex flex-col gap-2 rounded-lg bg-broke-soft/40 p-4 ring-1 ring-broke/20 ring-inset">
      <h2 className="text-sm font-medium">In your repositories</h2>
      <ul className="flex flex-wrap gap-2">
        {repos.map((r) => (
          <li key={r.repo}>
            <Link
              href={`/app/repos/${r.repo}/findings`}
              className="rounded-full bg-sheet px-2.5 py-1 font-mono text-xs text-ink ring-1 ring-rule ring-inset hover:ring-rule-strong"
            >
              {r.repo}
              <span className="ml-1.5 text-ink-3">
                {r.groups} change{r.groups === 1 ? "" : "s"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
