import Link from "next/link";
import { Suspense } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { Badge } from "@/components/ui/badge";
import { myRepos } from "@/lib/dashboard";
import { ago, languageBrands } from "@/lib/languages";
import { getSession } from "@/lib/session";
import { ActionButton } from "../action-button";
import { InstallCard, SignInCard } from "../gate";
import { SubNav } from "../sub-nav";

export const metadata = { title: "Repositories" };

/** Every repository Teire watches for you, grouped by what it needs (Linear 4a094449, Vercel 8c510eb3). */
export default function ReposPage({ searchParams }: PageProps<"/app/repos">) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-10">
      <SubNav />
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <Repos searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

type Repo = Awaited<ReturnType<typeof myRepos>>[number];

async function Repos({ searchParams }: { searchParams: PageProps<"/app/repos">["searchParams"] }) {
  const session = await getSession();
  if (!session) return <SignInCard next="/app/repos" />;
  const [rows, params] = await Promise.all([myRepos(session.user.id), searchParams]);
  if (!rows.length) return <InstallCard />;
  const q = typeof params.q === "string" ? params.q.toLowerCase() : "";
  const shown = rows.filter((r) => !q || r.fullName.toLowerCase().includes(q));
  const groups: [string, Repo[]][] = [
    ["Action needed", shown.filter((r) => r.affected > 0 && r.status !== "paused")],
    [
      "Setting up",
      shown.filter((r) => r.affected === 0 && (r.status === "detected" || r.status === "onboarding")),
    ],
    ["Up to date", shown.filter((r) => r.affected === 0 && r.status === "active")],
    ["Paused", shown.filter((r) => r.status === "paused" || r.status === "disabled")],
  ];
  const queued = typeof params.queued === "string" ? params.queued : null;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
        <form action="/app/repos">
          <input
            name="q"
            defaultValue={q}
            placeholder="Filter by name"
            aria-label="Filter repositories"
            className="h-8 rounded-md border bg-transparent px-2.5 text-sm"
          />
        </form>
      </div>
      {queued ? (
        <p className="rounded-md bg-running-soft px-3 py-2 text-sm text-running">Queued: {queued}.</p>
      ) : null}
      {groups.map(([title, list]) =>
        list.length ? (
          <section key={title} className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">
              {title} <span className="text-muted-foreground">({list.length})</span>
            </h2>
            <ul className="divide-y overflow-hidden rounded-lg bg-card shadow-card">
              {list.map((r) => (
                <li key={r.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[1.4fr_1fr_auto] sm:items-center">
                  <div className="min-w-0">
                    <Link
                      href={`/app/repos/${r.fullName}`}
                      className="block truncate font-mono text-sm entity-link"
                    >
                      {r.fullName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {r.dependencies} dependencies · scanned {ago(r.lastScannedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <span className="flex items-center gap-1.5">
                      {languageBrands(r.languages).map((b) => (
                        <BrandLogo key={b.key} light={b.light} dark={b.dark} alt={b.label} className="h-4" />
                      ))}
                    </span>
                    <span className={r.affected ? "text-affected" : "text-muted-foreground"}>
                      {r.affected} affected
                    </span>
                    <span className="text-muted-foreground">{r.openPrs} PRs</span>
                    <Badge
                      variant={r.status === "active" ? "clear" : r.status === "paused" ? "quiet" : "running"}
                    >
                      {r.status}
                    </Badge>
                  </div>
                  <div className="flex gap-2">
                    <ActionButton repo={r.fullName} action="rescan" back="/app/repos">
                      Rescan
                    </ActionButton>
                    <ActionButton
                      repo={r.fullName}
                      action={r.status === "paused" ? "resume" : "pause"}
                      back="/app/repos"
                    >
                      {r.status === "paused" ? "Resume" : "Pause"}
                    </ActionButton>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
      {!shown.length ? <p className="text-sm text-muted-foreground">No repository matches “{q}”.</p> : null}
    </>
  );
}
