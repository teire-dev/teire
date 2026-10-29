import Link from "next/link";
import { Suspense } from "react";
import { HeaderTone } from "@/components/header-tone";
import { Logo } from "@/components/logo";
import { MobileMenu } from "@/components/mobile-menu";
import { NavLinks } from "@/components/nav-links";
import { SignInButton, SignOutButton } from "@/components/sign-in-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getSession } from "@/lib/session";
import { NAV } from "@/lib/site";

/**
 * The floating pill bar on every page (plan revision 3.4, V1): home, the public sections, theme and
 * the person's menu. Over a navy hero band it turns transparent with ice-white ink (`over-hero`); on
 * phones the sections move into a sheet.
 */
export function SiteHeader() {
  return (
    <header data-site-header className="sticky top-0 z-40 h-16 px-3 pt-3">
      <HeaderTone />
      <div className="mx-auto flex h-[52px] w-full max-w-6xl items-center gap-3 rounded-full bg-sheet/85 pr-2 pl-4 shadow-float backdrop-blur-md transition-[background-color,box-shadow] duration-300 over-hero:bg-white/6 over-hero:shadow-[inset_0_0_0_1px_var(--hero-rule)]">
        <Logo className="over-hero:text-hero-ink" />
        <div className="hidden md:block">
          <Suspense fallback={<StaticNav />}>
            <NavLinks links={NAV} />
          </Suspense>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle className="over-hero:text-hero-ink-2 over-hero:hover:bg-white/10 over-hero:hover:text-hero-ink" />
          <Suspense fallback={<div className="h-8 w-20 rounded-full shimmer" aria-hidden />}>
            <Account />
          </Suspense>
          <MobileMenu links={NAV} />
        </div>
      </div>
    </header>
  );
}

/** The nav before the current path is known (prerendered shell): the same links, none marked. */
function StaticNav() {
  return (
    <nav aria-label="Main" className="flex items-center gap-1 text-sm">
      {NAV.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="rounded-full px-3 py-1.5 text-ink-2 hover:bg-hover hover:text-ink over-hero:text-hero-ink-2"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

async function Account() {
  const session = await getSession();
  if (!session)
    return (
      <SignInButton
        shape="pill"
        size="sm"
        next="/app"
        className="h-8 px-3.5 over-hero:bg-white over-hero:text-brand over-hero:hover:bg-white/90"
      />
    );
  const { name, image, email } = session.user;
  return (
    <div className="flex items-center gap-2">
      <Button
        asChild
        size="sm"
        shape="pill"
        className="hidden h-8 sm:inline-flex over-hero:bg-white over-hero:text-brand"
      >
        <Link href="/app">Dashboard</Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Account"
        >
          <Avatar className="size-7">
            {image ? <AvatarImage src={image} alt="" /> : null}
            <AvatarFallback className="text-xs">{(name || email).slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
            {name || email}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/app">Dashboard</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/app/repos">Repositories</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/app/settings">Settings</Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <SignOutButton />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
