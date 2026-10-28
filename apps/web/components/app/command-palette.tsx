"use client";

import { useQuery } from "@tanstack/react-query";
import type { ActionKind } from "@teire/engine/actions";
import { describeAction } from "@teire/engine/actions";
import { BookOpen, FolderGit2, LayoutGrid, RefreshCw, Settings, ShieldCheck, Wrench } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { runAction } from "./run-action";

interface DocHit {
  id: string;
  type: "page" | "heading" | "text";
  content: string;
  breadcrumbs?: string[];
  url: string;
}

const PAGES = [
  { label: "Overview", href: "/app", icon: LayoutGrid },
  { label: "Repositories", href: "/app/repos", icon: FolderGit2 },
  { label: "Settings", href: "/app/settings", icon: Settings },
  { label: "Docs", href: "/docs", icon: BookOpen },
  { label: "Trust: how Teire runs", href: "/trust", icon: ShieldCheck },
] as const;

const MODES = [
  ["auto", "Automatic"],
  ["ask", "Ask first"],
  ["off", "Off"],
] as const;

/** The query's words in bold inside a docs snippet (Factory docs' result rows). */
function Snippet({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  const start = Math.max(0, at - 40);
  const clip = text.slice(start, start + 140);
  if (at < 0) return <>{clip}</>;
  const i = at - start;
  return (
    <>
      {start > 0 ? "…" : ""}
      {clip.slice(0, i)}
      <b className="font-semibold text-ink">{clip.slice(i, i + query.length)}</b>
      {clip.slice(i + query.length)}
    </>
  );
}

/**
 * ⌘K (plan revision 3.3, "App shell"): jump to a page or a repository, act on the repository you're
 * on (each action asks once before it runs), and search the docs: each hit with its breadcrumb, title
 * and the match in bold.
 */
export function CommandPalette({
  open,
  onOpenChange,
  repos,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: { fullName: string; fixMode: string }[];
}) {
  const router = useRouter();
  const path = usePathname();
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<{
    kind: ActionKind;
    params: Record<string, unknown>;
    repo: string;
  } | null>(null);
  const here = /^\/app\/repos\/([\w.-]+\/[\w.-]+)/.exec(path)?.[1] ?? null;
  const repo = here ? repos.find((r) => r.fullName === here) : undefined;

  const docs = useQuery({
    queryKey: ["docs-search", query],
    queryFn: async ({ signal }) =>
      (await (await fetch(`/api/search?query=${encodeURIComponent(query)}`, { signal })).json()) as DocHit[],
    enabled: open && query.trim().length >= 2,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!open) {
      setQuery("");
      setConfirm(null);
    }
  }, [open]);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  if (confirm)
    return (
      <CommandDialog open={open} onOpenChange={onOpenChange} title="Confirm" description="Confirm the action">
        <CommandList>
          <CommandGroup heading={`${confirm.repo}`}>
            <CommandItem
              value="confirm"
              onSelect={() => {
                onOpenChange(false);
                void runAction(
                  { kind: confirm.kind, params: confirm.params, repo: confirm.repo },
                  { onSettled: () => router.refresh() },
                );
              }}
            >
              <span className="font-medium">{describeAction(confirm.kind, confirm.params)}</span>
              <CommandShortcut>Enter</CommandShortcut>
            </CommandItem>
            <CommandItem value="back" onSelect={() => setConfirm(null)}>
              Back
              <CommandShortcut>Esc</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    );

  const hits = (docs.data ?? []).filter((h) => h.type !== "text" || h.content.length > 20).slice(0, 6);
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Jump"
      description="Pages, repositories, actions and docs"
    >
      <CommandInput value={query} onValueChange={setQuery} placeholder="Jump to a repo, page or doc…" />
      <CommandList>
        <CommandEmpty>
          {query.trim().length >= 2 && docs.isFetching ? "Searching the docs…" : "Nothing matches."}
        </CommandEmpty>
        {repo ? (
          <CommandGroup heading={`On ${repo.fullName}`}>
            <CommandItem
              value={`rescan ${repo.fullName}`}
              onSelect={() => setConfirm({ kind: "rescan", params: {}, repo: repo.fullName })}
            >
              <RefreshCw /> Rescan now
            </CommandItem>
            {MODES.filter(([m]) => m !== repo.fixMode).map(([m, label]) => (
              <CommandItem
                key={m}
                value={`fix mode ${label} ${repo.fullName}`}
                onSelect={() =>
                  setConfirm({ kind: "set-fix-mode", params: { mode: m }, repo: repo.fullName })
                }
              >
                <Wrench /> Fix mode: {label}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup heading="Go to">
          {PAGES.map((p) => (
            <CommandItem key={p.href} value={`go ${p.label}`} onSelect={() => go(p.href)}>
              <p.icon /> {p.label}
            </CommandItem>
          ))}
        </CommandGroup>
        {repos.length ? (
          <CommandGroup heading="Repositories">
            {repos.map((r) => (
              <CommandItem
                key={r.fullName}
                value={`repo ${r.fullName}`}
                onSelect={() => go(`/app/repos/${r.fullName}`)}
              >
                <FolderGit2 />
                <span className="truncate">{r.fullName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {hits.length ? (
          <CommandGroup heading="Docs" forceMount>
            {hits.map((h) => (
              <CommandItem
                key={h.id}
                value={`doc ${h.id}`}
                forceMount
                onSelect={() => go(h.url)}
                className="flex-col items-start gap-0.5"
              >
                <span className="font-mono text-[10px] text-ink-3">{(h.breadcrumbs ?? []).join(" › ")}</span>
                <span className="line-clamp-2 text-sm text-ink-2">
                  <Snippet text={h.content} query={query.trim()} />
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
      <div className="flex items-center justify-end gap-1.5 border-t border-rule px-3 py-2 font-mono text-[10px] text-ink-3">
        <kbd className="rounded bg-sunken px-1.5 ring-1 ring-rule">Esc</kbd> to close
      </div>
    </CommandDialog>
  );
}
