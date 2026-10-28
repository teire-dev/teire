"use client";

import {
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  Globe,
  Plug,
  RotateCcw,
  Square,
  Terminal,
  Workflow,
  Wrench,
} from "lucide-react";
import * as React from "react";

export type AgentToolStatus = "idle" | "running" | "answering" | "done";
export type AgentCallStatus = "queued" | "running" | "done" | "error";
export type AgentToolCall = {
  id: string;
  tool: "search" | "read" | "code" | "api" | string;
  title: string;
  status: AgentCallStatus;
  durationMs?: number;
  detail?: string;
  retryOf?: string;
};
export type AgentToolTimelineChatInputProps = {
  status?: AgentToolStatus;
  calls?: AgentToolCall[];
  answer?: string;
  prompt?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onStop?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** Keeps settled calls open under the summary. Omit to let the summary toggle them. */
  activityOpen?: boolean;
  onActivityOpenChange?: (open: boolean) => void;
  className?: string;
  ref?: React.ComponentProps<"div">["ref"];
};

type CallClock = { id: string; start: number; base: number; elapsed: number | undefined; running: boolean };
const EMPTY_CALLS: AgentToolCall[] = [];
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const duration = (value: number | undefined) => (Number.isFinite(value) ? Math.max(0, value ?? 0) : 0);

function ToolIcon({ tool }: { tool: string }) {
  const Icon =
    tool === "search"
      ? Globe
      : tool === "read"
        ? FileText
        : tool === "code"
          ? Terminal
          : tool === "api"
            ? Plug
            : Wrench;
  return <Icon className="size-3.5" aria-hidden="true" />;
}

function CallState({ status, reduced }: { status: AgentCallStatus; reduced: boolean }) {
  const element = React.useRef(null as HTMLSpanElement | null);
  React.useEffect(() => {
    const target = element.current;
    if (status !== "running" || reduced || !target) return;
    let disposed = false;
    let animation = null as Animation | null;
    queueMicrotask(() => {
      if (disposed || typeof target.animate !== "function") return;
      animation = target.animate([{ backgroundPosition: "100% 0" }, { backgroundPosition: "0% 0" }], {
        duration: 1400,
        iterations: Infinity,
        easing: "linear",
      });
    });
    return () => {
      disposed = true;
      animation?.cancel();
    };
  }, [status, reduced]);
  return (
    <span
      data-call-status={status}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium leading-3 ${status === "error" ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}
    >
      {status === "done" && <Check className="size-2.5" aria-hidden="true" />}
      {status === "error" && <span aria-hidden="true">!</span>}
      <span
        ref={element}
        data-running-shimmer={status === "running" ? "" : undefined}
        className={
          status === "running" && !reduced
            ? "bg-[linear-gradient(90deg,var(--color-muted-foreground)_0%,var(--color-muted-foreground)_35%,var(--color-foreground)_50%,var(--color-muted-foreground)_65%,var(--color-muted-foreground)_100%)] bg-[length:250%_100%] bg-clip-text text-transparent"
            : ""
        }
      >
        {status === "queued"
          ? "Queued"
          : status === "running"
            ? "Running"
            : status === "done"
              ? "Done"
              : "Error"}
      </span>
    </span>
  );
}

