"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BookOpen,
  Check,
  ChevronsUpDown,
  FolderGit2,
  GitCompareArrows,
  LayoutGrid,
  Plus,
  RefreshCw,
  Search,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { refreshMyInstallations, switchInstallation } from "@/app/(app)/app/actions";
import { AssistantMentions } from "@/components/assistant/assistant-provider";
import { LogoMark } from "@/components/logo";
import { SignOutButton } from "@/components/sign-in-button";
import { LiveDot } from "@/components/teire/live-dot";
import { Mark } from "@/components/teire/mark";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import type { AppShellData } from "@/lib/app-shell";
import { languageMarks } from "@/lib/marks";
import { INSTALL_URL } from "@/lib/site";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";

const NAV = [
  { label: "Overview", href: "/app", icon: LayoutGrid, exact: true },
  { label: "Repositories", href: "/app/repos", icon: FolderGit2, exact: false },
  { label: "Changes", href: "/app/changes", icon: GitCompareArrows, exact: false },
  { label: "Runs", href: "/app/runs", icon: Activity, exact: false },
  { label: "Settings", href: "/app/settings", icon: Settings, exact: false },
] as const;

/**
 * The section you are in: navy text on a raised sheet with a chartreuse marker bar at its edge (plan
 * revision 3.4, V4); the olive hairline keeps the chartreuse visible on white.
 */
const ACTIVE =
  "relative before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-cta before:opacity-0 before:shadow-[0_0_0_1px_var(--cta-edge)] before:transition-opacity data-[active=true]:bg-sheet data-[active=true]:font-medium data-[active=true]:text-ink data-[active=true]:shadow-tile data-[active=true]:before:opacity-100";

/** Live poll: every 3 s while Teire is working somewhere, every 30 s otherwise; never while hidden. */
const LIVE_MS = 3000;
const SLOW_LIVE_MS = 5000;
const IDLE_MS = 30_000;

const TAB_LABEL: Record<string, string> = {
  findings: "Findings",
  prs: "Pull requests",
  runs: "Runs",
  inventory: "Inventory",
  providers: "Providers",
  config: "Config",
  activity: "Activity",
};

/** The breadcrumb, from the route: Overview, Repositories › owner/name › tab, Settings. */
function crumbsOf(path: string, account: string | null) {
  const parts = path.split("/").filter(Boolean).slice(1);
  const out: { label: string; href?: string }[] = account ? [{ label: account, href: "/app" }] : [];
  if (!parts.length) return [...out, { label: "Overview" }];
  if (parts[0] === "repos") {
    if (parts.length < 3) return [...out, { label: "Repositories" }];
    const repo = `${parts[1]}/${parts[2]}`;
    return [
      ...out,
      { label: "Repositories", href: "/app/repos" },
      parts[3] ? { label: repo, href: `/app/repos/${repo}` } : { label: repo },
      ...(parts[3] ? [{ label: TAB_LABEL[parts[3] ?? ""] ?? parts[3] ?? "" }] : []),
    ];
  }
  const names: Record<string, string> = { settings: "Settings", changes: "Changes for you", runs: "Runs" };
  return [...out, { label: names[parts[0] ?? ""] ?? parts[0] ?? "" }];
}

/**
 * The app shell (plan revision 3.3, "App shell"): a 240px sidebar with the installation switcher,
 * the sections, the chosen installation's repositories with a live dot where Teire is working, and
 * docs, the worker's status and the theme at the foot; a top bar with the breadcrumb and ⌘K. On a
 * phone the sidebar is a sheet.
 */
