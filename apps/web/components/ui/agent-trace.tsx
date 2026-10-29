"use client";

import { Bot, CircleAlert, Cpu, FileText, Pause, Play, Wrench, Zap } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

/** What produced the span. Drives the icon and whether the bar uses the accent color. */
export type SpanKind = "agent" | "model" | "tool" | "io";

/** How the span finished. `cached` means it returned without doing the work. */
export type SpanStatus = "ok" | "error" | "cached";

export interface TraceSpan {
  /** Stable id. Used for React keys and for `parentId` links. */
  id: string;
  /** Tool, model or sub-agent name, e.g. `search_docs`. Rendered in the name gutter. */
  label: string;
  /** Start offset in milliseconds from the beginning of the run. */
  start: number;
  /** End offset in milliseconds. For a span still in flight, pass the current time. */
  end: number;
  /** Defaults to `"tool"`. `agent` and `model` spans are drawn in the theme's primary color. */
  kind?: SpanKind;
  /** Defaults to `"ok"`. `error` draws the bar in the destructive color. */
  status?: SpanStatus;
  /** Id of the span this one runs inside. Children are indented under their parent. */
  parentId?: string;
  /** One-line result shown on the right once the span finishes, e.g. `"12 matches"`. */
  detail?: string;
  /** Tokens billed to this span. Counts up as the span replays; shown instead of `detail`. */
  tokens?: number;
  /** Attempt number. Anything above 1 renders a `×n` retry chip next to the label. */
  attempt?: number;
}

export interface AgentTraceProps extends React.ComponentProps<"div"> {
  /** The run. Order is derived from `start` and `parentId`, so the array can be in any order. */
  spans: TraceSpan[];
  /** Total run length in milliseconds. Defaults to the largest `end` in `spans`. */
  duration?: number;
  /** Run identifier shown in the header, e.g. `run_7c41f2`. */
  runId?: string;
  /** Model or agent name shown next to the run id. */
  model?: string;
  /** Playhead position in milliseconds. Changing it seeks. Reduced motion pins it to the end of the run. */
  defaultTime?: number;
  /** Start replaying on mount. Ignored under `prefers-reduced-motion`. */
  autoPlay?: boolean;
  /** Restart after the run finishes. Off by default: a finished run is the best-looking resting state. */
  loop?: boolean;
  /** Playback rate. 1 replays the run in real time. */
  speed?: number;
  /** Pause at the end of the run before looping, in milliseconds. */
  holdMs?: number;
  /** Show the time ruler and its gridlines. */
  showRuler?: boolean;
  /** Show the play button, the scrub rail and the clock. */
  showTransport?: boolean;
  /** Show token counts for spans that carry them. */
  showTokens?: boolean;
  /** Width of the name gutter in pixels, used once the card itself is at least 448px wide. */
  labelWidth?: number;
  /** Height of one span row in pixels. */
  rowHeight?: number;
  /** Called when a row is activated. The playhead also seeks to that span's start. */
  onSpanSelect?: (span: TraceSpan) => void;
  /** The run is still going: its last recorded span is not its end, so it never reads "Completed". */
  live?: boolean;
  /**
   * The playhead, reported about ten times a second while it moves (plan revision 3.4, B5: one clock,
   * so the run canvas and the inspector follow the replay).
   */
  onTime?: (ms: number) => void;
}

interface LaidSpan extends TraceSpan {
  depth: number;
  dur: number;
}

interface RowHandle {
  el: HTMLElement;
  meta: HTMLElement | null;
  dur: HTMLElement | null;
  status: HTMLElement | null;
  span: LaidSpan;
  lastP: number;
  lastState: string;
  lastMeta: string;
  lastDur: string;
}

const KIND_ICON = { agent: Bot, model: Cpu, tool: Wrench, io: FileText } as const;
const NICE_TICKS = [50, 100, 250, 500, 1000, 2000, 2500, 5000, 10_000, 30_000, 60_000];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : Math.min(v, hi));

/** Deterministic thousands separator — `toLocaleString` differs between server and client. */
const groupDigits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const formatMs = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;

