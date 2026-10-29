import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConnectDiagram } from "@/components/brand/beam";
import { BrandLogo } from "@/components/brand-logo";
import { LogoMark } from "@/components/logo";
import { SignInButton } from "@/components/sign-in-button";
import { Skeleton } from "@/components/ui/skeleton";
import { ECOSYSTEMS } from "@/lib/brands";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

/**
 * Sign in (plan revision 3.4, V1; 21st "Split Sign In Form" 39096's two-panel layout, OAuth only): the
 * GitHub button on the left, and on the right what signing in means, drawn: GitHub tells Teire which
 * repositories you can see. When GitHub or the sign-in fails, why is said here in full (decision text),
 * rather than on a default error page (Better Auth sends its errors to this page, `onAPIError`).
 */
const SAID: Record<string, string> = {
  access_denied: "You cancelled on GitHub, so nothing was shared. Sign in again when you're ready.",
  state_mismatch: "The sign-in expired or was opened in another tab. Start it again from here.",
  please_restart_the_process: "The sign-in expired or was opened in another tab. Start it again from here.",
  invalid_code: "GitHub's answer had expired by the time it arrived. Start it again from here.",
  no_code: "GitHub didn't send the sign-in back. Start it again from here.",
  unable_to_get_user_info: "GitHub didn't share your profile with Teire. Try again in a moment.",
  email_not_found:
    "GitHub didn't share an email for your account. Add a verified email on GitHub (it can stay private), then sign in again.",
  email_not_verified: "Your GitHub email isn't verified yet. Verify it on GitHub, then sign in again.",
  account_already_linked_to_different_user:
    "This GitHub account is already linked to another Teire sign-in. Sign out there first.",
  unable_to_link_account:
    "Teire couldn't link this GitHub account. Try again, or sign in with the other account.",
};

/** Only a path inside Teire is a place to go next, never another site. */
const safeNext = (next: unknown) =>
  typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/app";

export default function SignInPage({ searchParams }: PageProps<"/signin">) {
  return (
    <div className="mx-auto grid w-full max-w-6xl flex-1 items-stretch gap-6 px-4 py-10 lg:grid-cols-2 lg:py-14">
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <SignIn searchParams={searchParams} />
      </Suspense>
      <aside className="relative hidden overflow-hidden rounded-feature bg-hero p-10 text-hero-ink lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_70%_at_70%_20%,#0a2a8a_0%,transparent_70%)]" />
        <p className="relative max-w-xs text-[15px] text-hero-ink-2">
          GitHub tells Teire which repositories you can see.
        </p>
        <ConnectDiagram
          className="relative my-10 px-4"
          repos={[ECOSYSTEMS.npm, ECOSYSTEMS.pypi, ECOSYSTEMS.go].filter(Boolean).map((e) => ({
            key: e?.label ?? "",
            node: (
              <BrandLogo light={e?.light ?? ""} dark={e?.dark} alt={e?.label ?? ""} className="h-5 max-w-7" />
            ),
          }))}
        />
        <p className="relative font-mono text-[12px] text-hero-ink-2/80">
          Nothing else is asked of your account.
        </p>
      </aside>
    </div>
  );
}

async function SignIn({ searchParams }: { searchParams: PageProps<"/signin">["searchParams"] }) {
  await connection();
  const [params, session] = await Promise.all([searchParams, getSession()]);
  const next = safeNext(params.next);
  if (session) redirect(next);
  const code = typeof params.error === "string" ? params.error.toLowerCase() : null;
  const said = code
    ? (SAID[code] ?? `Signing in didn't finish (${code.slice(0, 60)}). Try again from here.`)
    : null;
  return (
    <section className="flex flex-col justify-center gap-8 rounded-feature bg-sheet p-8 shadow-card sm:p-12">
      <LogoMark className="size-11" />
      <h1 className="display text-5xl">Sign in</h1>
      {said ? (
        <p role="alert" className="rounded-card bg-broke-soft px-4 py-3 text-sm text-broke">
          {said}
        </p>
      ) : null}
      <SignInButton
        next={next}
        label="Continue with GitHub"
        variant="cta"
        size="xl"
        shape="pill"
        className="w-full sm:w-auto sm:self-start"
      />
      <nav aria-label="Without signing in" className="flex flex-wrap gap-2">
        <Link
          href="/trust"
          className="rounded-full bg-sunken px-3 py-1 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          What Teire can see
        </Link>
        <Link
          href="/scan"
          className="rounded-full bg-sunken px-3 py-1 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          Scan without signing in
        </Link>
      </nav>
    </section>
  );
}
