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
  /** Open advisories and other findings on this installed copy. */
  advisories: number;
  others: number;
  /** What the API changes from this version to the planned one (else the latest), where computed. */
  api: { to: string; counts: Record<string, number>; href: string | null } | null;
}

/** The API changes that can break a caller, in the words the change pages use. */
const API_SAID: [string, string][] = [
  ["removed", "removed"],
  ["signature-changed", "changed"],
  ["required-added", "now required"],
  ["deprecated", "deprecated"],
];

/**
 * On a package page, signed in (revamp S3, the owner's "anything has to be useful"): where the reader
 * stands with this package. Each installed copy in their repositories: the version, how far behind
 * the latest release, direct or transitive, the manifest, the open findings on that copy, the planned
 * upgrade, and what the API changes on the way there, each linked. Nothing for a reader with none of it.
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
  const [uses, setUses] = useState<PackageUse[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/app/reach?package=${encodeURIComponent(pkg)}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? await r.json() : { uses: [] }))
      .then((d) => alive && setUses(d.uses ?? []))
      .catch(() => alive && setUses([]));
    return () => {
      alive = false;
    };
  }, [pkg]);
  if (!uses?.length) return null;
  const at = new Map(versions.map((v, i) => [v, i]));
  const top = latest ? at.get(latest) : undefined;
  return (
    <section className="flex flex-col gap-2" aria-label="Where you stand">
      <h2 className="eyebrow">Where you stand</h2>
      <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
        {uses.map((u) => {
          const i = u.version ? at.get(u.version) : undefined;
          const behind = i !== undefined && top !== undefined ? Math.max(0, top - i) : null;
          const api = u.api
            ? API_SAID.filter(([k]) => u.api?.counts[k]).map(
                ([k, said]) => `${(u.api?.counts[k] ?? 0).toLocaleString("en")} ${said}`,
              )
            : [];
          return (
            <li
              key={`${u.repo}:${u.manifest}:${u.version}`}
              className="group relative flex flex-col gap-1.5 px-4 py-2.5 text-sm hover:bg-hover sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-3"
            >
              <span className="flex min-w-0 flex-col">
                {/* The row opens the repository; the API chip below is its own link, raised above. */}
                <Link
                  href={`/app/repos/${u.repo}/${u.advisories || u.others ? "findings" : "inventory"}`}
                  className="truncate font-mono text-[12.5px] text-link after:absolute after:inset-0 group-hover:underline"
                >
                  {u.repo}
                </Link>
                <span className="truncate font-mono text-[10.5px] text-ink-3" title={u.manifest}>
                  {u.direct ? "" : "transitive · "}
                  {u.manifest}
                </span>
              </span>
              {/* On a phone the version and how far behind share a line; from sm they are grid cells. */}
              <span className="flex items-baseline gap-3 sm:contents">
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
              </span>
              <span className="flex flex-wrap items-center gap-1 font-mono text-[11px] sm:justify-self-end">
                {/* What applies to the version installed there: its advisories, other findings, the planned
                    upgrade, and what its API changes on the way. */}
                {u.advisories ? (
                  <span className="rounded-full bg-broke-soft px-1.5 text-broke">
                    {u.advisories} advisor{u.advisories === 1 ? "y" : "ies"}
                  </span>
                ) : null}
                {u.others ? (
                  <span className="rounded-full bg-attention-soft px-1.5 text-attention">
                    {u.others} finding{u.others === 1 ? "" : "s"}
                  </span>
                ) : null}
                {u.planned ? (
                  <span className={u.planned.security ? "text-broke" : "text-ink-2"}>
                    → {u.planned.to} planned
                  </span>
                ) : null}
                {u.api && api.length ? (
                  u.api.href ? (
                    <Link
                      href={u.api.href}
                      title={`What the API changes from ${u.version} to ${u.api.to}`}
                      className="relative z-10 rounded-full bg-sunken px-1.5 text-ink-2 ring-1 ring-rule ring-inset hover:text-ink hover:ring-rule-strong"
                    >
                      API → {u.api.to}: {api.join(" · ")} ›
                    </Link>
                  ) : (
                    <span className="rounded-full bg-sunken px-1.5 text-ink-2">
                      API → {u.api.to}: {api.join(" · ")}
                    </span>
                  )
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