/**
 * What the result column says. Tokens win when a span has them and `showTokens` is on, because they
 * are the number that makes a run legible as an agent run; `detail` is both the fallback for spans
 * without tokens and what the whole column shows when `showTokens` is off. Either way a result only
 * appears once the playhead has finished the span — you do not know the answer before it returns.
 */
const metaText = (span: LaidSpan, progress: number, showTokens: boolean) =>
  span.tokens != null && showTokens
    ? `${groupDigits(Math.round(span.tokens * progress))} tk`
    : progress >= 1
      ? (span.detail ?? "")
      : "";

const STATUS_WORD = { queued: "queued", running: "running", done: "succeeded", error: "failed" } as const;

/** The row's status in words, for the screen-reader-only line. Shared so the first render and the
 *  playhead loop can never disagree. */
const statusWord = (span: LaidSpan, state: keyof typeof STATUS_WORD) =>
  state === "done" && span.status === "cached" ? "served from cache" : STATUS_WORD[state];

/** Layout runs in the browser only, where useLayoutEffect avoids a frame of the finished run. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/** Flatten spans into rows: children under their parent, siblings by start time; cycles and orphans tolerated. */
function layout(spans: TraceSpan[]): LaidSpan[] {
  const children = new Map<string, TraceSpan[]>();
  const ids = new Set(spans.map((s) => s.id));
  for (const s of spans) {
    const key = s.parentId && s.parentId !== s.id && ids.has(s.parentId) ? s.parentId : "";
    const list = children.get(key);
    if (list) list.push(s);
    else children.set(key, [s]);
  }
  const out: LaidSpan[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number) => {
    for (const kid of (children.get(parent) ?? []).slice().sort((a, b) => a.start - b.start)) {
      if (seen.has(kid.id)) continue;
      seen.add(kid.id);
      out.push({ ...kid, depth, dur: Math.max(0, kid.end - kid.start) });
      walk(kid.id, depth + 1);
    }
  };
  walk("", 0);
  for (const s of spans) if (!seen.has(s.id)) out.push({ ...s, depth: 0, dur: Math.max(0, s.end - s.start) });
  return out;
}

interface TraceSpanRowProps {
  span: LaidSpan;
  /** Position in the flattened run, used as the key into the loop's row table. */
  index: number;
  /** Total run length, so the bar can be positioned as a percentage of the timeline. */
  total: number;
  showTokens: boolean;
  selected: boolean;
  onSelect: (span: LaidSpan) => void;
  /** Hands the playhead loop the elements it writes to each frame. */
  register: (index: number, handle: RowHandle | null) => void;
}

/**
 * One span. Renders its finished state so the markup is complete without JavaScript; the loop then
 * rewrites `--p`, `data-state` and the two numbers to whatever the playhead says.
 */
