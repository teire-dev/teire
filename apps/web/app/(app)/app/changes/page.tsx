import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { FixInAll } from "@/components/app/fix-in-all";
import { BrandLogo } from "@/components/brand-logo";
import { EmptyState } from "@/components/teire/empty-state";
import { StatusChip } from "@/components/teire/status-chip";
import { Button } from "@/components/ui/button";
import { myScope } from "@/lib/app-shell";
import { providerLogo } from "@/lib/logos";
import { getSession } from "@/lib/session";
import { changesFor } from "@/lib/workspace";
import { InstallCard, SignInCard } from "../gate";

export const metadata = { title: "Changes for you" };

const days = (d: Date) => Math.ceil((d.getTime() - Date.now()) / 86_400_000);

/**
 * Changes for you (plan revision 3.3, U3; Codemod's "affected at a glance"): the catalog's changes that
 * reach your code, how many of your repositories each reaches, and Fix in all.
 */
export default function ChangesForYouPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto h-96 w-full max-w-5xl animate-pulse rounded-xl bg-sheet shadow-card" />
      }
    >
      <Changes />
    </Suspense>
  );
}

async function Changes() {
  await connection();
  const session = await getSession();
  if (!session) return <SignInCard next="/app/changes" />;
  const mine = await myScope(session.user.id);
  if (!mine) return <InstallCard />;
  const list = await changesFor(mine.scope);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="eyebrow">Changes for you</span>
        <h1 className="heading text-2xl text-ink">What reaches your code</h1>
      </div>
      {list.length ? (
        <ul className="flex flex-col gap-3">
          {list.map((c) => {
            const p = c.provider ? providerLogo(c.provider) : null;
            const left = c.deadline ? days(c.deadline) : null;
            return (
              <li key={c.id} className="flex flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    {p ? (
                      <BrandLogo light={p.light} dark={p.dark} alt={p.name} className="mt-0.5 h-5" />
                    ) : null}
                    <div className="flex min-w-0 flex-col gap-1">
                      <Link
                        href={`/changes/${c.id}`}
                        className="text-sm font-medium text-ink hover:underline"
                      >
                        {c.title}
                      </Link>
                      <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-3">
                        {c.subject ? <span>{c.subject}</span> : null}
                        {c.from || c.to ? (
                          <span>
                            {c.from ?? "?"} → {c.to ?? "?"}
                          </span>
                        ) : null}
                        <span>
                          affects {new Set(c.reaches.map((r) => r.repo)).size} of your repositor
                          {new Set(c.reaches.map((r) => r.repo)).size === 1 ? "y" : "ies"}
                        </span>
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {left !== null ? (
                      <StatusChip tone={left < 0 ? "broke" : left <= 30 ? "attention" : "neutral"}>
                        <CalendarClock className="size-3" aria-hidden />
                        {left < 0 ? `passed ${-left} d ago` : `${left} d left`}
                      </StatusChip>
                    ) : null}
                    <FixInAll
                      title={c.title}
                      changeId={c.id}
                      installationId={mine.installation.id}
                      reaches={c.reaches}
                    />
                  </div>
                </div>
                <ul className="flex flex-wrap gap-2">
                  {c.reaches.map((r) => (
                    <li key={`${r.repo}-${r.groupKey}`}>
                      <Link
                        href={`/app/repos/${r.repo}/findings?group=${encodeURIComponent(r.groupKey)}`}
                        className="flex items-center gap-2 rounded-md bg-sunken px-2 py-1 font-mono text-[11px] text-ink-2 ring-1 ring-rule ring-inset hover:text-ink"
                      >
                        {r.repo.split("/")[1]}
                        <span className="text-ink-3">
                          {r.plan.kind === "open"
                            ? `#${r.plan.number}`
                            : r.plan.kind === "off"
                              ? "fixes off"
                              : r.plan.kind === "paused"
                                ? "paused"
                                : r.plan.kind === "running"
                                  ? "running"
                                  : `${r.sites} site${r.sites === 1 ? "" : "s"}`}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          className="rounded-xl bg-sheet shadow-card"
          title="No catalog change reaches your code"
          body="Teire reads each change your repositories depend on: a package, an API, a model. When one reaches your code, it shows here."
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/changes">Browse the catalog</Link>
            </Button>
          }
        />
      )}
    </div>
  );
}
