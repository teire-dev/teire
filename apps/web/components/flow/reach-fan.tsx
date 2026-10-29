import Link from "next/link";
import { reachState } from "@/components/app/change-fan";
import { Mark } from "@/components/teire/mark";
import { subjectMark } from "@/lib/marks";
import type { ChangeReach } from "@/lib/workspace";

/**
 * Where a change reaches, as the fan Changes for you draws (B13): its mark branching to each
 * repository, every branch in what Fix now would do there.
 */
export function ReachFan({ reaches }: { reaches: ChangeReach[] }) {
  const shown = reaches.slice(0, 6);
  const more = reaches.length - shown.length;
  const ROW = 26;
  const h = Math.max(shown.length + (more ? 1 : 0), 1) * ROW;
  const brand = subjectMark(shown[0]?.groupKey);
  const STROKE: Record<string, string> = {
    done: "color-mix(in oklab, var(--ink) 45%, transparent)",
    live: "var(--signal)",
    pending: "var(--ink-3)",
    skipped: "var(--rule-strong)",
  };
  return (
    <div className="flex items-center" data-flow>
      <Mark brand={brand} />
      <svg width={40} height={h} viewBox={`0 0 40 ${h}`} aria-hidden className="shrink-0 overflow-visible">
        {shown.map((r, i) => {
          const y = i * ROW + ROW / 2;
          const st = reachState(r);
          return (
            <path
              key={`${r.repo}:${r.groupKey}`}
              d={`M0,${h / 2} C20,${h / 2} 20,${y} 40,${y}`}
              fill="none"
              stroke={STROKE[st] ?? STROKE.pending}
              strokeWidth={1.5}
              strokeDasharray={st === "pending" || st === "skipped" ? "4 4" : undefined}
            />
          );
        })}
      </svg>
      <ul className="flex min-w-0 flex-1 flex-col">
        {shown.map((r) => {
          const p = r.plan;
          const said =
            p.kind === "open"
              ? `#${p.number}`
              : p.kind === "running"
                ? "running"
                : p.kind === "off"
                  ? "off"
                  : p.kind === "paused"
                    ? "paused"
                    : p.waits
                      ? "waits"
                      : `${r.sites} site${r.sites === 1 ? "" : "s"}`;
          return (
            <li key={`${r.repo}:${r.groupKey}`} style={{ height: ROW }} className="flex items-center">
              <Link
                href={`/app/repos/${r.repo}/findings?group=${encodeURIComponent(r.groupKey)}`}
                className="flex min-w-0 items-center gap-1.5 rounded-full bg-sheet py-0.5 pr-2 pl-2 text-[11px] ring-1 ring-rule"
              >
                <span className="truncate text-ink">{r.repo.split("/")[1]}</span>
                <span className="shrink-0 font-mono text-[11px] text-ink-3">{said}</span>
              </Link>
            </li>
          );
        })}
        {more ? (
          <li style={{ height: ROW }} className="flex items-center pl-2 font-mono text-[11px] text-ink-3">
            +{more}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