export function AppShell({
  data,
  user,
  children,
}: {
  data: AppShellData;
  user?: { name: string; image: string | null };
  children: React.ReactNode;
}) {
  const path = usePathname();
  const router = useRouter();
  const [switching, startSwitch] = useTransition();
  const [palette, setPalette] = useState(false);
  // After ten minutes on a page the live poll slows to 5 s (plan "Live islands": budgeted).
  const [opened] = useState(() => Date.now());
  const live = useQuery({
    queryKey: ["app-live", data.current?.id ?? null],
    queryFn: async () =>
      (await (await fetch("/api/app/live", { cache: "no-store" })).json()) as { live: string[] },
    initialData: { live: data.repos.filter((r) => r.live).map((r) => r.fullName) },
    refetchInterval: (q) =>
      (q.state.data?.live.length ?? 0) > 0
        ? Date.now() - opened > 10 * 60_000
          ? SLOW_LIVE_MS
          : LIVE_MS
        : IDLE_MS,
  });
  const liveSet = new Set(live.data.live);

  useEffect(() => {
    // In the app, ⌘K is this palette (it searches the docs too): caught before the docs' own search
    // dialog, which listens for the same keys, so only one opens.
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        setPalette((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const current = data.current;
  const crumbs = crumbsOf(path, current?.login ?? null);

  return (
    <SidebarProvider style={{ "--sidebar-width": "15rem" } as React.CSSProperties}>
      <Sidebar collapsible="icon" className="border-r border-rule">
        <SidebarHeader className="gap-3">
          <Link href="/" className="flex items-center gap-2 px-1.5 pt-1">
            <LogoMark className="size-6" />
            <span className="text-[15px] font-semibold tracking-tight text-ink group-data-[collapsible=icon]:hidden">
              Teire
            </span>
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={switching}
                className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left ring-1 ring-rule ring-inset outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                aria-label={
                  current ? `Installation: ${current.login}. Switch installation` : "Choose an installation"
                }
              >
                {current?.avatarUrl ? (
                  // biome-ignore lint/performance/noImgElement: a GitHub avatar, 20px
                  <img src={current.avatarUrl} alt="" className="size-5 rounded" />
                ) : (
                  <span className="size-5 rounded bg-ink" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink group-data-[collapsible=icon]:hidden">
                  {current?.login ?? "No installation"}
                </span>
                <ChevronsUpDown
                  className="size-3.5 text-ink-3 group-data-[collapsible=icon]:hidden"
                  aria-hidden
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuLabel className="eyebrow">Installations</DropdownMenuLabel>
              {data.installations.map((i) => (
                <DropdownMenuItem
                  key={i.id}
                  onSelect={() =>
                    startSwitch(async () => {
                      await switchInstallation(i.id);
                      router.refresh();
                    })
                  }
                >
                  {i.avatarUrl ? (
                    // biome-ignore lint/performance/noImgElement: a GitHub avatar, 20px
                    <img src={i.avatarUrl} alt="" className="size-5 rounded" />
                  ) : (
                    <span className="size-5 rounded bg-ink" />
                  )}
                  <span className="truncate">{i.login}</span>
                  {i.suspendedAt ? (
                    <span className="ml-auto font-mono text-[10px] text-attention">suspended</span>
                  ) : null}
                  {i.id === current?.id ? <Check className="ml-auto size-3.5" aria-label="Current" /> : null}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  startSwitch(async () => {
                    await refreshMyInstallations();
                    router.refresh();
                  })
                }
              >
                <RefreshCw className="size-4" aria-hidden />
                Refresh from GitHub
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={INSTALL_URL}>
                  <Plus className="size-4" aria-hidden />
                  Add an account on GitHub
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((n) => (
                  <SidebarMenuItem key={n.label}>
                    <SidebarMenuButton
                      asChild
                      isActive={n.exact ? path === n.href : path.startsWith(n.href)}
                      className={ACTIVE}
                    >
                      <Link href={n.href}>
                        <n.icon />
                        <span>{n.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {data.repos.length ? (
            <SidebarGroup>
              <SidebarGroupLabel className="eyebrow">Repositories</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {data.repos.map((r) => {
                    const href = `/app/repos/${r.fullName}`;
                    const mark = languageMarks(r.languages)[0];
                    const isLive = liveSet.has(r.fullName);
                    const quiet = r.status === "paused" || r.fixMode === "off";
                    return (
                      <SidebarMenuItem key={r.fullName}>
                        <SidebarMenuButton
                          asChild
                          size="sm"
                          isActive={path.startsWith(href)}
                          className={cn(quiet && !isLive && "opacity-55")}
                          title={
                            r.status === "paused"
                              ? `${r.fullName}: paused`
                              : r.fixMode === "off"
                                ? `${r.fullName}: fixes off`
                                : r.fullName
                          }
                        >
                          <Link href={href}>
                            {mark ? (
                              <Mark brand={mark} size="sm" className="size-5 rounded" />
                            ) : (
                              <span className="size-5" />
                            )}
                            <span className="truncate">{r.fullName.split("/")[1]}</span>
                            {isLive ? (
                              <LiveDot className="ml-auto" label={`Teire is working on ${r.fullName}`} />
                            ) : null}
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild size="sm">
                <Link href="/docs">
                  <BookOpen />
                  <span>Docs</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          {user ? (
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton size="sm" aria-label={`Signed in as ${user.name}`}>
                      {user.image ? (
                        // biome-ignore lint/performance/noImgElement: a GitHub avatar, 20px
                        <img src={user.image} alt="" className="size-5 rounded-full" />
                      ) : (
                        <span className="size-5 rounded-full bg-ink" />
                      )}
                      <span className="truncate">{user.name}</span>
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start" className="w-52">
                    <DropdownMenuItem asChild>
                      <Link href="/app/settings">Settings</Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <SignOutButton />
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          ) : null}
          <div className="flex items-center justify-between px-2 text-[11px] text-ink-3 group-data-[collapsible=icon]:hidden">
            <Link href="/trust" className="flex items-center gap-1.5 hover:text-ink">
              <span
                className={cn("size-1.5 rounded-full", data.system.alive ? "bg-proven" : "bg-broke")}
                aria-hidden
              />
              {data.system.label}
            </Link>
            <ThemeToggle />
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0 bg-canvas">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-rule bg-canvas/90 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1 text-ink-2" />
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            {crumbs.map((c, i) => (
              <span key={`${c.href ?? ""}:${c.label}`} className="flex min-w-0 items-center gap-1.5">
                {i > 0 ? <span className="text-ink-3">/</span> : null}
                {c.href ? (
                  <Link href={c.href} className="truncate text-ink-2 hover:text-ink">
                    {c.label}
                  </Link>
                ) : (
                  <span className="truncate font-medium text-ink" aria-current="page">
                    {c.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="ml-auto flex h-8 items-center gap-2 rounded-md bg-sheet px-2.5 text-xs text-ink-3 ring-1 ring-rule ring-inset hover:ring-rule-strong md:w-64"
            aria-label="Search and jump (⌘K)"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="hidden md:inline">Jump to a repo, page or doc…</span>
            <kbd className="ml-auto hidden rounded bg-sunken px-1.5 font-mono text-[10px] text-ink-3 ring-1 ring-rule md:inline">
              ⌘K
            </kbd>
          </button>
        </header>
        {current?.suspendedAt ? (
          // Said on every page, not only a repository's (U4 review): nothing runs while it's suspended.
          <p className="border-b border-attention/30 bg-attention-soft px-4 py-2 text-sm text-attention md:px-8">
            {current.login}'s installation is suspended on GitHub: Teire scans nothing and opens nothing until
            it's unsuspended in GitHub's settings.
          </p>
        ) : null}
        <div className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</div>
      </SidebarInset>
      <AssistantMentions
        mentions={[
          ...data.repos.map((r) => ({ kind: "repo" as const, id: r.fullName, label: r.fullName })),
          ...data.changes.map((c) => ({ kind: "change" as const, id: c.id, label: c.title })),
          ...data.prs.map((p) => ({
            kind: "pr" as const,
            id: `${p.repo}#${p.number}`,
            label: `${p.repo}#${p.number}`,
          })),
          ...data.runs.map((r) => ({
            kind: "run" as const,
            id: r.id,
            label: `${r.repo} ${r.groupKey ?? ""}`.trim(),
          })),
        ]}
      />
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        repos={data.repos}
        runs={data.runs}
        changes={data.changes}
      />
    </SidebarProvider>
  );
}
