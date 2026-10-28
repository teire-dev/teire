"use client";

import NumberTicker from "@/components/ui/number-ticker";
import { cn } from "@/lib/utils";

/** One number that matters, counted up on arrival; the label is a mono eyebrow, nothing more. */
export function Kpi({
  label,
  value,
  tone = "ink",
  children,
}: {
  label: string;
  value: number;
  tone?: "ink" | "proven" | "attention" | "signal";
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col justify-between gap-3 bg-sheet p-4">
      <span className="eyebrow">{label}</span>
      <div className="flex items-end justify-between gap-3">
        <NumberTicker
          from={0}
          target={value}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "font-mono text-4xl leading-none font-medium tracking-tight tabular-nums",
            { ink: "text-ink", proven: "text-proven", attention: "text-attention", signal: "text-signal" }[
              tone
            ],
          )}
        />
        {children}
      </div>
    </div>
  );
}
