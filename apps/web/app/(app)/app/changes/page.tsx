import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ChangeFan } from "@/components/app/change-fan";
import { FilterSelect } from "@/components/app/filter-select";
import { FixInAll } from "@/components/app/fix-in-all";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { TileSquare } from "@/components/flow/tile";
import { Button } from "@/components/ui/button";
import { myScope } from "@/lib/app-shell";
import { sourceBrand } from "@/lib/estate";
import { getSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { type ChangeForYou, changesFor } from "@/lib/workspace";
import { InstallCard, SignInCard } from "../gate";

export const metadata = { title: "Changes for you" };

const PAGE = 20;

/** Where a change comes from, for the filter: its provider, else its ecosystem, else its kind. */
const sourceOf = (c: ChangeForYou) =>
  c.provider ? `provider:${c.provider}` : c.ecosystem ? `ecosystem:${c.ecosystem}` : `kind:${c.kind}`;

const WHEN = {
  all: "Any time",
  dated: "Has a deadline",
  security: "Security",
  open: "Nothing open yet",
} as const;

/**
 * Changes for you (plan revision 3.4, V4): every catalog change reaching your code, most urgent first,
 * each fanning out to the repositories it reaches with what Fix now would do in each, and Fix in all.
 * Filters by source and kind live in the URL; `?change=` (the estate map's link) puts one first.
 */
export default function ChangesForYouPage({ searchParams }: PageProps<"/app/changes">) {
  return (
    <Suspense
      fallback={
        <div className="mx-auto flex h-96 w-full max-w-6xl items-center justify-center rounded-xl bg-sheet shadow-card">
          <GhostFlow tiles={3} />
        </div>
      }
    >
      <Changes searchParams={searchParams} />
    </Suspense>
  );
}

async function Changes({ searchParams }: { searchParams: PageProps<"/app/changes">["searchParams"] }) {
  await connection();
  const session = await getSession();
  if (!session) return <SignInCard next="/app/changes" />;
  const [mine, params] = await Promise.all([myScope(session.user.id), searchParams]);
  if (!mine) return <InstallCard />;
  const all = await changesFor(mine.scope);
  const one = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : "");
  const source = one("source") || "all";
  const when = (one("when") || "all") as keyof typeof WHEN;
  const focus = one("change");
  const page = Math.max(1, Number(one("page")) || 1);
  const sources = [...new Map(all.map((c) => [sourceOf(c), c])).entries()].map(([key]) => {
    const [kind, slug = ""] = key.split(":") as ["provider" | "ecosystem" | "kind", string];
    const { label, brand } = sourceBrand(kind, slug);
    return { key, label, brand, n: all.filter((c) => sourceOf(c) === key).length };
  });
  sources.sort((a, b) => b.n - a.n);
  const kept = all
    .filter((c) => source === "all" || sourceOf(c) === source)
    .filter((c) =>
      when === "dated"
        ? !!c.deadline
        : when === "security"
          ? c.kind === "security-advisory"
          : when === "open"
            ? c.reaches.every((r) => r.plan.kind === "run")
            : true,
    )
    // The estate map's change first.
    .sort((a, b) => Number(b.id === focus) - Number(a.id === focus));
  const pages = Math.max(1, Math.ceil(kept.length / PAGE));
  const shown = kept.slice((page - 1) * PAGE, page * PAGE);
  const href = (patch: Record<string, string>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ source, when, page: "1", ...patch }))
      if (v && v !== "all" && !(k === "page" && v === "1")) next.set(k, v);
    const q = next.toString();
    return `/app/changes${q ? `?${q}` : ""}`;
  };
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <h1 className="heading flex items-baseline gap-2 text-3xl text-ink">
        Changes for you
        <span className="font-mono text-base text-ink-3">
          {kept.length === all.length ? all.length : `${kept.length} of ${all.length}`}
        </span>
      </h1>
      {all.length ? (
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Filter changes">
          <FilterSelect
            label="Source"
            value={source}
            options={[
              { value: "all", label: "Every source", href: href({ source: "all" }) },
              ...sources.map((s) => ({
                value: s.key,
                label: `${s.label} · ${s.n}`,
                href: href({ source: s.key }),
                ...(s.brand ? { brand: s.brand } : {}),
              })),
            ]}
          />
          <FilterSelect
            label="Kind"
            value={when}
            options={Object.entries(WHEN).map(([value, label]) => ({
              value,
              label,
              href: href({ when: value }),
            }))}
          />
        </div>
      ) : null}
      {shown.length ? (
        <ul className="flex flex-col gap-3">
          {shown.map((c) => (
            <li key={c.id}>
              <ChangeFan
                change={c}
                focus={c.id === focus}
                action={
                  <FixInAll
                    title={c.title}
                    changeId={c.id}
                    installationId={mine.installation.id}
                    reaches={c.reaches}
                  />
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
          <TileSquare tile={{ entity: "check", state: "proven", label: "" }} size="sm" />
          <span className="text-sm text-ink-2">
            {all.length ? "Nothing matches" : "Nothing reaches your code"}
          </span>
          <Button asChild size="sm" variant="ghost" className="ml-auto">
            <Link href={all.length ? "/app/changes" : "/changes"}>
              {all.length ? "Clear" : "The catalog"}
            </Link>
          </Button>
        </div>
      )}
      {pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center justify-center gap-1 font-mono text-xs">
          {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
            <Link
              key={n}
              href={href({ page: String(n) })}
              aria-current={n === page ? "page" : undefined}
              className={cn(
                "flex size-8 items-center justify-center rounded-lg",
                n === page ? "bg-ink text-sheet" : "text-ink-2 hover:bg-hover",
              )}
            >
              {n}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
