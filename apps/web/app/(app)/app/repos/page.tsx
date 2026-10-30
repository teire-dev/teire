import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { BulkFixMode } from "@/components/app/bulk-fix-mode";
import { FilterSelect } from "@/components/app/filter-select";
import { RepoFlowCard } from "@/components/app/repo-flow-card";
import { ReposTable } from "@/components/app/repos-table";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { myScope } from "@/lib/app-shell";
import { FIX_MODE_LABEL } from "@/lib/fix-mode-options";
import type { FlowState } from "@/lib/flow/model";
import { languageMarks } from "@/lib/marks";
import { getSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { type RepoListRow, repoFlowsOf, reposOf } from "@/lib/workspace";
import { InstallCard, SignInCard } from "../gate";

export const metadata = { title: "Repositories" };

/**
 * Repositories (plan revision 3.4, V4): every repository in the installation, as a table (fix mode
 * changed inline, state and why, what reaches its code, open PRs, what needs you, its latest run as a
 * flow) or as a map of cards (what reaches each one flowing into it and out to what is open). Four
 * dropdown filters in the URL; search, columns, export and "Set fix mode…" in the table's toolbar.
 */
export default function ReposPage({ searchParams }: PageProps<"/app/repos">) {
  return (
    <Suspense
      fallback={
        <div className="mx-auto flex h-96 w-full max-w-6xl items-center justify-center rounded-xl bg-sheet shadow-card">
          <GhostFlow tiles={3} />
        </div>
      }
    >
      <Repos searchParams={searchParams} />
    </Suspense>
  );
}

/** A repository's tile state on the map: working, a failed scan, paused, else done. */
function tileState(r: RepoListRow): FlowState {
  if (r.live) return "live";
  if (r.lastScanFailed) return "failed";
  if (r.status === "paused" || r.status === "disabled") return "skipped";
  return "done";
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
  // Not in the installation's repository access on GitHub (Codex walk B11): the way on is GitHub's.
  if (r.status === "disabled") return { label: "Needs GitHub access", tone: "attention" };
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
  const [rows, flows] = await Promise.all([reposOf(mine.scope), repoFlowsOf(mine.scope)]);
  if (!rows.length) return <InstallCard />;
  const one = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : "");
  const q = one("q").toLowerCase();
  const state = one("state") || "all";
  const mode = one("mode") || "all";
  const more = one("more") || "all";
  const eco = one("eco") || "all";
  const view = one("view") === "map" ? "map" : "table";
  const langs = (r: RepoListRow) => (Array.isArray(r.languages) ? (r.languages as string[]) : []);
  const languages = [...new Set(rows.flatMap(langs))].sort();
  const shown = rows.filter((r) => {
    const s = stateOf(r).label;
    if (q && !r.fullName.toLowerCase().includes(q)) return false;
    if (state === "active" && r.status !== "active") return false;
    if (state === "onboarding" && s !== "Onboarding") return false;
    if (state === "paused" && r.status !== "paused") return false;
    if (state === "working" && !r.live) return false;
    if (mode !== "all" && r.fixMode.mode !== mode) return false;
    if (more === "prs" && !r.openPrs) return false;
    if (more === "needs-you" && !r.needsYou) return false;
    if (more === "reaching" && !r.affected) return false;
    if (eco !== "all" && !langs(r).includes(eco)) return false;
    return true;
  });
  const href = (patch: Record<string, string>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, state, mode, more, eco, view, ...patch }))
      if (v && v !== "all" && !(k === "view" && v === "table")) next.set(k, v);
    const s = next.toString();
    return `/app/repos${s ? `?${s}` : ""}`;
  };
  const options = (group: keyof typeof FILTERS) =>
    Object.entries(FILTERS[group]).map(([value, label]) => ({
      value,
      label,
      href: href({ [group]: value }),
    }));
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="heading flex items-baseline gap-2 text-3xl text-ink">
          Repositories
          <span className="font-mono text-base text-ink-3">
            {shown.length === rows.length ? rows.length : `${shown.length} of ${rows.length}`}
          </span>
        </h1>
        <nav aria-label="View" className="flex rounded-lg bg-sunken p-0.5 ring-1 ring-rule ring-inset">
          {(["table", "map"] as const).map((v) => (
            <Link
              key={v}
              href={href({ view: v })}
              aria-current={view === v ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1 text-xs text-ink-2",
                view === v && "bg-sheet text-ink shadow-card",
              )}
            >
              {v === "table" ? "Table" : "Map"}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Filter repositories">
        <FilterSelect label="State" value={state} options={options("state")} />
        <FilterSelect label="Fix mode" value={mode} options={options("mode")} />
        <FilterSelect label="Show" value={more} options={options("more")} />
        {languages.length > 1 ? (
          <FilterSelect
            label="Language"
            value={eco}
            options={[
              { value: "all", label: "Any language", href: href({ eco: "all" }) },
              ...languages.map((l) => {
                const brand = languageMarks([l])[0];
                return { value: l, label: l, href: href({ eco: l }), ...(brand ? { brand } : {}) };
              }),
            ]}
          />
        ) : null}
        {state !== "all" || mode !== "all" || more !== "all" || eco !== "all" ? (
          <Link
            href={href({ state: "all", mode: "all", more: "all", eco: "all" })}
            className="px-2 text-xs text-ink-3 hover:text-ink"
          >
            Clear
          </Link>
        ) : null}
        {view === "map" ? (
          <span className="ml-auto">
            <BulkFixMode repos={shown.map((r) => r.fullName)} />
          </span>
        ) : null}
      </div>
      {!shown.length ? (
        <p className="rounded-xl bg-sheet px-4 py-10 text-center text-sm text-ink-3 shadow-card">
          No repository matches.{" "}
          <Link href="/app/repos" className="text-link hover:underline">
            Show all
          </Link>
        </p>
      ) : view === "map" ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((r) => (
            <li key={r.id}>
              <RepoFlowCard
                fullName={r.fullName}
                state={tileState(r)}
                mode={r.fixMode.mode === "auto" ? null : FIX_MODE_LABEL[r.fixMode.mode]}
                live={r.live}
                flow={flows.get(r.fullName)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <ReposTable
          rows={shown.map((r) => {
            const latest = flows.get(r.fullName)?.latest;
            return {
              id: r.id,
              fullName: r.fullName,
              isPrivate: r.isPrivate,
              languages: langs(r),
              fixMode: { mode: r.fixMode.mode, origin: r.fixMode.origin, file: r.fixMode.file },
              state: stateOf(r),
              affected: r.affected,
              openPrs: r.openPrs,
              needsYou: r.needsYou,
              lastScannedAt: r.lastScannedAt?.toISOString() ?? null,
              latest: latest ? { id: latest.id, proof: latest.proof, groupKey: latest.groupKey } : null,
            };
          })}
        />
      )}
    </div>
  );
}
