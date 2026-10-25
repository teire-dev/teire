import Link from "next/link";
import { Suspense } from "react";
import { Logo } from "@/components/logo";
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

/** Sticky top bar on every page: home, the public sections, theme, and the person's menu. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
        <Logo />
        <div className="hidden md:block">
          <Suspense fallback={<StaticNav />}>
            <NavLinks links={NAV} />
          </Suspense>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <Suspense fallback={<div className="h-8 w-20 rounded-md bg-muted" aria-hidden />}>
            <Account />
          </Suspense>
        </div>
      </div>
      <div className="border-t px-2 py-1 md:hidden">
        <Suspense fallback={<StaticNav />}>
          <NavLinks links={NAV} />
        </Suspense>
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
          className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

async function Account() {
  const session = await getSession();
  if (!session) return <SignInButton variant="outline" size="sm" next="/app" />;
  const { name, image, email } = session.user;
  return (
    <div className="flex items-center gap-2">
      <Button asChild size="sm" variant="outline">
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
