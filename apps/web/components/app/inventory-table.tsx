"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { Boxes } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { ECOSYSTEMS } from "@/lib/brands";
import { cn } from "@/lib/utils";

export interface InventoryRow {
  id: string;
  ecosystem: string;
  name: string;
  version: string | null;
  scope: string | null;
  workspace: string | null;
  direct: boolean;
}

const ROW_PX = 32;

/** The inventory (plan revision 3.3, U3): every dependency, virtualized, filtered by ecosystem and name. */
export function InventoryTable({
  rows,
  ecosystems,
}: {
  rows: InventoryRow[];
  ecosystems: { key: string; label: string; count: number }[];
}) {
  const [eco, setEco] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const shown = useMemo(
    () =>
      rows.filter(
        (r) => (!eco || r.ecosystem === eco) && (!q || r.name.toLowerCase().includes(q.toLowerCase())),
      ),
    [rows, eco, q],
  );
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
      <div className="flex">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a package"
          aria-label="Find a package"
          className="ml-auto h-8 w-48 rounded-md bg-sheet px-2.5 text-sm ring-1 ring-rule ring-inset outline-none focus-visible:ring-signal"
        />
      </div>
      <div className="overflow-hidden rounded-xl bg-sheet shadow-card">
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] border-b border-rule px-4 py-2 font-mono text-[11px] text-ink-3">
          <span>package</span>
          <span>version</span>
          <span>scope</span>
          <span>workspace</span>
        </div>
        <div ref={parent} className="max-h-[560px] overflow-auto">
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((v) => {
              const r = shown[v.index] as InventoryRow;
              return (
                <div
                  key={r.id}
                  className="absolute inset-x-0 grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center border-b border-rule px-4 font-mono text-xs"
                  style={{ height: ROW_PX, transform: `translateY(${v.start}px)` }}
                >
                  <span className="truncate">
                    <Link
                      href={`/packages/${r.ecosystem}/${r.name.split("/").map(encodeURIComponent).join("/")}`}
                      className="text-ink hover:underline"
                    >
                      {r.name}
                    </Link>
                    {r.direct ? null : <span className="text-ink-3"> (transitive)</span>}
                  </span>
                  <span className={r.version ? "truncate text-ink-2" : "text-attention"}>
                    {r.version ?? "unresolved"}
                  </span>
                  <span className="truncate text-ink-3">{r.scope}</span>
                  <span className="truncate text-ink-3">{r.workspace}</span>
                </div>
              );
            })}
          </div>
          {!shown.length ? (
            <p className="px-4 py-6 text-center text-sm text-ink-3">No dependency matches.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
