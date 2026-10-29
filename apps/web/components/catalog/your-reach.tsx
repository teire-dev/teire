"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ReachFan } from "@/components/flow/reach-fan";
import { Mark } from "@/components/teire/mark";
import type { Brand } from "@/lib/brands";
import type { ChangeReach } from "@/lib/workspace";

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

/**
 * On a package page: the reader's repositories its open findings are in, as a fan from the package's
 * mark (plan revision 3.4, V5: "In your repositories as a fan-out"), each branch to its Findings.
 */
export function YourPackageReach({ pkg, brand }: { pkg: string; brand: Brand }) {
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
  const shown = repos.slice(0, 8);
  const ROW = 32;
  const h = shown.length * ROW;
  return (
    <section
      className="flex flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card ring-1 ring-broke/20"
      aria-label="In your repositories"
    >
      <h2 className="eyebrow">In your repositories</h2>
      <div className="flex items-center">
        <Mark brand={brand} />
        <svg width={56} height={h} viewBox={`0 0 56 ${h}`} aria-hidden className="shrink-0 overflow-visible">
          {shown.map((r, i) => {
            const y = i * ROW + ROW / 2;
            return (
              <path
                key={r.repo}
                d={`M0,${h / 2} C28,${h / 2} 28,${y} 56,${y}`}
                fill="none"
                stroke="var(--broke)"
                strokeOpacity={0.55}
                strokeWidth={1.5}
              />
            );
          })}
        </svg>
        <ul className="flex min-w-0 flex-col">
          {shown.map((r) => (
            <li key={r.repo} style={{ height: ROW }} className="flex items-center">
              <Link
                href={`/app/repos/${r.repo}/findings`}
                className="flex min-w-0 items-center gap-2 rounded-full bg-sheet py-1 pr-3 pl-2.5 text-xs ring-1 ring-rule hover:ring-rule-strong"
              >
                <span className="truncate font-mono text-ink">{r.repo}</span>
                <span className="shrink-0 rounded-full bg-broke-soft px-1.5 font-mono text-[11px] text-broke">
                  {r.groups}
                </span>
              </Link>
            </li>
          ))}
          {repos.length > shown.length ? (
            <li className="pl-2.5 font-mono text-[11px] text-ink-3">+{repos.length - shown.length}</li>
          ) : null}
        </ul>
      </div>
    </section>
  );
}

/**
 * On a change page, signed in: the change fanning out to each of the reader's repositories it reaches,
 * every branch in what Fix now would do there, and Fix in all when one would start (V5–V6 review).
 */
export function YourChangeReach({ changeId }: { changeId: string }) {
  const [reaches, setReaches] = useState<ChangeReach[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/app/reach?change=${encodeURIComponent(changeId)}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? (((await r.json()) as { reaches?: ChangeReach[] }).reaches ?? []) : []))
      .then((list) => alive && setReaches(list))
      .catch(() => alive && setReaches([]));
    return () => {
      alive = false;
    };
  }, [changeId]);
  if (!reaches?.length) return null;
  const runs = reaches.some((r) => r.plan.kind === "run");
  return (
    <section
      className="flex flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card ring-1 ring-broke/20"
      aria-label="In your repositories"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="eyebrow">In your repositories</h2>
        {runs ? (
          <Link
            href={`/app/changes?change=${encodeURIComponent(changeId)}`}
            className="text-xs font-medium text-ink hover:underline"
          >
            Fix in all ›
          </Link>
        ) : null}
      </div>
      <ReachFan reaches={reaches} />
    </section>
  );
}