export const TraceSpanRow = React.memo(function TraceSpanRow({
  span,
  index,
  total,
  showTokens,
  selected,
  onSelect,
  register,
}: TraceSpanRowProps) {
  const Icon = KIND_ICON[span.kind ?? "tool"];
  const accent = span.kind === "agent" || span.kind === "model";
  const settled = span.status === "error" ? "error" : "done";
  const left = `${(span.start / total) * 100}%`;
  const width = `${(span.dur / total) * 100}%`;

  return (
    <div
      ref={(node) => {
        register(
          index,
          node
            ? {
                el: node,
                meta: node.querySelector<HTMLElement>("[data-part='meta']"),
                dur: node.querySelector<HTMLElement>("[data-part='dur']"),
                status: node.querySelector<HTMLElement>("[data-part='status']"),
                span,
                lastP: 1,
                lastState: settled,
                lastMeta: metaText(span, 1, showTokens),
                lastDur: span.dur === 0 ? "" : formatMs(span.dur),
              }
            : null,
        );
      }}
      data-slot="trace-span"
      data-state={settled}
      data-selected={selected ? "true" : undefined}
      style={{ "--p": 1 } as React.CSSProperties}
      className={cn(
        "group/row relative flex h-[var(--row)] items-center px-[var(--pad)] transition-colors duration-150",
        "data-[selected=true]:bg-muted/40 data-[state=running]:bg-muted/60",
      )}
    >
      {/* Guide rail: one hairline per ancestor, so a sub-agent's children read as inside it. */}
      {span.depth > 0 && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-[var(--pad)]">
          {Array.from({ length: span.depth }, (_, d) => (
            <span
              key={d}
              className="bg-border absolute inset-y-0 w-px"
              style={{ left: `${d * 12 + 11}px` }}
            />
          ))}
        </div>
      )}

      {/* The live status in words. The loop rewrites it, so a screen reader never hears a row
          claim it succeeded while the playhead still has it queued. */}
      <span data-part="status" className="sr-only">
        {statusWord(span, settled)}
      </span>

      {/* Name gutter. Clicking a name seeks the playhead to that span. */}
      <button
        type="button"
        data-slot="trace-span-label"
        onClick={() => onSelect(span)}
        aria-label={`${span.label}, ${span.kind ?? "tool"}, ${formatMs(span.dur)}${
          span.attempt != null && span.attempt > 1 ? `, attempt ${span.attempt}` : ""
        }`}
        className="hover:bg-muted focus-visible:ring-ring/50 flex w-[var(--gutter)] shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left outline-none focus-visible:ring-[3px]"
        style={{ paddingLeft: `${span.depth * 12 + 4}px` }}
      >
        <Icon
          aria-hidden="true"
          className={cn(
            "text-muted-foreground group-data-[state=queued]/row:text-muted-foreground/60 size-3.5 shrink-0 transition-colors duration-200",
            accent && "group-data-[state=done]/row:text-primary group-data-[state=running]/row:text-primary",
          )}
        />
        {/* Queued rows step down in hue rather than opacity: 40% foreground would be ~2.8:1. */}
        <span className="text-foreground group-data-[state=queued]/row:text-muted-foreground truncate font-mono text-xs transition-colors duration-200">
          {span.label}
        </span>
        {span.attempt != null && span.attempt > 1 && (
          <span className="border-border text-muted-foreground shrink-0 rounded-md border px-1 font-mono text-[10px] leading-4 tabular-nums">
            ×{span.attempt}
          </span>
        )}
      </button>

      {/* Timeline column: the span's full extent as a ghost, filled up to the playhead. */}
      <div className="relative h-full flex-1">
        <div
          className="absolute top-1/2 h-2 min-w-[3px] -translate-y-1/2 overflow-hidden rounded-full"
          style={{ left, width }}
        >
          <span aria-hidden="true" className="bg-foreground/10 absolute inset-0" />
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-0 origin-left",
              span.status === "error"
                ? "bg-destructive"
                : accent
                  ? "bg-primary"
                  : span.status === "cached"
                    ? "bg-foreground/25"
                    : "bg-foreground/50",
            )}
            style={{ transform: "scaleX(var(--p,1))" }}
          />
        </div>
      </div>

      {/* Result column: what it returned, and how long it took. */}
      <div className="group-data-[state=queued]/row:opacity-0 flex w-[var(--meta)] shrink-0 items-center justify-end gap-1.5 pl-2 transition-opacity duration-200">
        {span.status === "error" && (
          <CircleAlert aria-hidden="true" className="text-destructive size-3.5 shrink-0" />
        )}
        {span.status === "cached" && (
          <Zap aria-hidden="true" className="text-muted-foreground size-3 shrink-0" />
        )}
        <span
          data-part="meta"
          className="text-muted-foreground @md/trace:inline hidden truncate font-mono text-[11px] tabular-nums"
        >
          {metaText(span, 1, showTokens)}
        </span>
        <span
          data-part="dur"
          className={cn(
            "shrink-0 font-mono text-[11px] tabular-nums",
            span.status === "error" ? "text-destructive" : "text-foreground/70",
          )}
        >
          {span.dur === 0 ? "" : formatMs(span.dur)}
        </span>
      </div>
    </div>
  );
});

