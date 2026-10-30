"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ReachFan } from "@/components/flow/reach-fan";
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

interface PackageUse {
  repo: string;
  version: string | null;
  direct: boolean;
  manifest: string;
  workspace: string;
  /** The upgrade that repository's latest scan plans for it. */
  planned: { to: string; security: boolean } | null;
}

/**
 * On a package page, signed in (revamp S3, the owner's "anything has to be useful"): where the reader
 * stands with this package. Each of their repositories that installs it, the version, how far behind
 * the latest release, direct or transitive, the manifest, and the open findings it has, each row to
 * that repository. Nothing for a reader with none of it.
 */
export function YourPackageUse({
  pkg,
  versions,
  latest,
}: {
  pkg: string;
  /** The package's releases, oldest first, to count how far behind each install is. */
  versions: string[];
  latest: string | null;
}) {
  const [data, setData] = useState<{
    uses: PackageUse[];
    repos: { repo: string; groups: number; advisories: number; others: number }[];
  } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/app/reach?package=${encodeURIComponent(pkg)}&uses=1`, { cache: "no-store" })
      .then(async (r) => (r.ok ? await r.json() : { uses: [], repos: [] }))
      .then((d) => alive && setData({ uses: d.uses ?? [], repos: d.repos ?? [] }))
      .catch(() => alive && setData({ uses: [], repos: [] }));
    return () => {
      alive = false;
    };
  }, [pkg]);
  if (!data?.uses.length) return null;
  const at = new Map(versions.map((v, i) => [v, i]));
  const top = latest ? at.get(latest) : undefined;
  const counts = new Map(data.repos.map((r) => [r.repo, r]));
  return (
    <section className="flex flex-col gap-2" aria-label="Where you stand">
      <h2 className="eyebrow">Where you stand</h2>
      <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
        {data.uses.map((u) => {
          const i = u.version ? at.get(u.version) : undefined;
          const behind = i !== undefined && top !== undefined ? Math.max(0, top - i) : null;
          const open = counts.get(u.repo)?.groups ?? 0;
          const advisories = counts.get(u.repo)?.advisories ?? 0;
          const others = counts.get(u.repo)?.others ?? 0;
          return (
            <li key={`${u.repo}:${u.manifest}:${u.version}`}>
              <Link
                href={`/app/repos/${u.repo}/${open ? "findings" : "inventory"}`}
                className="group grid grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-sm hover:bg-hover"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-[12.5px] text-link group-hover:underline">
                    {u.repo}
                  </span>
                  <span className="truncate font-mono text-[10.5px] text-ink-3" title={u.manifest}>
                    {u.direct ? "" : "transitive · "}
                    {u.manifest}
                  </span>
                </span>
                <span className="truncate font-mono text-xs text-ink">{u.version ?? "unresolved"}</span>
                <span className="font-mono text-[11px]">
                  {u.version && u.version === latest ? (
                    <span className="text-proven">current</span>
                  ) : behind ? (
                    <span className={behind > 20 ? "text-attention" : "text-ink-2"}>
                      {behind} release{behind === 1 ? "" : "s"} behind
                    </span>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </span>
                <span className="flex flex-wrap items-center justify-self-end gap-1 font-mono text-[11px]">
                  {/* What applies to the version installed there: its advisories, other findings, the planned upgrade. */}
                  {advisories ? (
                    <span className="rounded-full bg-broke-soft px-1.5 text-broke">
                      {advisories} advisor{advisories === 1 ? "y" : "ies"}
                    </span>
                  ) : null}
                  {others ? (
                    <span className="rounded-full bg-attention-soft px-1.5 text-attention">
                      {others} finding{others === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {u.planned ? (
                    <span className={u.planned.security ? "text-broke" : "text-ink-2"}>
                      → {u.planned.to} planned
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
