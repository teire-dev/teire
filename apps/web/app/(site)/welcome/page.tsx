import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { GithubMark } from "@/components/icons";
import { SignInButton } from "@/components/sign-in-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WelcomeFlow } from "@/components/welcome/welcome-flow";
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
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-14">
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
        <p className="text-sm text-ink-2">
          Sign in with the same GitHub account to watch each repository's first scan and choose how Teire
          fixes.
        </p>
        <SignInButton
          next={`/welcome${asked ? `?installation_id=${asked}` : ""}`}
          label="Sign in with GitHub"
        />
      </Card>
    );
  const data = await welcomeOf(session.user.id, asked);
  if (data.state === "not-visible")
    return (
      <Card title="This installation isn't visible to you yet." eyebrow="Welcome">
        <p className="text-sm text-ink-2">
          Someone else may have installed Teire on that account, or GitHub hasn't told Teire yet. Ask them to
          add you on GitHub, or open the dashboard in a minute.
        </p>
        <Button asChild>
          <Link href="/app">Open the dashboard</Link>
        </Button>
      </Card>
    );
  if (data.state === "none")
    return (
      <Card title="Install Teire on a repository." eyebrow="Welcome">
        <p className="text-sm text-ink-2">
          Pick the account and the repositories on GitHub; Teire comes back here with each one's first scan.
        </p>
        <span className="flex flex-wrap gap-2">
          <Button asChild>
            <a href={INSTALL_URL}>
              <GithubMark data-icon="inline-start" />
              Install on GitHub
            </a>
          </Button>
          <Button asChild variant="outline">
            <Link href="/scan">Scan a public repository first</Link>
          </Button>
        </span>
      </Card>
    );
  return <WelcomeFlow data={data} updated={updated} />;
}

function Card({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col items-start gap-4 rounded-xl bg-sheet p-6 shadow-card">
      <span className="eyebrow">{eyebrow}</span>
      <h1 className="font-mono text-2xl font-medium tracking-tight text-ink uppercase">{title}</h1>
      {children}
    </section>
  );
}
