"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { Boxes, ChevronRight, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { ECOSYSTEMS } from "@/lib/brands";
import { packageHref } from "@/lib/links";
import { cn } from "@/lib/utils";

export interface InventoryRow {
  id: string;
  ecosystem: string;
  name: string;
  version: string | null;
  workspace: string | null;
  manifest: string;
  direct: boolean;
  /** Where it installs from: only a public registry package has a public page. */
  source: string;
  latest: string | null;
  behind: number | null;
  advisories: number;
  findings: number;
  planned: { to: string; security: boolean } | null;
}

const ROW_PX = 40;
const COLS = "grid-cols-[minmax(0,2.2fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,1fr)_16px]";

/** How much a row needs a person: advisories, then findings, then a planned upgrade, then distance behind. */
const risk = (r: InventoryRow) =>
  r.advisories * 1000 + r.findings * 100 + (r.planned ? 10 : 0) + Math.min(9, (r.behind ?? 0) / 10);

/**
 * The inventory (revamp S3, the owner's "what is the purpose of this inventory?"): what this repository
 * depends on and which of it needs you. Risky rows first (advisories on the installed version, open
 * findings, a planned upgrade, how far behind latest); direct dependencies by default, transitive on a
 * toggle. A registry package opens its page; a workspace, git or path dependency has none.
 */
export function InventoryTable({
  rows,
  ecosystems,
}: {
  rows: InventoryRow[];
  ecosystems: { key: string; label: string; count: number }[];
}) {
  const [eco, setEco] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [transitive, setTransitive] = useState(false);
  const direct = rows.filter((r) => r.direct).length;
  const shown = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            (transitive || r.direct || r.advisories > 0) &&
            (!eco || r.ecosystem === eco) &&
            (!q || r.name.toLowerCase().includes(q.toLowerCase())),
        )
        .sort((a, b) => risk(b) - risk(a) || a.name.localeCompare(b.name)),
    [rows, eco, q, transitive],
  );
  const needs = rows.filter((r) => r.advisories || r.findings).length;
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: shown.length,
    getScrollElement: () => parent.current,
    estimateSize: () => ROW_PX,
    overscan: 12,
  });
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <legend className="sr-only">Ecosystem</legend>
        {[{ key: null, label: "All", count: rows.length }, ...ecosystems].map((e) => {
          const brand = e.key ? ECOSYSTEMS[e.key] : undefined;
          return (
            <button
              key={e.key ?? "all"}
              type="button"
              onClick={() => setEco(e.key)}
              aria-pressed={eco === e.key}
              className={cn(
                "flex items-center gap-2.5 rounded-xl bg-sheet p-2.5 text-left shadow-tile ring-1 ring-rule transition-shadow hover:shadow-card",
                eco === e.key && "ring-2 ring-ink",
              )}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sunken">
                {brand ? (
                  <BrandLogo light={brand.light} dark={brand.dark} alt="" className="h-5 w-auto" />
                ) : (
                  <Boxes className="size-4 text-ink-2" aria-hidden />
                )}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-xs text-ink-2">{e.label}</span>
                <span className="font-mono text-sm text-ink tabular-nums">{e.count}</span>
              </span>
            </button>
          );
        })}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-ink-2">
          {needs ? (
            <>
              <span className="font-medium text-broke">{needs}</span> need{needs === 1 ? "s" : ""} you ·
              listed first
            </>
          ) : (
            "Nothing here needs you"
          )}
        </p>
        <label className="ml-auto flex items-center gap-2 font-mono text-[11px] text-ink-2">
          <input
            type="checkbox"
            checked={transitive}
            onChange={(e) => setTransitive(e.target.checked)}
            className="size-3.5 accent-[var(--ink)]"
          />
          Show transitive ({rows.length - direct})
        </label>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a package"
          aria-label="Find a package"
          className="h-8 w-48 rounded-md bg-sheet px-2.5 text-sm ring-1 ring-rule ring-inset outline-none focus-visible:ring-signal"
        />
      </div>
      <div className="overflow-hidden rounded-xl bg-sheet shadow-card">
        <div
          className={cn("grid gap-3 border-b border-rule px-4 py-2 font-mono text-[11px] text-ink-3", COLS)}
        >
          <span>package</span>
          <span>installed</span>
          <span>latest</span>
          <span>needs you</span>
          <span>planned</span>
          <span />
        </div>
        <div ref={parent} className="max-h-[600px] overflow-auto">
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((v) => {
              const r = shown[v.index] as InventoryRow;
              const href = r.source === "registry" ? packageHref(r.ecosystem, r.name) : null;
              const cells = (
                <>
                  <span className="flex min-w-0 flex-col">
                    <span
                      className={cn(
                        "truncate font-mono text-[12.5px]",
                        href ? "text-link group-hover/row:underline" : "text-ink",
                      )}
                    >
                      {r.name}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
                      {r.direct ? null : (
                        <span className="rounded bg-sunken px-1 text-ink-3">transitive</span>
                      )}
                      {r.source !== "registry" ? (
                        <span className="rounded bg-sunken px-1">{r.source}</span>
                      ) : null}
                      <span className="truncate" title={r.manifest}>
                        {r.manifest}
                      </span>
                    </span>
                  </span>
                  <span
                    className={cn("truncate font-mono text-xs", r.version ? "text-ink" : "text-attention")}
                  >
                    {r.version ?? "unresolved"}
                  </span>
                  <span className="flex min-w-0 flex-col font-mono text-xs">
                    <span className="truncate text-ink-2">{r.latest ?? "—"}</span>
                    {r.behind ? (
                      <span className={cn("text-[10.5px]", r.behind > 20 ? "text-attention" : "text-ink-3")}>
                        {r.behind} behind
                      </span>
                    ) : r.latest && r.version === r.latest ? (
                      <span className="text-[10.5px] text-proven">current</span>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
                    {r.advisories ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-broke-soft px-1.5 text-broke">
                        <ShieldAlert className="size-3" aria-hidden />
                        {r.advisories} advisor{r.advisories === 1 ? "y" : "ies"}
                      </span>
                    ) : null}
                    {r.findings ? (
                      <span className="rounded-full bg-attention-soft px-1.5 text-attention">
                        {r.findings} finding{r.findings === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate font-mono text-[11px]">
                    {r.planned ? (
                      <span className={r.planned.security ? "text-broke" : "text-ink-2"}>
                        → {r.planned.to}
                      </span>
                    ) : null}
                  </span>
                  {href ? (
                    <ChevronRight className="size-4 text-ink-3 group-hover/row:text-ink" aria-hidden />
                  ) : (
                    <span />
                  )}
                </>
              );
              const row = cn(
                "group/row absolute inset-x-0 grid items-center gap-3 border-b border-rule px-4",
                COLS,
              );
              const style = { height: ROW_PX, transform: `translateY(${v.start}px)` };
              return href ? (
                <Link key={r.id} href={href} className={cn(row, "hover:bg-hover")} style={style}>
                  {cells}
                </Link>
              ) : (
                <div key={r.id} className={row} style={style}>
                  {cells}
                </div>
              );
            })}
          </div>
          {!shown.length ? (
            <p className="px-4 py-6 text-center text-sm text-ink-3">
              {rows.length && !transitive ? "No direct dependency matches." : "No dependency matches."}
            </p>
          ) : null}
        </div>
      </div>
      <p className="font-mono text-[11px] text-ink-3">
        Latest and how far behind come from the registry where Teire has read it; “—” where it hasn&apos;t
        yet.
      </p>
    </div>
  );
}
