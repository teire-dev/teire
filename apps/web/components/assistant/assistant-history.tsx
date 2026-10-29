"use client";

import { Check, Pencil, Search, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ago } from "./assistant-cards";

interface ThreadRow {
  id: string;
  title: string;
  updatedAt: string;
  context: { kind: string; label: string } | null;
}

/**
 * The person's threads (plan revision 3.3, U4): searchable by title and text, renamed in place,
 * deleted after one confirm. Threads are kept 90 days.
 */
export function AssistantHistory({
  current,
  onOpen,
  onDeleted,
}: {
  current: string | null;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ThreadRow[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/assistant/threads?q=${encodeURIComponent(q)}`, { signal: ctrl.signal, cache: "no-store" })
        .then(async (r) => (r.ok ? ((await r.json()) as { threads: ThreadRow[] }).threads : []))
        .then(setRows)
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const rename = async (id: string, title: string) => {
    setRows((r) => r?.map((t) => (t.id === id ? { ...t, title } : t)) ?? r);
    setEditing(null);
    await fetch(`/api/assistant/threads/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
  };
  const remove = async (id: string) => {
    setDeleting(null);
    setRows((r) => r?.filter((t) => t.id !== id) ?? r);
    await fetch(`/api/assistant/threads/${id}`, { method: "DELETE" });
    onDeleted(id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <label className="mx-3 mt-3 flex items-center gap-2 rounded-md bg-sunken px-2 py-1.5 ring-1 ring-rule ring-inset focus-within:ring-signal">
        <Search className="size-3.5 text-ink-3" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder="Search your threads"
          className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
          aria-label="Search your threads"
        />
      </label>
      <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {rows === null ? ["a", "b", "c"].map((k) => <Skeleton key={k} className="m-1 h-10" />) : null}
        {rows?.length === 0 ? (
          <li className="px-2 py-6 text-center text-sm text-ink-3">
            {q ? "No thread matches." : "No threads yet. Ask something to start one."}
          </li>
        ) : null}
        {rows?.map((t) => (
          <li
            key={t.id}
            className={cn(
              "group flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-hover",
              t.id === current && "bg-hover",
            )}
          >
            {editing?.id === t.id ? (
              <form
                className="flex flex-1 items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  void rename(t.id, editing.title);
                }}
              >
                <input
                  // biome-ignore lint/a11y/noAutofocus: renaming starts typing in place.
                  autoFocus
                  value={editing.title}
                  onChange={(e) => setEditing({ id: t.id, title: e.currentTarget.value })}
                  className="w-full rounded bg-sheet px-1.5 py-0.5 text-sm text-ink ring-1 ring-signal outline-none"
                  aria-label="Thread title"
                />
                <button type="submit" className="p-1 text-ink-2" aria-label="Save the title">
                  <Check className="size-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  className="p-1 text-ink-3"
                  aria-label="Cancel"
                  onClick={() => setEditing(null)}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </form>
            ) : deleting === t.id ? (
              <span className="flex flex-1 items-center gap-2 text-sm">
                <span className="truncate text-ink">Delete this thread?</span>
                <button
                  type="button"
                  className="ml-auto text-xs text-broke"
                  onClick={() => void remove(t.id)}
                >
                  Delete
                </button>
                <button type="button" className="text-xs text-ink-3" onClick={() => setDeleting(null)}>
                  Keep
                </button>
              </span>
            ) : (
              <>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col text-left"
                  onClick={() => onOpen(t.id)}
                >
                  <span className="truncate text-sm text-ink">{t.title}</span>
                  <span className="truncate font-mono text-[10px] text-ink-3">
                    {ago(t.updatedAt)}
                    {t.context ? ` · ${t.context.label}` : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="p-1 text-ink-3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Rename ${t.title}`}
                  onClick={() => setEditing({ id: t.id, title: t.title })}
                >
                  <Pencil className="size-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  className="p-1 text-ink-3 opacity-0 group-hover:opacity-100 hover:text-broke focus-visible:opacity-100"
                  aria-label={`Delete ${t.title}`}
                  onClick={() => setDeleting(t.id)}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
