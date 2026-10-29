"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Mark } from "@/components/teire/mark";
import { TextShimmer } from "@/components/ui/text-shimmer";
import type { Brand } from "@/lib/brands";

/** A run Teire is on right now: its mark, what it is doing (shimmering), and for how long. */
export function LiveRun({
  href,
  brand,
  repo,
  subject,
  doing,
  startedAt,
}: {
  href: string;
  brand: Brand;
  repo: string;
  subject: string;
  doing: string;
  startedAt: string | null;
}) {
  // Ticks on the client only: the server can't know the second the page is read.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs =
    startedAt && now ? Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000)) : null;
  const elapsed =
    secs === null
      ? ""
      : secs < 60
        ? `${secs}s`
        : secs < 3600
          ? `${Math.floor(secs / 60)}m ${secs % 60}s`
          : secs < 86_400
            ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
            : `${Math.floor(secs / 86_400)}d ${Math.floor((secs % 86_400) / 3600)}h`;
  return (
    <Link href={href} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover">
      <span className="relative">
        <Mark brand={brand} />
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-signal ring-2 ring-sheet animate-live" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-ink">{subject}</span>
        <span className="truncate font-mono text-[11px] text-ink-3">{repo}</span>
        <TextShimmer className="truncate text-xs" duration={2.2}>
          {doing}
        </TextShimmer>
      </span>
      <span className="font-mono text-xs text-ink-3 tabular-nums">{elapsed}</span>
    </Link>
  );
}
