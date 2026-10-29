"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AssistantContext } from "@/lib/assistant/message";
import { authClient } from "@/lib/auth-client";
import { AssistantLauncher } from "./assistant-launcher";

/**
 * Ask Teire's place in the app (plan revision 3.3, U4): one provider at the root, so the panel and its
 * thread stay open and docked across navigation. Pages name what they show (the context chip), the
 * app shell shares what can be @-mentioned, and any button can open it with a question. The panel's
 * code loads on first open; nothing of it is in a page's first paint.
 */
export interface Mention {
  kind: "repo" | "run" | "change" | "pr";
  id: string;
  label: string;
}

interface Layout {
  open: boolean;
  docked: boolean;
  width: number;
  threadId: string | null;
}

interface AssistantApi extends Layout {
  /** Where Ask Teire is offered: the app, run and scan pages, and the docs (docs-only). */
  available: boolean;
  mode: "app" | "docs";
  context: AssistantContext | null;
  mentions: Mention[];
  /** A question to send as soon as the panel is ready (Explain, ⌘K's "Ask Teire: …"). */
  queued: string | null;
  setOpen: (open: boolean) => void;
  setDocked: (docked: boolean) => void;
  setWidth: (width: number) => void;
  setThreadId: (id: string | null) => void;
  setContext: (context: AssistantContext | null) => void;
  setMentions: (mentions: Mention[]) => void;
  ask: (question: string, context?: AssistantContext | null) => void;
  takeQueued: () => string | null;
}

const KEY = "teire-assistant";
export const MIN_WIDTH = 360;
export const MAX_WIDTH = 600;

const AssistantCtx = createContext<AssistantApi | null>(null);

const AssistantPanel = dynamic(() => import("./assistant-panel").then((m) => m.AssistantPanel), {
  ssr: false,
});

function readLayout(): Layout {
  const fallback = { open: false, docked: false, width: 420, threadId: null };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Layout> | null;
    return saved ? { ...fallback, ...saved } : fallback;
  } catch {
    return fallback;
  }
}

const allowedOn = (path: string) => /^\/(app|runs\/|scan\/|changes\/|docs)/.test(path);

/**
 * The page's path, read inside its own Suspense boundary: at the root, a path read outside one would
 * keep every page from prerendering (Cache Components).
 */
function PathWatcher({ onPath }: { onPath: (path: string) => void }) {
  const path = usePathname();
  useEffect(() => onPath(path), [path, onPath]);
  return null;
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [path, setPath] = useState("");
  const [layout, setLayout] = useState<Layout>({ open: false, docked: false, width: 420, threadId: null });
  const [loaded, setLoaded] = useState(false);
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [queued, setQueued] = useState<string | null>(null);
  // The panel mounts on first open and then stays, so its thread survives closing and navigating.
  const [mounted, setMounted] = useState(false);
  const queuedRef = useRef<string | null>(null);

  useEffect(() => {
    const saved = readLayout();
    setLayout(saved);
    if (saved.open) setMounted(true);
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {}
  }, [layout, loaded]);

  const available = allowedOn(path);
  const mode = path.startsWith("/docs") ? "docs" : "app";
  const showing = available && layout.open;

  // Docked: the page reflows beside the panel (wide screens; CSS decides) and gives it its width.
  useEffect(() => {
    const root = document.documentElement;
    if (showing && layout.docked) {
      root.dataset.assistantDock = "";
      root.style.setProperty("--assistant-w", `${layout.width}px`);
    } else delete root.dataset.assistantDock;
    return () => {
      delete root.dataset.assistantDock;
    };
  }, [showing, layout.docked, layout.width]);

  const setOpen = useCallback((open: boolean) => {
    if (open) setMounted(true);
    setLayout((l) => ({ ...l, open }));
  }, []);

  // ⌘I (⌘J is the browsers' Downloads), where Ask Teire is offered.
  useEffect(() => {
    if (!available) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "i" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setMounted(true);
        setLayout((l) => ({ ...l, open: !l.open }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [available]);

  const api = useMemo<AssistantApi>(
    () => ({
      ...layout,
      available,
      mode,
      context,
      mentions,
      queued,
      setOpen,
      setDocked: (docked) => setLayout((l) => ({ ...l, docked })),
      setWidth: (width) =>
        setLayout((l) => ({ ...l, width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width))) })),
      setThreadId: (threadId) => setLayout((l) => ({ ...l, threadId })),
      setContext,
      setMentions,
      ask: (question, next) => {
        if (next !== undefined) setContext(next);
        queuedRef.current = question;
        setQueued(question);
        setOpen(true);
      },
      takeQueued: () => {
        const q = queuedRef.current;
        queuedRef.current = null;
        setQueued(null);
        return q;
      },
    }),
    [layout, available, mode, context, mentions, queued, setOpen],
  );

  return (
    <AssistantCtx.Provider value={api}>
      <Suspense fallback={null}>
        <PathWatcher onPath={setPath} />
      </Suspense>
      {children}
      {available && loaded ? <AssistantHost mounted={mounted} /> : null}
    </AssistantCtx.Provider>
  );
}

/**
 * Signed in, everywhere Ask Teire is offered; signed out, only on the docs (docs search and "Sign in
 * to ask"), so there is no anonymous model spend (D127).
 */
function AssistantHost({ mounted }: { mounted: boolean }) {
  const a = useAssistant();
  const session = authClient.useSession();
  if (session.isPending) return null;
  const signedIn = !!session.data;
  if (!signedIn && a.mode === "app") return null;
  return (
    <>
      {mounted ? <AssistantPanel hidden={!a.open} signedIn={signedIn} /> : null}
      {!a.open ? <AssistantLauncher onOpen={() => a.setOpen(true)} /> : null}
    </>
  );
}

export function useAssistant() {
  const api = useContext(AssistantCtx);
  if (!api) throw new Error("useAssistant needs AssistantProvider");
  return api;
}

/** A page names what it shows; the chip appears in Ask Teire while the page is open. */
export function AskContext({ kind, id, label }: AssistantContext) {
  const { setContext } = useAssistant();
  useEffect(() => {
    setContext({ kind, id, label });
    return () => setContext(null);
  }, [kind, id, label, setContext]);
  return null;
}

/** The app shell shares what can be @-mentioned: the installation's repositories, runs and changes. */
export function AssistantMentions({ mentions }: { mentions: Mention[] }) {
  const { setMentions } = useAssistant();
  const key = mentions.map((m) => `${m.kind}:${m.id}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the list's content.
  useEffect(() => {
    setMentions(mentions);
  }, [key, setMentions]);
  return null;
}
