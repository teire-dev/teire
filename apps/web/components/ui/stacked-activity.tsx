"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * From 21st.dev (eugeneshilow, Stacked Activity Bars, id 29474), on Teire's tokens: the grid, axis
 * and ink from the theme; a `prefix` for values that carry one (dollars); no fixed minimum width,
 * so it fits a phone.
 *
 * StackedActivityBars — interactive stacked daily columns in the
 * OpenRouter-Activity genre: what makes up each day's volume, and how it
 * breathes day to day. Each column is a stack of segments (e.g. prompt /
 * completion); on the right sits a live legend: hovering a day shows its
 * date and per-segment values, and with no hover the legend holds the last
 * day. With `partialLast` the final column is hatched — the day is not
 * complete yet (data honesty). No tooltip needed: the legend IS the tooltip.
 *
 * Motion: stacks grow from the baseline with a stagger on viewport entry
 * (IntersectionObserver adds vsb-enter); the hovered day gets a track band
 * highlight. Everything is disabled under prefers-reduced-motion. Structural
 * tones come through var(--vz-*); no glow — column mass is not a signal.
 *
 * Props:
 * - days: string[] — ISO dates, one per day (needs >= 5)
 * - segments: StackSegment[] — stack segments bottom-up; each carries its
 *   own color (color follows the entity) and a values[] aligned with days
 * - unit?: string — value unit shown in legend and ticks: 'B', 'M', 'K'
 * - note?: string — explanatory line under the legend
 * - partialLast?: boolean — hatch the last column as an incomplete day
 * - partialNote?: string — label next to the date for the partial day
 *
 * Client component: serializable props only; all coordinates through r2().
 */

const r2 = (v: number) => Math.round(v * 100) / 100;

export type StackSegment = {
  key: string;
  /** legend name: 'Prompt' */
  label: string;
  color: string;
  /** value for each day, in display units (e.g. billions) */
  values: number[];
};

/** clean tick step from {1, 2, 2.5, 5}×10^k, <= maxTicks divisions */
function niceStep(max: number, maxTicks = 5): number {
  if (max <= 0) return 1;
  const bases = [1, 2, 2.5, 5];
  for (let exp = -2; exp <= 12; exp++) {
    for (const b of bases) {
      const step = b * 10 ** exp;
      if (max / step <= maxTicks) return step;
    }
  }
  return max;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1] ?? ""} ${Number(d)}, ${y}`;
};
const fmtTick = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1] ?? ""} ${Number(d)}`;
};

