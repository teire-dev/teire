import { cn } from "@/lib/utils";

export interface Phase {
  key: string;
  label: string;
  ms: number | null;
  state: "done" | "live" | "failed" | "skipped" | "pending";
}

/** Rounded to whole seconds before minutes are taken, so 119.6 s reads "2m 0s", never "1m 60s". */
export const seconds = (ms: number | null) => {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

/**
 * Where a run's time went, one cell per phase (fal's request timing, adapted): queued, the updater,
 * the baseline, the fix, your checks after, the PR. Widths follow time, so the slow phase is obvious.
 */
export function PhaseStrip({ phases }: { phases: Phase[] }) {
  const total = phases.reduce((n, p) => n + Math.max(p.ms ?? 0, 0), 0) || 1;
  const BAR = {
    done: "bg-ink",
    live: "bg-signal animate-pulse",
    failed: "bg-broke",
    skipped: "bg-rule",
    pending: "bg-rule",
  } as const;
  return (
    <div className="flex flex-col gap-3">
      {/* One bar, each phase as wide as its share of the run. */}
      <div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full">
        {phases
          .filter((p) => (p.ms ?? 0) > 0)
          .map((p) => (
            <span
              key={p.key}
              title={`${p.label}: ${seconds(p.ms)}`}
              className={cn("h-full", BAR[p.state])}
              style={{ width: `${Math.max(((p.ms ?? 0) / total) * 100, 1.5)}%` }}
            />
          ))}
      </div>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-6">
        {phases.map((p) => (
          <div key={p.key} className="flex flex-col gap-0.5">
            <dt className="flex items-center gap-1.5 text-[11px] text-ink-3">
              <span className={cn("size-1.5 rounded-full", BAR[p.state])} />
              {p.label}
            </dt>
            <dd
              className={cn(
                "font-mono text-sm tabular-nums",
                p.state === "failed" ? "text-broke" : "text-ink",
              )}
            >
              {p.state === "skipped" ? "–" : seconds(p.ms)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
