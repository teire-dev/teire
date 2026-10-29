"use client";

import Link from "next/link";
import NumberTicker from "@/components/ui/number-ticker";
import { cn } from "@/lib/utils";

/** The count-up, kept stable so a re-render doesn't restart it. */
const COUNT = { duration: 1.1, ease: [0.22, 1, 0.36, 1] } as const;

/** One number that matters, counted up on arrival; the label is a mono eyebrow, nothing more. */
export function Kpi({
  label,
  value,
  tone = "ink",
  href,
  children,
}: {
  label: string;
  value: number;
  tone?: "ink" | "proven" | "attention" | "signal";
  /** The list this figure counts (a figure always leads to its own list). */
  href?: string;
  children?: React.ReactNode;
}) {
  const Box = href ? Link : "div";
  return (
    <Box
      href={href as string}
      className={cn("flex min-w-0 flex-col justify-between gap-3 bg-sheet p-4", href && "hover:bg-hover")}
    >
      <span className="eyebrow">{label}</span>
      <div className="flex items-end justify-between gap-3">
        <NumberTicker
          from={0}
          target={value}
          transition={COUNT}
          className={cn(
            "font-mono text-4xl leading-none font-medium tracking-tight tabular-nums",
            { ink: "text-ink", proven: "text-proven", attention: "text-attention", signal: "text-signal" }[
              tone
            ],
          )}
        />
        {children}
      </div>
    </Box>
  );
}
