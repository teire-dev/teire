"use client";

import type { ActionKind } from "@teire/engine/actions";
import { describeAction } from "@teire/engine/actions";
import {
  Activity,
  BookOpen,
  FolderGit2,
  GitCompareArrows,
  GitPullRequestArrow,
  LayoutGrid,
  PauseCircle,
  RefreshCw,
  Settings,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAssistant } from "@/components/assistant/assistant-provider";
import { useDocsSearch } from "@/components/docs/use-docs-search";
import { MiniFlow } from "@/components/flow/mini-flow";
import { LogoMark } from "@/components/logo";
import { LiveDot } from "@/components/teire/live-dot";
import { Mark } from "@/components/teire/mark";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import type { Brand } from "@/lib/brands";
import { changeBrand } from "@/lib/estate";
import { FIX_MODE_LABEL, FIX_MODES } from "@/lib/fix-mode-options";
import { languageMarks, subjectMark } from "@/lib/marks";
import type { Proof } from "@/lib/proof";
import { cn } from "@/lib/utils";
import { runAction } from "./run-action";

const PAGES = [
  { label: "Overview", href: "/app", icon: LayoutGrid },
  { label: "Repositories", href: "/app/repos", icon: FolderGit2 },
  { label: "Changes for you", href: "/app/changes", icon: GitCompareArrows },
  { label: "Runs", href: "/app/runs", icon: Activity },
  { label: "Runs that need you", href: "/app/runs?show=needs-you", icon: Activity },
  { label: "Settings", href: "/app/settings", icon: Settings },
  { label: "Usage", href: "/app/settings/usage", icon: Settings },
  { label: "Account", href: "/app/settings/account", icon: Settings },
  { label: "Docs", href: "/docs", icon: BookOpen },
  { label: "Trust: how Teire runs", href: "/trust", icon: ShieldCheck },
] as const;

const MODES = FIX_MODES.map((m) => [m.value, m.label] as const);

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

/** A row's icon on a small tile, so every row starts with the same square (pages, actions, docs). */
function Square({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sunken text-ink-2 ring-1 ring-rule ring-inset [&_svg]:size-3.5">
      {children}
    </span>
  );
}

/** A repository by its main language's logo, as the sidebar marks it. */
function RepoMark({ languages }: { languages: unknown }) {
  const mark = languageMarks(languages)[0];
  return mark ? (
    <Mark brand={mark} size="sm" className="size-6 shrink-0 rounded-md" />
  ) : (
    <Square>
      <FolderGit2 />
    </Square>
  );
}