const W = 960;
const H = 360;
const PAD = { top: 24, right: 14, bottom: 34, left: 48 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const MOTION_CSS = `
.vsb-col { transition: opacity .15s ease; }
.vsb-band { transition: opacity .15s ease; }
.vsb-enter .vsb-col { transform-box: fill-box; transform-origin: center bottom; animation: vsb-grow .7s cubic-bezier(.2,.7,.3,1) both; animation-delay: var(--vsb-d, 0ms); }
@keyframes vsb-grow { from { transform: scaleY(0); } }
@media (prefers-reduced-motion: reduce) {
  .vsb-enter .vsb-col { animation: none !important; }
  .vsb-col, .vsb-band { transition: none !important; }
}
`;

export function StackedActivityBars({
  days,
  segments,
  unit = "",
  note,
  partialLast = true,
  partialNote = "partial day",
  prefix = "",
}: {
  /** ISO dates, one per day */
  days: string[];
  /** stack segments bottom-up; values aligned with days */
  segments: StackSegment[];
  /** value unit in legend and ticks: 'B', 'M', 'K' */
  unit?: string;
  /** explanatory line under the legend: what each segment means */
  note?: string;
  /** last column is an incomplete day: hatch + label */
  partialLast?: boolean;
  partialNote?: string;
  /** what goes before a value in the legend and ticks ("$"); `unit` goes after */
  prefix?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [entered, setEntered] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const patternId = useId();

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setEntered(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setEntered(true);
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  const n = days.length;
  const geometry = useMemo(() => {
    const totals = days.map((_, i) => segments.reduce((a, s) => a + (s.values[i] ?? 0), 0));
    const rawMax = Math.max(...totals, 1);
    const step = niceStep(rawMax * 1.04);
    const yMax = step * Math.ceil((rawMax * 1.04) / step);
    const ticks: number[] = [];
    for (let t = step; t <= yMax; t += step) ticks.push(r2(t));
    return { totals, yMax, ticks };
  }, [days, segments]);

  if (n < 5 || !segments.length) return null;
  const { yMax, ticks } = geometry;

  const slot = PLOT_W / n;
  const barW = r2(Math.min(slot * 0.74, 26));
  const cx = (i: number) => r2(PAD.left + slot * i + slot / 2);
  const sy = (v: number) => r2(PAD.top + (1 - v / yMax) * PLOT_H);
  const hMul = (v: number) => r2((v / yMax) * PLOT_H);
  const fmt = (v: number) =>
    `${prefix}${v >= 100 ? Math.round(v) : v >= 10 ? r2(v).toFixed(1) : r2(v).toFixed(2)}${unit}`;

  const xTickEvery = Math.max(1, Math.round(n / 6));
  // With no hover the legend holds the latest day that has anything, not an empty today.
  const latest = geometry.totals.findLastIndex((t) => t > 0);
  const focusIndex = hover ?? (latest >= 0 ? latest : n - 1);

  return (
    <div ref={rootRef} className={entered ? "vsb-enter" : ""}>
      <style>{MOTION_CSS}</style>
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <div className="min-w-0 flex-[1_1_380px]">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${segments.map((s) => s.label).join(" + ")} per day; the arrow keys move the day`}
            // Keyboard: the arrows move the pinned day, as hovering does, and the legend follows.
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              setHover((h) => {
                const at = h ?? focusIndex;
                return Math.min(n - 1, Math.max(0, at + (e.key === "ArrowRight" ? 1 : -1)));
              });
            }}
            onBlur={() => setHover(null)}
            onPointerLeave={() => setHover(null)}
            className="w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            <defs>
              <pattern
                id={patternId}
                width="7"
                height="7"
                patternTransform="rotate(45)"
                patternUnits="userSpaceOnUse"
              >
                <line x1="0" y1="0" x2="0" y2="7" stroke="var(--rule-strong)" strokeWidth="3" />
              </pattern>
            </defs>

            {/* grid + Y ticks */}
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.left}
                  y1={sy(t)}
                  x2={W - PAD.right}
                  y2={sy(t)}
                  stroke="var(--rule)"
                  strokeWidth="1"
                />
                <text x={PAD.left - 8} y={sy(t) + 4} textAnchor="end" fontSize="12" fill="var(--ink-3)">
                  {`${prefix}${t}${unit}`}
                </text>
              </g>
            ))}
            <line
              x1={PAD.left}
              y1={sy(0)}
              x2={W - PAD.right}
              y2={sy(0)}
              stroke="var(--rule-strong)"
              strokeWidth="1"
            />

            {/* hovered-day highlight band */}
            {hover !== null ? (
              <rect
                className="vsb-band"
                x={r2(cx(hover) - slot / 2 + 1)}
                y={PAD.top}
                width={r2(slot - 2)}
                height={PLOT_H}
                fill="var(--hover)"
              />
            ) : null}

            {/* stacks */}
            {days.map((day, i) => {
              let acc = 0;
              const isPartial = partialLast && i === n - 1;
              return (
                <g
                  key={day}
                  className="vsb-col"
                  style={{ ["--vsb-d" as string]: `${i * 14}ms` }}
                  opacity={isPartial ? 0.6 : 1}
                >
                  {segments.map((s) => {
                    const v = s.values[i] ?? 0;
                    acc += v;
                    const h = hMul(v);
                    if (h <= 0) return null;
                    return (
                      <rect
                        key={s.key}
                        x={r2(cx(i) - barW / 2)}
                        y={sy(acc)}
                        width={barW}
                        height={h}
                        fill={s.color}
                      />
                    );
                  })}
                  {isPartial ? (
                    <rect
                      x={r2(cx(i) - barW / 2)}
                      y={sy(acc)}
                      width={barW}
                      height={hMul(acc)}
                      fill={`url(#${patternId})`}
                      opacity="0.55"
                    />
                  ) : null}
                </g>
              );
            })}

            {/* X ticks */}
            {days.map((day, i) =>
              i % xTickEvery === 0 && i <= n - 2 ? (
                <text
                  key={`t${day}`}
                  x={cx(i)}
                  y={H - PAD.bottom + 22}
                  textAnchor="middle"
                  fontSize="12"
                  fill="var(--ink-3)"
                >
                  {fmtTick(day)}
                </text>
              ) : null,
            )}

            {/* invisible per-day hover zones */}
            {days.map((day, i) => (
              <rect
                key={`h${day}`}
                x={r2(PAD.left + slot * i)}
                y={PAD.top}
                width={r2(slot)}
                height={PLOT_H}
                fill="transparent"
                onPointerEnter={() => setHover(i)}
              />
            ))}
          </svg>
          {/* The same figures as a table, for screen readers. */}
          <table className="sr-only">
            <thead>
              <tr>
                <th scope="col">Day</th>
                {segments.map((s) => (
                  <th key={s.key} scope="col">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={d}>
                  <th scope="row">{fmtDay(d)}</th>
                  {segments.map((s) => (
                    <td key={s.key}>{fmt(s.values[i] ?? 0)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* live legend: it is the tooltip */}
        <div className="w-[220px] shrink-0 [font-variant-numeric:tabular-nums]">
          <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
            {fmtDay(days[focusIndex])}
            {partialLast && focusIndex === n - 1 ? (
              <span className="text-[11px] font-normal text-[var(--ink-3)]">· {partialNote}</span>
            ) : null}
          </p>
          <div className="mt-3 space-y-2.5">
            {segments.map((s) => (
              <p key={s.key} className="flex items-center gap-2.5 text-[13.5px]">
                <span
                  aria-hidden
                  className="inline-block h-[10px] w-[10px] rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-ink-2">{s.label}</span>
                <span className="ml-auto font-semibold text-ink">{fmt(s.values[focusIndex] ?? 0)}</span>
              </p>
            ))}
          </div>
          {note ? <p className="mt-5 text-[12.5px] leading-5 text-ink-3">{note}</p> : null}
        </div>
      </div>
    </div>
  );
}