/**
 * AgentTrace — an agent run on a time axis that you can scrub.
 *
 * Drag the timeline (or the rail below it) and the run replays: bars fill, statuses flip from queued to
 * running to done, token counts tick up, and scrubbing backwards un-runs it. Nested sub-agents indent,
 * parallel tool calls overlap, retries carry a `×n` chip. Every visual is derived from one playhead
 * time, so the component keeps no per-span state and writes one CSS variable per row per frame.
 *
 * Use it wherever a product has to answer "what did the agent actually do": run history, debug drawers,
 * shared traces. Pass `spans` and it renders — no chart library, no chat framework.
 */
export function AgentTrace({
  spans,
  duration,
  runId = "run",
  model,
  defaultTime = 0,
  autoPlay = true,
  loop = false,
  speed = 1,
  holdMs = 900,
  showRuler = true,
  showTransport = true,
  showTokens = true,
  labelWidth = 200,
  rowHeight = 34,
  onSpanSelect,
  live = false,
  onTime,
  className,
  style,
  ref,
  ...rest
}: AgentTraceProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const railRef = React.useRef<HTMLDivElement>(null);
  const clockRef = React.useRef<HTMLSpanElement>(null);
  const statusRef = React.useRef<HTMLSpanElement>(null);
  const rowsRef = React.useRef<(RowHandle | null)[]>([]);
  const timeRef = React.useRef(defaultTime);
  const onTimeRef = React.useRef(onTime);
  onTimeRef.current = onTime;
  const playingRef = React.useRef(false);
  const seekRef = React.useRef<(ms: number) => void>(() => {});
  const runRef = React.useRef<() => void>(() => {});
  const haltRef = React.useRef<() => void>(() => {});
  const [playing, setPlaying] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);

  const rows = React.useMemo(() => layout(spans), [spans]);
  const total = React.useMemo(
    () => Math.max(1, duration ?? rows.reduce((max, s) => Math.max(max, s.end), 0)),
    [rows, duration],
  );
  const ticks = React.useMemo(() => {
    const step = NICE_TICKS.find((t) => total / t <= 8) ?? total / 4;
    const out: number[] = [];
    for (let t = step; t < total; t += step) out.push(t);
    return out;
  }, [total]);

  // The loop reads props through this ref, so knobs apply live without restarting it. Written in an
  // effect rather than during render: effects still run before the browser paints the next frame.
  const opts = React.useRef({ loop, speed, holdMs, showTokens, total, live });
  useIsomorphicLayoutEffect(() => {
    opts.current = { loop, speed, holdMs, showTokens, total, live };
  });

  const registerRow = React.useCallback((index: number, handle: RowHandle | null) => {
    rowsRef.current[index] = handle;
  }, []);

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let last = 0;
    let holdUntil = 0;
    let onScreen = true;
    let ariaAt = -1;

    let lastT = "";
    let lastRun = "";
    let reported = -1;
    let reportedAt = 0;
    const paint = () => {
      const t = timeRef.current;
      // One clock for the page: tell the run canvas where the playhead is, at most ~10 times a second.
      if (onTimeRef.current && t !== reported) {
        const at = performance.now();
        if (at - reportedAt > 95 || t >= opts.current.total || t === 0) {
          reported = t;
          reportedAt = at;
          onTimeRef.current(t);
        }
      }
      const o = opts.current;
      const ratio = (t / o.total).toFixed(5);
      if (ratio !== lastT) {
        root.style.setProperty("--t", ratio);
        lastT = ratio;
      }

      for (const row of rowsRef.current) {
        if (!row) continue;
        const { span } = row;
        const p = span.dur > 0 ? clamp((t - span.start) / span.dur, 0, 1) : t >= span.start ? 1 : 0;
        if (p !== row.lastP) {
          row.el.style.setProperty("--p", p.toFixed(4));
          row.lastP = p;
        }
        const state =
          t < span.start ? "queued" : p < 1 ? "running" : span.status === "error" ? "error" : "done";
        if (state !== row.lastState) {
          row.el.dataset.state = state;
          if (row.status) row.status.textContent = statusWord(span, state);
          row.lastState = state;
        }
        // An instant (a PR opened, an event without a measured length) shows no duration.
        const dur = state === "queued" || span.dur === 0 ? "" : formatMs(span.dur * p);
        if (row.dur && dur !== row.lastDur) {
          row.dur.textContent = dur;
          row.lastDur = dur;
        }
        const meta = state === "queued" ? "" : metaText(span, p, o.showTokens);
        if (row.meta && meta !== row.lastMeta) {
          row.meta.textContent = meta;
          row.lastMeta = meta;
        }
      }

      // The transport clock is a timecode: one fixed precision on both sides so digits do not jitter.
      if (clockRef.current)
        clockRef.current.textContent = `${(t / 1000).toFixed(2)}s / ${(o.total / 1000).toFixed(2)}s`;
      // The chip describes the run at the playhead, not the transport: at 6.4s of a 10.4s run the
      // agent was still working, whether or not the replay happens to be paused.
      const runState = t >= o.total && !o.live ? "complete" : "running";
      if (runState !== lastRun) {
        root.dataset.run = runState;
        if (statusRef.current)
          statusRef.current.textContent = runState === "complete" ? "Completed" : "Running";
        lastRun = runState;
      }

      // Only announce a value the user asked for: ten announcements a second while the run plays
      // would be a wall of speech on a focusable slider.
      const rail = playingRef.current ? null : railRef.current;
      const decis = Math.round(t / 100);
      if (rail && decis !== ariaAt) {
        ariaAt = decis;
        rail.setAttribute("aria-valuenow", String(Math.round(t)));
        rail.setAttribute("aria-valuetext", `${formatMs(t)} of ${formatMs(o.total)}`);
      }
    };

    const frame = (now: number) => {
      raf = 0;
      const o = opts.current;
      const dt = Math.min(now - (last || now), 100); // clamp the jump after a hidden tab or a long frame
      last = now;
      if (holdUntil > 0) {
        if (now >= holdUntil) {
          holdUntil = 0;
          timeRef.current = 0;
        }
      } else {
        timeRef.current += dt * o.speed;
        if (timeRef.current >= o.total) {
          timeRef.current = o.total;
          if (o.loop) holdUntil = now + o.holdMs;
          else {
            playingRef.current = false;
            setPlaying(false);
          }
        }
      }
      paint();
      if (playingRef.current) raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf || !playingRef.current || !onScreen || document.hidden) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const halt = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    runRef.current = start;
    haltRef.current = halt;
    seekRef.current = (ms: number) => {
      timeRef.current = clamp(ms, 0, opts.current.total);
      holdUntil = 0;
      last = 0;
      paint();
    };

    if (media.matches) {
      // Reduced motion: show the finished run and never animate it. Pressing play still works.
      timeRef.current = opts.current.total;
    } else if (autoPlay) {
      playingRef.current = true;
      setPlaying(true);
    }
    paint();

    const onVisibility = () => (document.hidden ? halt() : start());
    const onMedia = () => {
      if (!media.matches) return;
      playingRef.current = false;
      setPlaying(false);
      halt();
      seekRef.current(opts.current.total);
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry?.isIntersecting ?? true;
        if (onScreen) start();
        else halt();
      },
      { threshold: 0 },
    );

    io.observe(root);
    document.addEventListener("visibilitychange", onVisibility);
    media.addEventListener("change", onMedia);
    start();

    return () => {
      halt();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      media.removeEventListener("change", onMedia);
      runRef.current = () => {};
      haltRef.current = () => {};
      seekRef.current = () => {};
    };
    // Mount-only: everything the loop needs is read through `opts`, and the effects below re-seek.
  }, [autoPlay]);

  // A new run, or a knob that changes what the rows say, repaints at the current playhead.
  useIsomorphicLayoutEffect(() => {
    rowsRef.current.length = rows.length;
    seekRef.current(timeRef.current);
  }, [rows, total, showTokens, rowHeight, labelWidth]);

  // Moving the `defaultTime` knob seeks. The mount pass is skipped on purpose: the effect above has
  // already placed the playhead, and under reduced motion it belongs at the end of the run, not here.
  const appliedDefault = React.useRef(defaultTime);
  useIsomorphicLayoutEffect(() => {
    if (appliedDefault.current === defaultTime) return;
    appliedDefault.current = defaultTime;
    seekRef.current(defaultTime);
  }, [defaultTime]);

  const togglePlay = () => {
    const next = !playingRef.current;
    if (next && timeRef.current >= total) timeRef.current = 0;
    playingRef.current = next;
    setPlaying(next);
    seekRef.current(timeRef.current);
    if (next) runRef.current();
    else haltRef.current();
  };

  // `data-inset` lets the transport rail account for the padding around its visible track, so the
  // thumb lands exactly under the cursor at both ends.
  const scrubFrom = (clientX: number, el: HTMLElement) => {
    const inset = Number(el.dataset.inset ?? 0);
    const rect = el.getBoundingClientRect();
    const width = rect.width - inset * 2;
    if (width > 0) seekRef.current(((clientX - rect.left - inset) / width) * total);
  };
  const onScrubDown = (e: React.PointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubFrom(e.clientX, e.currentTarget);
  };
  const onScrubMove = (e: React.PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubFrom(e.clientX, e.currentTarget);
  };
  const onScrubUp = (e: React.PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onRailKeyDown = (e: React.KeyboardEvent) => {
    const step = total / 50;
    const delta: Record<string, number> = {
      ArrowRight: step,
      ArrowUp: step,
      ArrowLeft: -step,
      ArrowDown: -step,
      PageUp: step * 10,
      PageDown: step * -10,
    };
    if (e.key === "Home") seekRef.current(0);
    else if (e.key === "End") seekRef.current(total);
    else if (e.key in delta) seekRef.current(timeRef.current + (delta[e.key] ?? 0));
    else return;
    e.preventDefault();
  };

  const onSpanSelectRef = React.useRef(onSpanSelect);
  onSpanSelectRef.current = onSpanSelect;
  const selectSpan = React.useCallback((span: LaidSpan) => {
    setSelected(span.id);
    seekRef.current(span.start);
    onSpanSelectRef.current?.(span);
  }, []);

  // The ruler, the gridlines, the playhead and the scrub surface all use this one box,
  // so everything lines up with the bars between the name gutter and the result column.
  const trackBox = "absolute left-[calc(var(--gutter)+var(--pad))] right-[calc(var(--meta)+var(--pad))]";

  return (
    <div
      ref={(node) => {
        rootRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      data-slot="agent-trace"
      style={
        {
          "--label-w": `${labelWidth}px`,
          "--row": `${rowHeight}px`,
          "--pad": "0.75rem",
          // Consumer styles merge on top, but they can no longer wipe the variables the layout needs.
          ...style,
        } as React.CSSProperties
      }
      className={cn(
        "group/trace @container/trace bg-card text-card-foreground border-border w-full overflow-hidden rounded-xl border shadow-sm",
        className,
      )}
      {...rest}
    >
      {/* Header: which run this is, and where the playhead stands in it. */}
      <div data-slot="trace-header" className="border-border flex items-center gap-2.5 border-b px-3 py-2.5">
        <span
          aria-hidden="true"
          className="bg-muted-foreground/40 group-data-[run=running]/trace:bg-primary size-1.5 shrink-0 rounded-full transition-colors duration-300"
        />
        <span className="text-foreground font-mono text-[13px] leading-none font-medium">{runId}</span>
        <span className="text-muted-foreground @sm/trace:inline hidden truncate text-xs leading-none">
          {model ? `${model} · ` : ""}
          {rows.length} spans
        </span>
        <span
          ref={statusRef}
          className="border-border text-muted-foreground ml-auto shrink-0 rounded-full border px-2 py-0.5 font-mono text-[11px] leading-4"
        >
          {live ? "Running" : "Completed"}
        </span>
      </div>

      <div
        className={cn(
          "relative",
          // The gutter and result columns answer to the card's own width, not the viewport:
          // this drops into a 320px debug drawer as readably as into a full-width page.
          "[--gutter:96px] [--meta:3.75rem]",
          "@xs/trace:[--gutter:132px] @xs/trace:[--meta:5rem]",
          "@md/trace:[--gutter:var(--label-w)] @md/trace:[--meta:9rem]",
        )}
      >
        {/* Ruler — the only place the time axis is written down, and a scrub surface itself. */}
        {showRuler && (
          <div
            data-slot="trace-ruler"
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubUp}
            className="border-border @max-sm/trace:hidden relative h-7 cursor-ew-resize touch-none border-b select-none"
          >
            <div className={cn(trackBox, "inset-y-0")}>
              {ticks.map((t) => (
                <span
                  key={t}
                  className="text-muted-foreground absolute top-2 -translate-x-1/2 font-mono text-[10px] leading-none tabular-nums"
                  style={{ left: `${(t / total) * 100}%` }}
                >
                  {t < 1000 ? `${t}ms` : `${t / 1000}s`}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="relative py-1">
          {showRuler && (
            <div aria-hidden="true" className={cn(trackBox, "@max-sm/trace:hidden inset-y-0")}>
              {ticks.map((t) => (
                <span
                  key={t}
                  className="bg-border/60 absolute inset-y-0 w-px"
                  style={{ left: `${(t / total) * 100}%` }}
                />
              ))}
            </div>
          )}

          <ol aria-label={`Spans in ${runId}`} className="relative">
            {rows.map((span, i) => (
              <li key={span.id}>
                <TraceSpanRow
                  span={span}
                  index={i}
                  total={total}
                  showTokens={showTokens}
                  selected={selected === span.id}
                  onSelect={selectSpan}
                  register={registerRow}
                />
              </li>
            ))}
          </ol>

          {/* Playhead: one transform, driven by `--t` on the root. */}
          <div aria-hidden="true" className={cn(trackBox, "pointer-events-none inset-y-0")}>
            <div
              className="relative h-full w-full"
              style={{ transform: "translateX(calc(var(--t,0) * 100%))" }}
            >
              <span className="bg-primary/70 absolute inset-y-0 w-px" />
              <span className="bg-primary absolute top-0 size-1.5 -translate-x-[2.5px] rotate-45" />
            </div>
          </div>

          {/* Drag anywhere in the run to move the playhead. */}
          <div
            data-slot="trace-scrub"
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubUp}
            className={cn(trackBox, "inset-y-0 cursor-ew-resize touch-none select-none")}
          />
        </div>
      </div>

      {showTransport && (
        <div className="border-border flex items-center gap-3 border-t px-3 py-2">
          <button
            type="button"
            data-slot="cta-primary"
            onClick={togglePlay}
            aria-label={playing ? "Pause replay" : "Play replay"}
            className={cn(
              "bg-primary text-primary-foreground focus-visible:ring-ring/50 relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full",
              "shadow-sm transition-[transform,box-shadow] duration-150 outline-none hover:shadow-md focus-visible:ring-[3px] active:scale-[0.98]",
              // The disc stays 36px; the touch target is 44px, per accessibility.md.
              "before:absolute before:-inset-1 before:content-['']",
            )}
          >
            {playing ? (
              <Pause aria-hidden="true" className="size-3.5 fill-current" />
            ) : (
              <Play aria-hidden="true" className="size-3.5 translate-x-px fill-current" />
            )}
          </button>

          <div
            ref={railRef}
            role="slider"
            tabIndex={0}
            aria-label="Playhead"
            aria-valuemin={0}
            aria-valuemax={Math.round(total)}
            aria-valuenow={Math.round(clamp(defaultTime, 0, total))}
            data-inset="6"
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubUp}
            onKeyDown={onRailKeyDown}
            className="focus-visible:ring-ring/50 relative h-9 flex-1 cursor-ew-resize touch-none rounded-md outline-none select-none focus-visible:ring-[3px]"
          >
            <div className="bg-foreground/10 absolute inset-x-1.5 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full">
              <div
                aria-hidden="true"
                className="bg-primary h-full w-full origin-left"
                style={{ transform: "scaleX(var(--t,0))" }}
              />
            </div>
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-1.5 left-1.5">
              <div
                className="relative h-full w-full"
                style={{ transform: "translateX(calc(var(--t,0) * 100%))" }}
              >
                <span className="bg-primary border-card absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-sm" />
              </div>
            </div>
          </div>

          <span
            ref={clockRef}
            className="text-muted-foreground w-[7rem] shrink-0 text-right font-mono text-[11px] tabular-nums"
          />
        </div>
      )}
    </div>
  );
}

export default AgentTrace;
