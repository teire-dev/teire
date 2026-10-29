import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { LogoMark } from "@/components/logo";
import { SignInButton } from "@/components/sign-in-button";
import { Skeleton } from "@/components/ui/skeleton";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

/**
 * Sign in (plan revision 3.3, U5): GitHub only, and when GitHub or the sign-in fails, why, said here
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
    <div className="flex flex-1 items-start justify-center px-4 py-16 sm:items-center">
      <Suspense fallback={<Skeleton className="h-72 w-full max-w-sm" />}>
        <SignIn searchParams={searchParams} />
      </Suspense>
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
    <section className="flex w-full max-w-sm flex-col gap-6 rounded-xl bg-sheet p-7 shadow-card ring-1 ring-rule ring-inset">
      <div className="flex flex-col gap-3">
        <LogoMark className="size-9" />
        <span className="eyebrow">Sign in</span>
        <h1 className="heading text-2xl text-ink">Sign in to Teire</h1>
        <p className="text-sm text-ink-2">
          GitHub tells Teire which installations and repositories you can see. Teire asks your account for
          nothing else.
        </p>
      </div>
      {said ? (
        <p role="alert" className="rounded-lg bg-broke-soft px-3 py-2 text-sm text-broke">
          {said}
        </p>
      ) : null}
      <SignInButton next={next} label="Continue with GitHub" className="w-full" />
      <div className="flex flex-col gap-1.5 border-t border-rule pt-4 text-xs text-ink-3">
        <Link href="/trust" className="w-fit hover:text-ink">
          What Teire can see and do ›
        </Link>
        <Link href="/scan" className="w-fit hover:text-ink">
          Scan a public repository without signing in ›
        </Link>
      </div>
    </section>
  );
}
