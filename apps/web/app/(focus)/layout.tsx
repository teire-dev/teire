import Link from "next/link";
import { Logo } from "@/components/logo";

/**
 * A focused task (plan revision 3.4, V2): onboarding gets the whole screen — the mark, and a way out —
 * without the site's navigation or footer.
 */
export default function FocusLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-svh flex-1 flex-col bg-canvas">
      <header className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-5">
        <Logo />
        <Link
          href="/app"
          className="rounded-full px-3 py-1.5 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          Exit
        </Link>
      </header>
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-5 pb-6">{children}</div>
    </div>
  );
}