/** A change by its provider's or ecosystem's logo. */
function ChangeMark({ brand }: { brand: Brand | undefined }) {
  return brand ? (
    <Mark brand={brand} size="sm" className="size-6 shrink-0 rounded-md" />
  ) : (
    <Square>
      <GitPullRequestArrow />
    </Square>
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
  runs = [],
  changes = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: { fullName: string; fixMode: string; status?: string; languages?: unknown; live?: boolean }[];
  runs?: { id: string; repo: string; groupKey: string | null; status: string }[];
  changes?: { id: string; title: string; repos: number; provider: string | null; ecosystem: string | null }[];
}) {
  const router = useRouter();
  const path = usePathname();
  const assistant = useAssistant();
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<{
    kind: ActionKind;
    params: Record<string, unknown>;
    repo: string;
  } | null>(null);
  const here = /^\/app\/repos\/([\w.-]+\/[\w.-]+)/.exec(path)?.[1] ?? null;
  const repo = here ? repos.find((r) => r.fullName === here) : undefined;

  const docs = useDocsSearch(query, { enabled: open });
  // The proof chains load when the palette first opens, never on every page (V5–V6 review).
  const [chains, setChains] = useState<
    { id: string; repo: string; groupKey: string | null; proof: Proof }[] | null
  >(null);
  useEffect(() => {
    if (!open || chains) return;
    let alive = true;
    fetch("/api/app/palette", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { runs: NonNullable<typeof chains> }).runs : []))
      .then((list) => alive && setChains(list))
      .catch(() => alive && setChains([]));
    return () => {
      alive = false;
    };
  }, [open, chains]);
  const proofOf = new Map((chains ?? []).map((c) => [c.id, c.proof]));
  // Each repository's newest run (the list is newest first).
  const latestOf = new Map<string, { proof: Proof; groupKey: string | null }>();
  for (const c of chains ?? []) if (!latestOf.has(c.repo)) latestOf.set(c.repo, c);

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
        <Command>
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
        </Command>
      </CommandDialog>
    );

  const hits = docs.hits;
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Jump"
      description="Pages, repositories, actions and docs"
    >
      <Command>
        <CommandInput value={query} onValueChange={setQuery} placeholder="Jump to a repo, page or doc…" />
        <CommandList>
          {/* Docs hits are force-mounted, so cmdk never counts them: empty only when they're empty too. */}
          {hits.length ? null : (
            <CommandEmpty>
              {query.trim().length >= 2 && docs.searching ? "Searching the docs…" : "Nothing matches."}
            </CommandEmpty>
          )}
          {repo ? (
            <CommandGroup heading={`On ${repo.fullName}`}>
              <CommandItem
                value={`rescan ${repo.fullName}`}
                onSelect={() => setConfirm({ kind: "rescan", params: {}, repo: repo.fullName })}
              >
                <Square>
                  <RefreshCw />
                </Square>
                Rescan now
              </CommandItem>
              <CommandItem
                value={`pause ${repo.fullName}`}
                onSelect={() =>
                  setConfirm({
                    kind: repo.status === "paused" ? "resume" : "pause",
                    params: {},
                    repo: repo.fullName,
                  })
                }
              >
                <Square>
                  <PauseCircle />
                </Square>
                {repo.status === "paused" ? "Resume Teire here" : "Pause Teire here"}
              </CommandItem>
              {MODES.filter(([m]) => m !== repo.fixMode).map(([m, label]) => (
                <CommandItem
                  key={m}
                  value={`fix mode ${label} ${repo.fullName}`}
                  onSelect={() =>
                    setConfirm({ kind: "set-fix-mode", params: { mode: m }, repo: repo.fullName })
                  }
                >
                  <Square>
                    <Wrench />
                  </Square>
                  <span className="flex items-center gap-1.5 font-mono text-xs">
                    <span className="text-ink-3 line-through">
                      {FIX_MODE_LABEL[repo.fixMode as keyof typeof FIX_MODE_LABEL] ?? repo.fixMode}
                    </span>
                    →<span className="text-ink">{label}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          <CommandGroup heading="Go to">
            {PAGES.map((p) => (
              <CommandItem key={p.href} value={`go ${p.label}`} onSelect={() => go(p.href)}>
                <Square>
                  <p.icon />
                </Square>
                {p.label}
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
                  <RepoMark languages={r.languages} />
                  <span className="truncate">{r.fullName}</span>
                  {r.live ? <LiveDot className="ml-1" /> : null}
                  {latestOf.get(r.fullName) ? (
                    <MiniFlow
                      proof={latestOf.get(r.fullName)?.proof as Proof}
                      subject={subjectMark(latestOf.get(r.fullName)?.groupKey ?? null)}
                      size="xs"
                      className="ml-auto hidden shrink-0 sm:inline-flex"
                    />
                  ) : null}
                  <CommandShortcut>
                    <span className={cn(r.fixMode === "auto" ? "text-proven" : "text-ink-3")}>
                      {FIX_MODE_LABEL[r.fixMode as keyof typeof FIX_MODE_LABEL] ?? r.fixMode}
                    </span>
                  </CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {changes.length ? (
            <CommandGroup heading="Changes reaching your code">
              {changes.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`change ${c.title} ${c.id}`}
                  onSelect={() => go(`/changes/${c.id}`)}
                >
                  <ChangeMark brand={changeBrand(c)} />
                  <span className="truncate">{c.title}</span>
                  <CommandShortcut className="whitespace-nowrap">
                    {c.repos} repo{c.repos === 1 ? "" : "s"}
                  </CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {runs.length ? (
            <CommandGroup heading="Recent runs">
              {runs.map((r) => (
                <CommandItem
                  key={r.id}
                  value={`run ${r.repo} ${r.groupKey ?? ""}`}
                  onSelect={() => go(`/runs/${r.id}`)}
                >
                  {proofOf.get(r.id) ? (
                    <MiniFlow
                      proof={proofOf.get(r.id) as Proof}
                      subject={subjectMark(r.groupKey)}
                      size="xs"
                      className="shrink-0"
                    />
                  ) : (
                    <Square>
                      <Activity />
                    </Square>
                  )}
                  <span className="truncate font-mono text-xs">{r.groupKey ?? r.repo}</span>
                  <CommandShortcut>{r.repo.split("/")[1]}</CommandShortcut>
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
                  className="items-start"
                >
                  <Square>
                    <BookOpen />
                  </Square>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-mono text-[11px] text-ink-3">
                      {(h.breadcrumbs ?? []).join(" › ")}
                    </span>
                    <span className="line-clamp-2 text-sm text-ink-2">
                      <Snippet text={h.content} query={query.trim()} />
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {/* The last row is always Ask Teire (plan revision 3.3, "⌘K palette"): the query goes to it. */}
          <CommandGroup heading="Ask" forceMount>
            <CommandItem
              value={`ask-teire ${query}`}
              forceMount
              onSelect={() => {
                onOpenChange(false);
                if (query.trim()) assistant.ask(query.trim());
                else assistant.setOpen(true);
              }}
            >
              <LogoMark className="size-4" />
              <span className="truncate text-ink">
                {query.trim() ? (
                  <>
                    Ask Teire: <span className="font-medium">{query.trim()}</span>
                  </>
                ) : (
                  "Ask Teire…"
                )}
              </span>
              <CommandShortcut>⌘I</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
      <div className="flex items-center justify-end gap-1.5 border-t border-rule px-3 py-2 font-mono text-[11px] text-ink-3">
        <kbd className="rounded bg-sunken px-1.5 ring-1 ring-rule">Esc</kbd> to close
      </div>
    </CommandDialog>
  );
}
