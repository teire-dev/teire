"use client";

import { History, MessageSquare, PanelRightClose, PanelRightOpen, Plus, Search, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogoMark } from "@/components/logo";
import { SignInButton } from "@/components/sign-in-button";
import { cn } from "@/lib/utils";
import { SafeLink } from "./assistant-cards";
import { AssistantChat } from "./assistant-chat";
import { AssistantHistory } from "./assistant-history";
import { MAX_WIDTH, MIN_WIDTH, useAssistant } from "./assistant-provider";

/**
 * Ask Teire's panel (plan revision 3.3, U4). Floating above the launcher (420×640, 12px radius); docked,
 * a right sidebar the person can resize (360–600px) that the page reflows beside on wide screens and
 * that stays docked across navigation; on a phone, a full-height sheet. The header carries the
 * context chip the page set, a new thread, history, dock and close.
 */
function usePhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 767px)");
    const on = () => setPhone(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

export function AssistantPanel({ hidden, signedIn }: { hidden: boolean; signedIn: boolean }) {
  const a = useAssistant();
  const phone = usePhone();
  const [view, setView] = useState<"chat" | "history">("chat");
  const [removed, setRemoved] = useState<string | null>(null);
  const docked = a.docked && !phone;

  useEffect(() => {
    if (!a.threadId) a.setThreadId(crypto.randomUUID());
  }, [a.threadId, a.setThreadId]);

  // The page's chip is back when the page changes, unless the person removed this one.
  const key = a.context ? `${a.context.kind}:${a.context.id}` : null;
  const chip = a.context && key !== removed ? a.context : null;

  useEffect(() => {
    if (hidden || docked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") a.setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, docked, a.setOpen]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => a.setWidth(window.innerWidth - ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("user-select");
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const icon =
    "rounded-md p-1.5 text-ink-3 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-signal";

  return (
    <aside
      aria-label="Ask Teire"
      hidden={hidden}
      style={docked ? { width: a.width } : undefined}
      className={cn(
        "z-50 flex flex-col bg-sheet",
        phone
          ? "fixed inset-0"
          : docked
            ? "fixed top-0 right-0 bottom-0 border-l border-rule shadow-float min-[1440px]:shadow-none"
            : "fixed right-4 bottom-4 h-[min(640px,calc(100svh-2rem))] w-[420px] max-w-[calc(100vw-2rem)] rounded-xl shadow-float ring-1 ring-rule sm:right-6 sm:bottom-6",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-200",
      )}
    >
      {docked ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: a drag handle; the width is also kept between visits.
        <div
          onPointerDown={startResize}
          className="absolute top-0 bottom-0 -left-1 w-2 cursor-col-resize hover:bg-signal/20"
          title={`Drag to resize (${MIN_WIDTH}–${MAX_WIDTH}px)`}
        />
      ) : null}
      <header className="flex items-center gap-2 border-b border-rule px-3 py-2.5">
        <LogoMark className="size-6" />
        <span className="shrink-0 whitespace-nowrap text-sm font-medium text-ink">Ask Teire</span>
        {chip && a.mode === "app" ? (
          <span className="ml-1 flex min-w-0 max-w-[45%] items-center gap-1 rounded-full bg-signal-soft py-0.5 pr-1 pl-2 font-mono text-[11px] text-signal">
            <span className="truncate">{chip.label}</span>
            <button
              type="button"
              aria-label={`Ask without ${chip.label}`}
              className="rounded-full p-0.5 hover:bg-signal/15"
              onClick={() => setRemoved(key)}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center">
          {signedIn ? (
            <>
              <button
                type="button"
                className={icon}
                aria-label="New thread"
                title="New thread"
                onClick={() => {
                  a.setThreadId(crypto.randomUUID());
                  setView("chat");
                }}
              >
                <Plus className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                className={cn(icon, view === "history" && "bg-hover text-ink")}
                aria-label={view === "history" ? "Back to the thread" : "History"}
                aria-pressed={view === "history"}
                title={view === "history" ? "Back to the thread" : "History"}
                onClick={() => setView(view === "history" ? "chat" : "history")}
              >
                {view === "history" ? (
                  <MessageSquare className="size-4" aria-hidden />
                ) : (
                  <History className="size-4" aria-hidden />
                )}
              </button>
            </>
          ) : null}
          {!phone ? (
            <button
              type="button"
              className={icon}
              aria-label={docked ? "Float the panel" : "Dock to the right"}
              title={docked ? "Float the panel" : "Dock to the right"}
              onClick={() => a.setDocked(!docked)}
            >
              {docked ? (
                <PanelRightClose className="size-4" aria-hidden />
              ) : (
                <PanelRightOpen className="size-4" aria-hidden />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className={icon}
            aria-label="Close Ask Teire"
            title="Close (Esc)"
            onClick={() => a.setOpen(false)}
          >
            <X className="size-4" aria-hidden />
          </button>
        </span>
      </header>
      {!signedIn ? (
        <DocsOnly />
      ) : view === "history" ? (
        <AssistantHistory
          current={a.threadId}
          onOpen={(id) => {
            a.setThreadId(id);
            setView("chat");
          }}
          onDeleted={(id) => {
            if (id === a.threadId) a.setThreadId(crypto.randomUUID());
          }}
        />
      ) : a.threadId ? (
        <AssistantChat threadId={a.threadId} chip={a.mode === "app" ? chip : null} />
      ) : null}
    </aside>
  );
}

interface DocHit {
  id: string;
  url: string;
  type: string;
  content: string;
}

/** Signed out on the docs: docs search, and "Sign in to ask" (no anonymous model spend, D127). */
function DocsOnly() {
  const path = usePathname();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<DocHit[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const t = setTimeout(() => {
      fetch(`/api/search?query=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then(async (r) => (r.ok ? ((await r.json()) as DocHit[]) : []))
        .then((h) => {
          setHits(h.slice(0, 8));
          setSearching(false);
        })
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <label className="flex items-center gap-2 rounded-md bg-sunken px-2 py-1.5 ring-1 ring-rule ring-inset focus-within:ring-signal">
        <Search className="size-3.5 text-ink-3" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder="Search the docs"
          className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
          aria-label="Search the docs"
        />
      </label>
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {hits.map((h) => (
          <li key={h.id}>
            <SafeLink href={h.url} className="block rounded-md px-2 py-1 text-sm text-ink hover:bg-hover">
              {h.content
                .replace(/<[^>]+>/g, "")
                .replace(/\|/g, " ")
                .replace(/-{3,}/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 120)}
            </SafeLink>
          </li>
        ))}
        {q.trim().length >= 2 && !hits.length ? (
          <li className="px-2 text-sm text-ink-3">{searching ? "Searching…" : "Nothing matches."}</li>
        ) : null}
      </ul>
      <div className="flex flex-col gap-2 rounded-lg bg-sunken p-3 ring-1 ring-rule ring-inset">
        <p className="text-sm text-ink-2">
          Sign in to ask Teire about your repositories and how Teire works.
        </p>
        <SignInButton size="sm" className="w-fit" next={path} label="Sign in to ask" />
      </div>
    </div>
  );
}
