"use client";

import { useEffect, useRef, useState } from "react";

interface RunEvent {
  seq: number;
  at: string;
  step: string;
  type: string;
  payload: { detail?: string; model?: string; costUsd?: number; ms?: number; url?: string; error?: string };
}

const ACTIVE = new Set(["queued", "running"]);

/** Time since the first event, as m:ss. */
function offset(first: string | undefined, at: string) {
  const s = first ? Math.max(0, Math.round((Date.parse(at) - Date.parse(first)) / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
const POLL_MS = 1000;

/** Live timeline: polls new events every second while the run is active and the tab is visible. */
export function Timeline({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState(initialStatus);
  const after = useRef(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        const res = await fetch(`/api/runs/${runId}/events?after=${after.current}`).catch(() => null);
        if (res?.ok) {
          const data = (await res.json()) as { status: string; events: RunEvent[] };
          if (data.events.length) {
            after.current = data.events[data.events.length - 1]?.seq ?? after.current;
            setEvents((prev) => [...prev, ...data.events]);
          }
          setStatus(data.status);
          if (!ACTIVE.has(data.status) && data.events.length === 0) return;
        }
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId]);

  return (
    <section aria-label="Timeline" className="flex flex-col gap-2">
      <p className="font-mono text-xs text-muted-foreground">
        {ACTIVE.has(status) ? "live · updates every second" : `finished · ${events.length} events`}
      </p>
      <ol className="flex flex-col divide-y overflow-hidden rounded-lg bg-card shadow-card">
        {events.length === 0 && (
          <li className="px-4 py-3 text-sm text-muted-foreground">Waiting for the first step…</li>
        )}
        {events.map((e) => (
          <li key={e.seq} className="grid grid-cols-[3.5rem_5.5rem_1fr] gap-3 px-4 py-2 text-sm">
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {offset(events[0]?.at, e.at)}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{e.step}</span>
            <span className="min-w-0 break-words">
              {e.payload.model && (
                <span className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {e.payload.model.split("/").pop()}
                </span>
              )}
              {e.payload.url ? (
                <a className="text-link hover:underline" href={e.payload.url}>
                  {e.type} {e.payload.url}
                </a>
              ) : (
                (e.payload.detail ?? e.payload.error ?? e.type)
              )}
              {typeof e.payload.costUsd === "number" && e.payload.costUsd > 0 && (
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  ${e.payload.costUsd.toFixed(4)}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