/** Host-driven tool activity. Running clocks measure observed time; no tools or requests are executed. */
export function AgentToolTimelineChatInput({
  status = "idle",
  calls = EMPTY_CALLS,
  answer = "",
  prompt,
  value,
  defaultValue = "",
  onValueChange,
  onSubmit,
  onStop,
  placeholder = "Give your agent a task…",
  disabled = false,
  activityOpen,
  onActivityOpenChange,
  className = "",
  ref,
}: AgentToolTimelineChatInputProps) {
  const [draft, setDraft] = React.useState(defaultValue);
  const [lastPrompt, setLastPrompt] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const [openCall, setOpenCall] = React.useState(null as string | null);
  const [reduced, setReduced] = React.useState(true);
  const [tick, setTick] = React.useState(0);
  const clocks = React.useRef([] as CallClock[]);
  const panel = React.useRef(null as HTMLDivElement | null);
  const body = React.useRef(null as HTMLDivElement | null);
  const list = React.useRef(null as HTMLOListElement | null);
  const rail = React.useRef(null as HTMLDivElement | null);
  const railHeight = React.useRef(0);
  const input = React.useRef(null as HTMLTextAreaElement | null);
  const region = React.useId();
  const inputValue = value ?? draft;
  const question = prompt ?? lastPrompt;
  const busy = status === "running" || status === "answering";
  const settled =
    calls.length > 0 && calls.every((call) => call.status === "done" || call.status === "error");
  const compact = settled && (status === "answering" || status === "done");
  const open = activityOpen ?? expanded;
  const showCalls = !compact || open;
  const ids = calls.map((call) => call.id).join("\u001f");
  const totalMs = calls.reduce((total, call) => total + duration(call.durationMs), 0);
  const allTimed = calls.every((call) => Number.isFinite(call.durationMs));
  const summary = `${calls.length} ${calls.length === 1 ? "tool" : "tools"}${allTimed ? ` · ${(totalMs / 1000).toFixed(1)}s` : ""}`;
  const inputLabel = status === "idle" ? placeholder : "Ask a follow-up";
  const lastSentence = [...answer.matchAll(/[.!?。！？](?=\s|$)|\n/g)].at(-1);
  const spokenAnswer =
    status === "done" ? answer : answer.slice(0, lastSentence ? lastSentence.index + 1 : 0).trim();
  const latest = calls.at(-1);

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  React.useEffect(() => {
    if (status === "idle" || status === "running") {
      setExpanded(false);
      setOpenCall(null);
    }
  }, [status]);

  // Host durations are authoritative. Without one, freeze the locally observed
  // time at completion; do not invent durations for calls first seen as done.
  React.useEffect(() => {
    const now = performance.now();
    clocks.current = calls.map((call) => {
      const old = clocks.current.find((clock) => clock.id === call.id);
      if (call.status === "running") {
        const base = duration(call.durationMs);
        return old?.running && old.base === base
          ? old
          : { id: call.id, start: now, base, elapsed: base, running: true };
      }
      return {
        id: call.id,
        start: now,
        base: duration(call.durationMs),
        elapsed: Number.isFinite(call.durationMs)
          ? duration(call.durationMs)
          : old?.running
            ? old.base + now - old.start
            : old?.elapsed,
        running: false,
      };
    });
    setTick(now);
    if (!calls.some((call) => call.status === "running")) return;
    const timer = window.setInterval(() => setTick(performance.now()), 80);
    return () => window.clearInterval(timer);
  }, [calls]);

  React.useLayoutEffect(() => {
    const rows = list.current;
    const line = rail.current;
    if (!rows || !line) {
      railHeight.current = 0;
      return;
    }
    const previous = railHeight.current;
    const height = line.getBoundingClientRect().height;
    railHeight.current = height;
    if (reduced) return;
    let disposed = false;
    const animations: Animation[] = [];
    queueMicrotask(() => {
      if (disposed) return;
      const fresh = [...rows.querySelectorAll("[data-tool-call]")].filter(
        (row) => !(row as HTMLElement).dataset.entered,
      );
      fresh.forEach((row, index) => {
        (row as HTMLElement).dataset.entered = "true";
        animations.push(
          row.animate(
            [
              { opacity: 0, transform: "translateY(16px)" },
              { opacity: 1, transform: "translateY(0px)" },
            ],
            { duration: 420, delay: index * 65, easing: EASE, fill: "backwards" },
          ),
        );
      });
      if (height > 0 && Math.abs(height - previous) > 1)
        animations.push(
          line.animate([{ transform: `scaleY(${previous / height})` }, { transform: "scaleY(1)" }], {
            duration: 420,
            easing: EASE,
          }),
        );
    });
    return () => {
      disposed = true;
      animations.forEach((animation) => animation.cancel());
    };
  }, [ids, reduced]);

  React.useLayoutEffect(() => {
    const viewport = panel.current;
    const content = body.current;
    if (!viewport || !content) return;
    let disposed = false;
    const follow = () => {
      if (!disposed) viewport.scrollTop = viewport.scrollHeight;
    };
    queueMicrotask(follow);
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    observer.observe(viewport);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [calls, answer, question, showCalls, openCall]);

  React.useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.max(44, Math.min(88, field.scrollHeight))}px`;
  }, [inputValue]);

  function changeValue(next: string) {
    if (value === undefined) setDraft(next);
    onValueChange?.(next);
  }
  function submit() {
    const text = inputValue.trim();
    if (!text || busy || disabled || !onSubmit) return;
    setLastPrompt(text);
    onSubmit(text);
    changeValue("");
  }

  return (
    <div
      ref={ref}
      data-slot="agent-tool-timeline-chat-input"
      data-state={status}
      className={`flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-xl shadow-primary/5 ${className}`}
    >
      <div
        ref={panel}
        data-transcript
        role="region"
        aria-label="Agent conversation"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto p-4 outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div ref={body}>
          {status === "idle" && !question && calls.length === 0 ? (
            <div data-empty className="flex min-h-56 flex-col items-center justify-center gap-5 text-center">
              <div className="flex items-center gap-2 text-muted-foreground" aria-hidden="true">
                {["search", "read", "code", "api"].map((tool, index) => (
                  <React.Fragment key={tool}>
                    {index > 0 && <span className="h-px w-3 bg-border" />}
                    <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/40">
                      <ToolIcon tool={tool} />
                    </span>
                  </React.Fragment>
                ))}
              </div>
              <div>
                <p className="text-sm font-medium">A clear trail from task to answer.</p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Search, read, run, and review each result.
                </p>
              </div>
            </div>
          ) : (
            <>
              {question && (
                <div
                  data-question
                  className="mb-4 ml-auto w-fit max-w-[94%] rounded-xl rounded-br-sm bg-muted px-3 py-2 text-xs leading-5"
                >
                  <p className="break-words">{question}</p>
                </div>
              )}
              {(calls.length > 0 || status === "running") && (
                <div data-activity>
                  {compact ? (
                    <button
                      type="button"
                      data-summary
                      aria-expanded={showCalls}
                      aria-controls={region}
                      onClick={() => {
                        if (activityOpen === undefined) setExpanded(!open);
                        onActivityOpenChange?.(!open);
                      }}
                      title="Combined reported tool time"
                      className="mb-2 inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Workflow className="size-3.5" aria-hidden="true" />
                      <span>{summary}</span>
                      <ChevronDown
                        className={`size-3 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none ${showCalls ? "rotate-180" : ""}`}
                        aria-hidden="true"
                      />
                    </button>
                  ) : (
                    <div
                      data-live-heading
                      className="mb-3 flex items-center gap-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground"
                    >
                      <Workflow className="size-3.5" aria-hidden="true" /> Tool activity{" "}
                      <span className="ml-auto font-mono text-[9px] normal-case tracking-normal">
                        {calls.length
                          ? `${calls.length} ${calls.length === 1 ? "call" : "calls"}`
                          : "Preparing…"}
                      </span>
                    </div>
                  )}
                  <div
                    id={region}
                    data-timeline-body
                    aria-hidden={!showCalls}
                    inert={!showCalls}
                    className={`grid transition-[grid-template-rows,opacity] duration-300 motion-reduce:transition-none ${showCalls ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
                  >
                    <div className="relative min-h-0 overflow-hidden">
                      <div
                        ref={rail}
                        data-timeline-rail
                        aria-hidden="true"
                        className="absolute bottom-5 left-[15px] top-5 w-px origin-top bg-border"
                      />
                      <ol ref={list} aria-label="Tool calls" className="relative space-y-2">
                        {calls.map((call, index) => {
                          const clock = clocks.current.find((item) => item.id === call.id);
                          const elapsed =
                            call.status === "running"
                              ? (clock?.base ?? duration(call.durationMs)) +
                                (clock?.running ? Math.max(0, tick - clock.start) : 0)
                              : Number.isFinite(call.durationMs)
                                ? duration(call.durationMs)
                                : clock?.elapsed;
                          const detailOpen = openCall === call.id;
                          const original = calls.find((item) => item.id === call.retryOf);
                          const detailId = `${region}-detail-${index}`;
                          return (
                            <li
                              key={call.id}
                              data-tool-call={call.id}
                              data-tool={call.tool}
                              data-status={call.status}
                              data-retry-of={call.retryOf}
                              className="relative flex items-start gap-3"
                            >
                              <span
                                className={`relative z-10 mt-3 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card ${call.status === "running" ? "border-primary/40 text-foreground" : "border-border text-muted-foreground"}`}
                              >
                                <ToolIcon tool={call.tool} />
                              </span>
                              <div
                                className={`min-w-0 flex-1 overflow-hidden rounded-lg border ${call.status === "error" ? "border-primary/30 border-dashed" : "border-border"} ${call.status === "running" ? "bg-primary/5" : "bg-background/40"}`}
                              >
                                <button
                                  type="button"
                                  data-call-toggle={call.id}
                                  disabled={!call.detail}
                                  aria-expanded={call.detail ? detailOpen : undefined}
                                  aria-controls={call.detail ? detailId : undefined}
                                  onClick={() => setOpenCall(detailOpen ? null : call.id)}
                                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none enabled:hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                >
                                  <div className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5 text-[9px] leading-3 text-muted-foreground">
                                      <span className="font-mono">
                                        {call.tool === "search"
                                          ? "search.web"
                                          : call.tool === "read"
                                            ? "read.file"
                                            : call.tool === "code"
                                              ? "run.code"
                                              : call.tool === "api"
                                                ? "call.api"
                                                : call.tool}
                                      </span>
                                      {call.retryOf && (
                                        <span
                                          data-retry-label
                                          title={
                                            original
                                              ? `Retry of ${original.title}`
                                              : `Retry of ${call.retryOf}`
                                          }
                                          className="inline-flex shrink-0 items-center gap-1"
                                        >
                                          <RotateCcw className="size-2.5" aria-hidden="true" />
                                          Retry
                                        </span>
                                      )}
                                    </span>
                                    <span className="mt-0.5 flex items-center gap-1 text-xs font-medium leading-4">
                                      <span className="truncate">{call.title}</span>
                                      {call.detail && (
                                        <ChevronDown
                                          aria-hidden="true"
                                          className={`size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${detailOpen ? "rotate-180" : ""}`}
                                        />
                                      )}
                                    </span>
                                  </div>
                                  <div className="flex min-w-[54px] shrink-0 flex-col items-end gap-1">
                                    <CallState status={call.status} reduced={reduced} />
                                    <span
                                      data-duration
                                      aria-hidden="true"
                                      className="font-mono text-[9px] leading-3 tabular-nums text-muted-foreground"
                                    >
                                      {call.status === "queued" || elapsed === undefined
                                        ? "—"
                                        : `${Math.round(elapsed)}ms`}
                                    </span>
                                  </div>
                                </button>
                                {call.detail && (
                                  <div
                                    id={detailId}
                                    data-call-detail={call.id}
                                    role="region"
                                    aria-label={`${call.title} result`}
                                    hidden={!detailOpen}
                                    className="border-t border-border bg-muted/30 px-2.5 py-2"
                                  >
                                    <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-4 text-muted-foreground">
                                      {call.detail}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  </div>
                </div>
              )}
              {(status === "answering" || status === "done") && (
                <div
                  data-answer
                  role="region"
                  aria-label="Agent answer"
                  aria-live="off"
                  className="mt-3 whitespace-pre-line break-words text-[13px] leading-6"
                >
                  {answer}
                  {status === "answering" && (
                    <span
                      data-answer-cursor
                      aria-hidden="true"
                      className="ml-1 inline-block h-3 w-1 translate-y-0.5 rounded-full bg-primary motion-safe:animate-pulse"
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <form
        data-composer
        aria-label="Agent prompt"
        className="shrink-0 border-t border-border bg-background/60 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex items-end gap-3">
          <textarea
            ref={input}
            aria-label={inputLabel}
            placeholder={inputLabel}
            value={inputValue}
            disabled={disabled}
            rows={1}
            onChange={(event) => changeValue(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229
              ) {
                event.preventDefault();
                submit();
              }
            }}
            className="block min-h-11 min-w-0 flex-1 resize-none rounded-lg bg-transparent px-1 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <button
            type={busy ? "button" : "submit"}
            data-stop={busy ? "" : undefined}
            aria-label={busy ? "Stop" : "Send prompt"}
            disabled={disabled || (busy ? !onStop : !onSubmit || !inputValue.trim())}
            onClick={
              busy
                ? (event) => {
                    event.preventDefault();
                    onStop?.();
                  }
                : undefined
            }
            className="relative mb-1 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-30"
          >
            <span
              data-send-icon
              aria-hidden="true"
              className={`absolute inset-0 flex items-center justify-center transition-[opacity,scale] duration-200 motion-reduce:transition-none ${busy ? "scale-75 opacity-0" : "scale-100 opacity-100"}`}
            >
              <ArrowUp className="size-4" />
            </span>
            <span
              data-stop-icon
              aria-hidden="true"
              className={`absolute inset-0 flex items-center justify-center transition-[opacity,scale] duration-200 motion-reduce:transition-none ${busy ? "scale-100 opacity-100" : "scale-75 opacity-0"}`}
            >
              <Square className="size-3 fill-current" />
            </span>
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between text-[9px] leading-3 text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Workflow className="size-3" aria-hidden="true" /> Agent workspace
          </span>
          <span>Enter to send · Shift+Enter for a new line</span>
        </div>
      </form>
      <div data-announcement role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {status === "running"
          ? latest
            ? `${latest.title}: ${latest.status}.`
            : "Preparing tool activity."
          : spokenAnswer}
      </div>
    </div>
  );
}

export default AgentToolTimelineChatInput;
