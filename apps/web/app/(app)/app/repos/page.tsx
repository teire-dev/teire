import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { BulkFixMode } from "@/components/app/bulk-fix-mode";
import { FixModeControl } from "@/components/app/fix-mode-control";
import { MarkStack } from "@/components/teire/mark";
import { ago } from "@/components/teire/run-row";
import { StatusChip } from "@/components/teire/status-chip";
import { myScope } from "@/lib/app-shell";
import { languageMarks } from "@/lib/marks";
import { getSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { type RepoListRow, reposOf } from "@/lib/workspace";
import { InstallCard, SignInCard } from "../gate";

export const metadata = { title: "Repositories" };

/**
 * Repositories (plan revision 3.3, U3): every repository in the installation with its fix mode
 * (changed inline), its state and why, what reaches its code, its open PRs and what needs you; filters
 * by state, fix mode, ecosystem, open PRs and needs you; search; "Set fix mode…" for those shown.
 */
export default function ReposPage({ searchParams }: PageProps<"/app/repos">) {
  return (
    <Suspense
      fallback={
        <div className="mx-auto h-96 w-full max-w-6xl animate-pulse rounded-xl bg-sheet shadow-card" />
      }
    >
      <Repos searchParams={searchParams} />
    </Suspense>
  );
}

/** A repository's state in words, and why when Teire stopped on its own. */
function stateOf(r: RepoListRow): {
  label: string;
  tone: "signal" | "proven" | "attention" | "broke" | "neutral";
  why?: string;
} {
  if (r.live) return { label: "Working", tone: "signal" };
  if (r.lastScanFailed) return { label: "Last scan failed", tone: "broke" };
  if (r.status === "paused")
    return {
      label: "Paused",
      tone: "neutral",
      ...(r.pausedReason ? { why: r.pausedReason.replace(/_/g, " ") } : {}),
    };
  if (r.status === "disabled") return { label: "Removed from the installation", tone: "neutral" };
  if (r.status === "detected" || r.status === "onboarding") return { label: "Onboarding", tone: "attention" };
  return { label: "Active", tone: "proven" };
}

const FILTERS = {
  state: {
    all: "Any state",
    active: "Active",
    onboarding: "Onboarding",
    paused: "Paused",
    working: "Working",
  },
  mode: { all: "Any fix mode", auto: "Automatic", ask: "Ask first", off: "Off" },
  more: {
    all: "Everything",
    prs: "Has open PRs",
    "needs-you": "Needs you",
    reaching: "Changes reaching code",
  },
} as const;

async function Repos({ searchParams }: { searchParams: PageProps<"/app/repos">["searchParams"] }) {
  await connection();
  const session = await getSession();
  if (!session) return <SignInCard next="/app/repos" />;
  const [mine, params] = await Promise.all([myScope(session.user.id), searchParams]);
  if (!mine) return <InstallCard />;
  const rows = await reposOf(mine.scope);
  if (!rows.length) return <InstallCard />;
  const one = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : "");
  const q = one("q").toLowerCase();
  const state = one("state") || "all";
  const mode = one("mode") || "all";
  const more = one("more") || "all";
  const eco = one("eco");
  const langs = (r: RepoListRow) => (Array.isArray(r.languages) ? (r.languages as string[]) : []);
  const ecosystems = [...new Set(rows.flatMap(langs))].sort();
  const shown = rows.filter((r) => {
    const s = stateOf(r).label;
    if (q && !r.fullName.toLowerCase().includes(q)) return false;
    if (state === "active" && s !== "Active") return false;
    if (state === "onboarding" && s !== "Onboarding") return false;
    if (state === "paused" && r.status !== "paused") return false;
    if (state === "working" && !r.live) return false;
    if (mode !== "all" && r.fixMode.mode !== mode) return false;
    if (more === "prs" && !r.openPrs) return false;
    if (more === "needs-you" && !r.needsYou) return false;
    if (more === "reaching" && !r.affected) return false;
    if (eco && !langs(r).includes(eco)) return false;
    return true;
  });
  const href = (patch: Record<string, string>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, state, mode, more, eco, ...patch }))
      if (v && v !== "all") next.set(k, v);
    const s = next.toString();
    return `/app/repos${s ? `?${s}` : ""}`;
  };
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Repositories</span>
          <h1 className="heading text-2xl text-ink">
            {shown.length} of {rows.length}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <form action="/app/repos" className="flex">
            {Object.entries({ state, mode, more, eco }).map(([k, v]) =>
              v && v !== "all" ? <input key={k} type="hidden" name={k} value={v} /> : null,
            )}
            <input
              name="q"
              defaultValue={q}
              placeholder="Search repositories"
              aria-label="Search repositories"
              className="h-8 w-56 rounded-md bg-sheet px-2.5 text-sm ring-1 ring-rule ring-inset outline-none focus-visible:ring-signal"
            />
          </form>
          <BulkFixMode repos={shown.map((r) => r.fullName)} />
        </div>
      </div>
      <nav aria-label="Filter repositories" className="flex flex-col gap-2">
        {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((group) => (
          <div key={group} className="flex flex-wrap gap-1.5">
            {Object.entries(FILTERS[group]).map(([k, label]) => {
              const on = ({ state, mode, more } as Record<string, string>)[group] === k;
              return (
                <Link
                  key={k}
                  href={href({ [group]: k })}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs ring-1 ring-inset",
                    on ? "bg-ink text-sheet ring-ink" : "bg-sheet text-ink-2 ring-rule hover:text-ink",
                  )}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        ))}
        {ecosystems.length > 1 ? (
          <div className="flex flex-wrap gap-1.5">
            {["", ...ecosystems].map((e) => (
              <Link
                key={e || "any"}
                href={href({ eco: e })}
                aria-current={eco === e ? "page" : undefined}
                className={cn(
                  "rounded-full px-3 py-1 text-xs ring-1 ring-inset",
                  eco === e ? "bg-ink text-sheet ring-ink" : "bg-sheet text-ink-2 ring-rule hover:text-ink",
                )}
              >
                {e || "Any language"}
              </Link>
            ))}
          </div>
        ) : null}
      </nav>
      {shown.length ? (
        <div className="overflow-x-auto rounded-xl bg-sheet shadow-card">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-rule text-left">
                {["Repository", "Fix mode", "State", "Reaching code", "Open PRs", "Needs you", "Scanned"].map(
                  (h) => (
                    <th key={h} scope="col" className="eyebrow px-4 py-2.5 font-normal">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {shown.map((r) => {
                const s = stateOf(r);
                return (
                  <tr key={r.id} className="hover:bg-hover">
                    <td className="px-4 py-2.5">
                      <Link href={`/app/repos/${r.fullName}`} className="flex min-w-0 items-center gap-2">
                        <MarkStack brands={languageMarks(r.languages)} />
                        <span className="truncate font-mono text-xs text-ink hover:underline">
                          {r.fullName}
                        </span>
                        {r.isPrivate ? <span className="text-[10px] text-ink-3">private</span> : null}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <FixModeControl
                        repo={r.fullName}
                        mode={r.fixMode.mode}
                        origin={r.fixMode.origin}
                        file={r.fixMode.file}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="flex flex-col gap-0.5">
                        <StatusChip tone={s.tone}>{s.label}</StatusChip>
                        {s.why ? <span className="text-[11px] text-ink-3">{s.why}</span> : null}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums">
                      <Link
                        href={`/app/repos/${r.fullName}/findings`}
                        className={r.affected ? "text-ink" : "text-ink-3"}
                      >
                        {r.affected}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums">
                      <Link
                        href={`/app/repos/${r.fullName}/prs`}
                        className={r.openPrs ? "text-ink" : "text-ink-3"}
                      >
                        {r.openPrs}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums">
                      <Link
                        href={`/app/runs?show=needs-you&repo=${encodeURIComponent(r.fullName)}`}
                        className={r.needsYou ? "text-attention" : "text-ink-3"}
                      >
                        {r.needsYou}
                      </Link>
                    </td>
                    <td
                      className="px-4 py-2.5 font-mono text-[11px] text-ink-3"
                      title={r.lastScannedAt?.toISOString()}
                    >
                      {r.lastScannedAt ? ago(r.lastScannedAt) : "not yet"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-xl bg-sheet px-4 py-10 text-center text-sm text-ink-3 shadow-card">
          No repository matches.{" "}
          <Link href="/app/repos" className="text-link hover:underline">
            Show all
          </Link>
        </p>
      )}
    </div>
  );
}
