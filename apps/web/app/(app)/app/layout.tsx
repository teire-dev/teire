import { Suspense } from "react";
import { AppShell } from "@/components/app/app-shell";
import { AppProviders } from "@/components/app/providers";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Skeleton } from "@/components/ui/skeleton";
import { appShell } from "@/lib/app-shell";
import { getSession } from "@/lib/session";

/**
 * The app (plan revision 3.3, U1): signed in with an installation, the app shell (sidebar, switcher,
 * ⌘K, live dots); signed out or with nothing installed, the site's own header around the page, which
 * then shows sign-in or install.
 */
export default function AppLayout({ children }: LayoutProps<"/app">) {
  return (
    <AppProviders>
      <Suspense fallback={<ShellLoading />}>
        <Shell>{children}</Shell>
      </Suspense>
    </AppProviders>
  );
}

async function Shell({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const data = session ? await appShell(session.user.id) : null;
  if (!data?.installations.length)
    return (
      <>
        <SiteHeader />
        <div className="flex flex-1 flex-col px-4 py-10">{children}</div>
        <SiteFooter />
      </>
    );
  return (
    <AppShell data={data} user={{ name: session?.user.name ?? "", image: session?.user.image ?? null }}>
      {children}
    </AppShell>
  );
}

/** The shell's shape while it loads: sidebar, top bar, a page of rows. */
function ShellLoading() {
  return (
    <div className="flex min-h-svh bg-canvas" role="status" aria-label="Loading">
      <div className="hidden w-60 shrink-0 flex-col gap-3 border-r border-rule p-3 md:flex">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-9 w-full" />
        {["a", "b", "c"].map((k) => (
          <Skeleton key={k} className="h-7 w-full" />
        ))}
      </div>
      <div className="flex flex-1 flex-col">
        <div className="h-12 border-b border-rule" />
        <div className="flex flex-col gap-3 p-8">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
