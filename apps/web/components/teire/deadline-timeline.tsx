import { Mark } from "@/components/teire/mark";
import type { Brand } from "@/lib/brands";
import { cn } from "@/lib/utils";

export interface Deadline {
  id: string;
  title: string;
  date: Date;
  brand: Brand;
  repos: number;
}

const DAY = 86_400_000;
const MONTH = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Retirements and shutdowns your code still calls, on one rail: months along the bottom, today as a
 * line, each change a provider mark at its date. Passed ones are red, those within 90 days amber.
 */
export function DeadlineTimeline({ deadlines }: { deadlines: Deadline[] }) {
  const now = Date.now();
  const from = Math.min(now - 45 * DAY, ...deadlines.map((d) => d.date.getTime() - 20 * DAY));
  const to = Math.max(now + 120 * DAY, ...deadlines.map((d) => d.date.getTime() + 20 * DAY));
  const x = (t: number) => `${((t - from) / (to - from)) * 100}%`;
  const months: Date[] = [];
  // First of each month in UTC, the zone the labels are formatted in.
  const start = new Date(from);
  for (
    let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    d.getTime() <= to;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  )
    months.push(d);
  // Changes from one provider in the same week are one pin with a count, not a tower of marks.
  const pins = new Map<string, { id: string; date: Date; brand: Brand; items: Deadline[] }>();
  for (const d of deadlines) {
    const key = `${d.brand.label}:${Math.floor(d.date.getTime() / (7 * DAY))}`;
    const pin = pins.get(key) ?? { id: key, date: d.date, brand: d.brand, items: [] };
    pin.items.push(d);
    pins.set(key, pin);
  }
  // Pins that still share a week (different providers) sit side by side in lanes.
  const lanes = new Map<string, number>();
  const taken: { t: number; lane: number }[] = [];
  for (const p of [...pins.values()].sort((a, b) => a.date.getTime() - b.date.getTime())) {
    let lane = 0;
    while (taken.some((q) => q.lane === lane && Math.abs(q.t - p.date.getTime()) < 9 * DAY)) lane++;
    taken.push({ t: p.date.getTime(), lane });
    lanes.set(p.id, lane);
  }
  const pinList = [...pins.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  return (
    <>
      {/* Phones: the same pins as a list; a rail this narrow can't keep close dates apart. */}
      <ul className="flex flex-col divide-y divide-rule sm:hidden">
        {pinList.map((p) => {
          const days = Math.round((p.date.getTime() - now) / DAY);
          return (
            <li key={p.id} className="flex items-center gap-3 py-2.5">
              <Mark brand={p.brand} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-ink">{p.items.map((d) => d.title).join(", ")}</span>
                <span className="font-mono text-[11px] text-ink-3">{SHORT.format(p.date)}</span>
              </span>
              <span
                className={cn(
                  "font-mono text-xs",
                  days < 0 ? "text-broke" : days <= 90 ? "text-attention" : "text-ink-2",
                )}
              >
                {days < 0 ? `${-days}d ago` : `in ${days}d`}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="relative hidden h-36 w-full select-none sm:block">
        <div className="absolute inset-x-0 bottom-7 h-px bg-rule-strong" />
        {months.map((m) => (
          <span
            key={m.toISOString()}
            className="absolute bottom-0 font-mono text-[10px] text-ink-3 uppercase"
            style={{ left: x(m.getTime()) }}
          >
            <span className="absolute bottom-6 left-0 h-2 w-px bg-rule-strong" />
            <span className="pl-1">{MONTH.format(m)}</span>
          </span>
        ))}
        <span className="absolute top-2 bottom-7 w-px bg-signal" style={{ left: x(now) }} aria-hidden />
        <span
          className="absolute top-0 -translate-x-1/2 rounded-full bg-signal px-1.5 font-mono text-[10px] text-sheet"
          style={{ left: x(now) }}
        >
          today
        </span>
        {[...pins.values()].map((p, i) => {
          const days = Math.round((p.date.getTime() - now) / DAY);
          const passed = days < 0;
          const lane = lanes.get(p.id) ?? 0;
          const repos = Math.max(...p.items.map((d) => d.repos));
          return (
            // A pin is a focusable button that names what it holds, so the detail isn't hover-only (round 2).
            <button
              type="button"
              key={p.id}
              aria-label={`${p.items.map((d) => d.title).join("; ")}: ${passed ? `${-days} days ago` : `in ${days} days`}, ${repos} repo${repos === 1 ? "" : "s"}`}
              className="group absolute -translate-x-1/2 animate-enter cursor-default rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                left: x(p.date.getTime()),
                bottom: `${40 + lane * 64}px`,
                animationDelay: `${i * 60}ms`,
              }}
            >
              <span
                className={cn(
                  "absolute top-full left-1/2 h-2 w-px -translate-x-1/2",
                  passed ? "bg-broke" : days <= 90 ? "bg-attention" : "bg-rule-strong",
                )}
              />
              <span
                className={cn(
                  "relative block rounded-lg ring-2",
                  passed ? "ring-broke/50" : days <= 90 ? "ring-attention/50" : "ring-transparent",
                )}
              >
                <Mark brand={p.brand} size="lg" />
                {p.items.length > 1 ? (
                  <span className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-ink font-mono text-[9px] text-sheet">
                    {p.items.length}
                  </span>
                ) : null}
              </span>
              <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 font-mono text-[10px] whitespace-nowrap text-ink-2">
                {SHORT.format(p.date)}
              </span>
              <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-60 -translate-x-1/2 rounded-lg bg-ink p-2.5 text-xs text-sheet shadow-float group-hover:block group-focus-visible:block">
                {p.items.map((d) => (
                  <span key={d.id} className="block truncate font-medium">
                    {d.title}
                  </span>
                ))}
                <span className="mt-1 block font-mono text-[11px] opacity-70">
                  {passed ? `${-days} days ago` : `in ${days} days`} · {repos} repo{repos === 1 ? "" : "s"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
