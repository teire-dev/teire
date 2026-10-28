"use client";

import {
  BookOpen,
  ChevronsUpDown,
  FolderGit2,
  GitPullRequestArrow,
  LayoutGrid,
  PlayCircle,
  Search,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark } from "@/components/logo";
import { LiveDot } from "@/components/teire/live-dot";
import { Mark } from "@/components/teire/mark";
import { ThemeToggle } from "@/components/theme-toggle";
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
import { languageMarks } from "@/lib/marks";
import { cn } from "@/lib/utils";

export interface ShellRepo {
  fullName: string;
  live: boolean;
  paused: boolean;
  languages?: unknown;
}

const NAV = [
  { label: "Overview", href: "/kit/overview", icon: LayoutGrid },
  { label: "Repositories", href: "/kit/repo/teire-dev/bristow", icon: FolderGit2 },
  { label: "Changes", href: null, icon: GitPullRequestArrow },
  { label: "Runs", href: "/kit/runs", icon: PlayCircle },
  { label: "Settings", href: null, icon: Settings },
] as const;

/**
 * The app shell as the U0 compositions draw it (plan revision 3.3, "App shell"): a 240px sidebar
 * with the installation switcher, five sections, the repositories with a live dot where Teire is
 * working, and docs, system status and theme at the foot; a top bar with the breadcrumb and ⌘K.
 */
export function KitShell({
  account,
  repos,
  crumbs,
  children,
  aside,
}: {
  account: { login: string; avatarUrl: string | null };
  repos: ShellRepo[];
  crumbs: { label: string; href?: string }[];
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  const path = usePathname();
  return (
    <SidebarProvider style={{ "--sidebar-width": "15rem" } as React.CSSProperties}>
      <Sidebar collapsible="icon" className="border-r border-rule">
        <SidebarHeader className="gap-3">
          <div className="flex items-center gap-2 px-1.5 pt-1">
            <LogoMark className="size-6" />
            <span className="text-[15px] font-semibold tracking-tight text-ink group-data-[collapsible=icon]:hidden">
              Teire
            </span>
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left ring-1 ring-rule ring-inset hover:bg-hover"
            aria-label={`Installation: ${account.login}. Switch installation`}
          >
            {account.avatarUrl ? (
              // biome-ignore lint/performance/noImgElement: a GitHub avatar, 20px
              <img src={account.avatarUrl} alt="" className="size-5 rounded" />
            ) : (
              <span className="size-5 rounded bg-ink" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink group-data-[collapsible=icon]:hidden">
              {account.login}
            </span>
            <ChevronsUpDown
              className="size-3.5 text-ink-3 group-data-[collapsible=icon]:hidden"
              aria-hidden
            />
          </button>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((n) => (
                  <SidebarMenuItem key={n.label}>
                    {n.href ? (
                      <SidebarMenuButton
                        asChild
                        isActive={path.startsWith(n.href.split("/").slice(0, 3).join("/"))}
                      >
                        <Link href={n.href}>
                          <n.icon />
                          <span>{n.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    ) : (
                      <SidebarMenuButton aria-disabled className="opacity-50" title="Built in U3">
                        <n.icon />
                        <span>{n.label}</span>
                      </SidebarMenuButton>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel className="eyebrow">Repositories</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {repos.map((r) => {
                  const href = `/kit/repo/${r.fullName}`;
                  const mark = languageMarks(r.languages)[0];
                  return (
                    <SidebarMenuItem key={r.fullName}>
                      <SidebarMenuButton
                        asChild
                        size="sm"
                        isActive={path === href}
                        className={cn(r.paused && !r.live && "opacity-55")}
                        title={r.paused ? `${r.fullName}: fixes off` : r.fullName}
                      >
                        <Link href={href}>
                          {mark ? (
                            <Mark brand={mark} size="sm" className="size-5 rounded" />
                          ) : (
                            <span className="size-5" />
                          )}
                          <span className="truncate">{r.fullName.split("/")[1]}</span>
                          {r.live ? (
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
          <div className="flex items-center justify-between px-2 text-[11px] text-ink-3 group-data-[collapsible=icon]:hidden">
            <Link href="/trust" className="flex items-center gap-1.5 hover:text-ink">
              <span className="size-1.5 rounded-full bg-proven" aria-hidden />
              All systems running
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
              <span key={c.label} className="flex min-w-0 items-center gap-1.5">
                {i > 0 ? <span className="text-ink-3">/</span> : null}
                {c.href ? (
                  <Link href={c.href} className="truncate text-ink-2 hover:text-ink">
                    {c.label}
                  </Link>
                ) : (
                  <span className="truncate font-medium text-ink">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
          <button
            type="button"
            className="ml-auto hidden h-8 w-64 items-center gap-2 rounded-md bg-sheet px-2.5 text-xs text-ink-3 ring-1 ring-rule ring-inset hover:ring-rule-strong md:flex"
          >
            <Search className="size-3.5" aria-hidden />
            Jump to a repo, run or change…
            <kbd className="ml-auto rounded bg-sunken px-1.5 font-mono text-[10px] text-ink-3 ring-1 ring-rule">
              ⌘K
            </kbd>
          </button>
        </header>
        <div className={cn("flex min-h-0 flex-1", aside ? "xl:pr-0" : "")}>
          <div className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</div>
          {aside}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
