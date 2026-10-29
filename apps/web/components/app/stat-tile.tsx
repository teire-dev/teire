"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import NumberTicker from "@/components/ui/number-ticker";
import { cn } from "@/lib/utils";

/** The count-up, kept stable so a re-render doesn't restart it. */
const COUNT = { duration: 1.1, ease: [0.22, 1, 0.36, 1] } as const;

/** Below this many active days a line says nothing, so it isn't drawn (plan 3.4, B11: never faked). */
const MIN_ACTIVE_DAYS = 3;

type Tone = "ink" | "proven" | "attention" | "signal";
const TEXT: Record<Tone, string> = {
  ink: "text-ink",
  proven: "text-proven",
  attention: "text-attention",
  signal: "text-signal",
};
const LINE: Record<Tone, string> = {
  ink: "var(--ink-2)",
  proven: "var(--proven)",
  attention: "var(--attention)",
  signal: "var(--signal)",
};

function Spark({ series, tone }: { series: number[]; tone: Tone }) {
  const id = useId();
  const w = 112;
  const h = 32;
  const max = Math.max(...series, 1);
  const step = w / Math.max(series.length - 1, 1);
  const pts = series.map((v, i) => [i * step, h - 2 - (v / max) * (h - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts.at(-1) ?? [w, h];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden className="shrink-0 overflow-visible">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={LINE[tone]} stopOpacity="0.22" />
          <stop offset="1" stopColor={LINE[tone]} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={LINE[tone]} strokeWidth={1.6} strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={LINE[tone]} />
    </svg>
  );
}

/**
 * One figure that matters (21st Stats card 4403, adapted): the name, the number counted up, what
 * happened in the last seven days, and a fourteen-day line when there is enough to draw. The whole
 * tile goes to the list it counts.
 */
export function StatTile({
  label,
  value,
  tone = "ink",
  href,
  series,
  week,
}: {
  label: string;
  value: number;
  tone?: Tone;
  href: string;
  /** What happened each day, oldest first. */
  series: number[];
  /** The last seven days' figure in words ("+3 this week"); omitted when nothing happened. */
  week?: string | null;
}) {
  const drawn = series.filter((v) => v > 0).length >= MIN_ACTIVE_DAYS;
  return (
    <Link
      href={href}
      className="group relative flex min-w-0 flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
    >
      <span className="flex items-start justify-between gap-2">
        <span className="truncate text-[13px] text-ink-2">{label}</span>
        <ArrowUpRight
          aria-hidden
          className="size-3.5 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-ink"
        />
      </span>
      <span className="flex items-end justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-1">
          <NumberTicker
            from={0}
            target={value}
            transition={COUNT}
            className={cn(
              "font-mono text-[2rem] leading-none font-medium tracking-tight tabular-nums",
              TEXT[tone],
            )}
          />
          <span className="h-4 truncate font-mono text-[11px] text-ink-3">{week ?? ""}</span>
        </span>
        {drawn ? <Spark series={series} tone={tone} /> : null}
      </span>
    </Link>
  );
}
