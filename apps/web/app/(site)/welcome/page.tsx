import { and, desc, eq, repos, scans, sql, userInstallations } from "@teire/db";
import { CheckCircle2, Loader } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { SignInButton } from "@/components/sign-in-button";
import { Button } from "@/components/ui/button";
import { refreshInstallations } from "@/lib/auth";
import { database } from "@/lib/db";
import { getSession } from "@/lib/session";

export const metadata = { title: "Welcome" };

/**
 * GitHub's setup URL after an install (C1, rule 11): each selected repository's first scan, live,
 * then the Configure Teire PR it opens. GitHub passes `installation_id` and `setup_action`.
 */
export default function Welcome({ searchParams }: PageProps<"/welcome">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-14">
      <Suspense fallback={<div className="h-72 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <Progress searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Progress({ searchParams }: { searchParams: PageProps<"/welcome">["searchParams"] }) {
  const params = await searchParams;
  const updated = params.setup_action === "update";
  const installationId = Number(typeof params.installation_id === "string" ? params.installation_id : NaN);
  const heading = (
    <header className="flex flex-col gap-3">
      <h1 className="text-3xl font-semibold tracking-tight">
        {updated ? "Teire's access is updated." : "Teire is installed."}
      </h1>
      <p className="text-subtle">
        Teire is reading each repository you gave it: the exact versions your lockfiles pin, what newer
        versions change, and which of your lines use what changed. Each repository then gets a pull request
        named <span className="font-mono">Configure Teire</span> with what it found. Merge it to turn Teire
        on.
      </p>
    </header>
  );
  const session = await getSession();
  if (!session)
    return (
      <>
        {heading}
        <section className="flex flex-col items-start gap-3 rounded-lg bg-card p-5 shadow-card">
          <p className="text-sm text-muted-foreground">Sign in to watch each repository's first scan here.</p>
          <SignInButton
            next={`/welcome?installation_id=${Number.isFinite(installationId) ? installationId : ""}`}
            label="Sign in with GitHub"
          />
        </section>
      </>
    );
  const db = database();
  const visible = async () =>
    Number.isFinite(installationId)
      ? (
          await db
            .select()
            .from(userInstallations)
            .where(
              and(
                eq(userInstallations.userId, session.user.id),
                eq(userInstallations.installationId, installationId),
              ),
            )
            .limit(1)
        )[0]
      : undefined;
  let allowed = await visible();
  // A brand-new installation is not in the list read at sign-in: ask GitHub again, once.
  if (!allowed && Number.isFinite(installationId)) {
    await refreshInstallations(session.user.id).catch(() => undefined);
    allowed = await visible();
  }
  // A private repository shows only to people GitHub lists for it (U3 review).
  const rows = allowed
    ? await db
        .select()
        .from(repos)
        .where(
          and(
            eq(repos.installationId, installationId),
            sql`(not "repos"."is_private" or exists (select 1 from user_repos ur where ur.user_id = ${session.user.id} and ur.repo_id = "repos"."id"))`,
          ),
        )
        .orderBy(repos.fullName)
    : [];
  const latest = await Promise.all(
    rows.map(async (r) => {
      const [scan] = await db
        .select()
        .from(scans)
        .where(eq(scans.repoId, r.id))
        .orderBy(desc(scans.createdAt))
        .limit(1);
      return { repo: r, scan: scan ?? null };
    }),
  );
  const pending = latest.some((l) => !l.scan || l.scan.status === "running" || l.scan.status === "queued");
  return (
    <>
      {heading}
      <section className="flex flex-col gap-3" aria-live="polite">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          First scans
          {pending ? (
            <span className="text-xs font-normal text-muted-foreground">
              · updating · <AutoRefresh since={new Date().toISOString()} everyMs={4000} />
            </span>
          ) : null}
        </h2>
        {latest.length ? (
          <ul className="divide-y overflow-hidden rounded-lg bg-card shadow-card">
            {latest.map(({ repo, scan }) => (
              <li key={repo.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  {scan?.status === "done" ? (
                    <CheckCircle2 className="size-4 shrink-0 text-clear" aria-hidden />
                  ) : scan?.status === "failed" ? (
                    <span className="size-2 shrink-0 rounded-full bg-affected" aria-hidden />
                  ) : (
                    <Loader className="size-4 shrink-0 animate-spin text-running" aria-hidden />
                  )}
                  <span className="truncate font-mono">{repo.fullName}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                  {scan?.status === "done"
                    ? "scanned"
                    : scan?.status === "failed"
                      ? "scan failed"
                      : "scanning"}
                  <Link href={`/app/repos/${repo.fullName}`} className="text-link hover:underline">
                    Open
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg bg-card p-5 text-sm text-muted-foreground shadow-card">
            {allowed
              ? "GitHub is still sending the repository list; this page updates in a moment."
              : "Teire is setting up. Your repositories appear in the dashboard as soon as GitHub confirms the installation."}
          </p>
        )}
      </section>
      <div className="flex flex-wrap gap-3">
        <Button asChild shape="pill">
          <Link href="/app">Open the dashboard</Link>
        </Button>
        <Button asChild shape="pill" variant="outline">
          <Link href="/docs">Read how Teire works</Link>
        </Button>
      </div>
    </>
  );
}
