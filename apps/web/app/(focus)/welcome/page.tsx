import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { GithubMark } from "@/components/icons";
import { LogoMark } from "@/components/logo";
import { SignInButton } from "@/components/sign-in-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Onboarding } from "@/components/welcome/onboarding";
import { getSession } from "@/lib/session";
import { INSTALL_URL } from "@/lib/site";
import { welcomeOf } from "@/lib/welcome";

export const metadata = { title: "Welcome" };

/**
 * GitHub's setup URL after an install (C1, rule 11, plan revision 3.3 U5): the welcome flow for the
 * installation GitHub names (`installation_id`, `setup_action`), or the one chosen last when someone
 * comes back to finish it.
 */
export default function Welcome({ searchParams }: PageProps<"/welcome">) {
  return (
    <main className="flex flex-1 flex-col">
      <Suspense
        fallback={
          <div className="flex flex-col gap-6" role="status" aria-label="Loading">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-56 w-full" />
          </div>
        }
      >
        <Flow searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Flow({ searchParams }: { searchParams: PageProps<"/welcome">["searchParams"] }) {
  await connection();
  const [params, session] = await Promise.all([searchParams, getSession()]);
  const raw = typeof params.installation_id === "string" ? Number(params.installation_id) : Number.NaN;
  const asked = Number.isFinite(raw) ? raw : null;
  const updated = params.setup_action === "update";
  if (!session)
    return (
      <Card title="Teire is installed." eyebrow="Welcome">
        <p className="text-sm text-ink-2">Sign in with the GitHub account that installed it.</p>
        <SignInButton
          next={`/welcome${asked ? `?installation_id=${asked}` : ""}`}
          label="Sign in with GitHub"
          variant="cta"
          size="xl"
          shape="pill"
        />
      </Card>
    );
  const data = await welcomeOf(session.user.id, asked);
  if (data.state === "not-visible")
    return (
      <Card title="Not visible to you yet." eyebrow="Welcome">
        <p className="text-sm text-ink-2">
          Someone else may have installed it. Ask them to add you on GitHub.
        </p>
        <Button asChild>
          <Link href="/app">Open the dashboard</Link>
        </Button>
      </Card>
    );
  if (data.state === "none")
    return (
      <Card title="Install Teire first." eyebrow="Welcome">
        <span className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="cta" size="xl" shape="pill">
            <a href={INSTALL_URL}>
              <GithubMark data-icon="inline-start" />
              Install on GitHub
            </a>
          </Button>
          <Button asChild variant="outline" size="xl" shape="pill">
            <Link href="/scan">Scan a repo first</Link>
          </Button>
        </span>
      </Card>
    );
  return <Onboarding data={data} updated={updated} />;
}

function Card({ title, children }: { title: string; eyebrow?: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto my-auto flex w-full max-w-md flex-col items-center gap-5 rounded-feature bg-sheet p-9 text-center shadow-card">
      <LogoMark className="size-11" />
      <h1 className="display text-4xl text-ink">{title}</h1>
      {children}
    </section>
  );
}
