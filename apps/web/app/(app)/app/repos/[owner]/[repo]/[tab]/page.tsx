import type { ScanUpgrade } from "@teire/db";
import { inArray, runs } from "@teire/db";
import { type ActionKind, describeAction, runStateLabel } from "@teire/engine/actions";
import { CONFIG_PR_KEYS } from "@teire/engine/config-keys";
import { lineageKey } from "@teire/engine/contract";
import {
  ChevronDown,
  Eye,
  EyeOff,
  FileCog,
  GitPullRequest,
  GitPullRequestDraft,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Pause,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ActionButton } from "@/components/app/action-button";
import { ConfigBoard } from "@/components/app/config-board";
import { ConfigPrForm } from "@/components/app/config-pr-form";
import { IgnoreMenu } from "@/components/app/ignore-menu";
import { InventoryTable } from "@/components/app/inventory-table";
import { AskButton } from "@/components/assistant/ask-button";
import { FindingFlow } from "@/components/findings/finding-flow";
import { TileSquare } from "@/components/flow/tile";
import { Trail } from "@/components/flow/trail";
import { Mark } from "@/components/teire/mark";
import { StatusChip } from "@/components/teire/status-chip";
import { Button } from "@/components/ui/button";
import { ecosystemOf } from "@/lib/brands";
import { repoDetailCached } from "@/lib/dashboard";
import { bucketGroups, groupFindings } from "@/lib/findings";
import { configCurrent } from "@/lib/fix-mode";
import { runFlow } from "@/lib/flow/model";
import { installOutcome, type OutcomeCoverage } from "@/lib/install-outcome";
import { findingsByPackage, type InventoryFacts, inventoryFacts, plannedByPackage } from "@/lib/inventory";
import { providerLogo } from "@/lib/logos";
import { subjectMark } from "@/lib/marks";
import { runFlowsOf } from "@/lib/run-flows";
import { getSession } from "@/lib/session";
import { ago, until } from "@/lib/time";
import { cn } from "@/lib/utils";
import { rowsOf, type Scope } from "@/lib/workspace";

/** What the repository's Activity tab shows (the latest actions; dashboard.ts reads this many). */
const ACTIVITY_SHOWN = 40;

const TABS = ["findings", "prs", "runs", "inventory", "providers", "config", "activity"] as const;
type Tab = (typeof TABS)[number];
const TITLES: Record<Tab, string> = {
  findings: "Findings",
  prs: "Pull requests",
  runs: "Runs",
  inventory: "Inventory",
  providers: "Providers",
  config: "Config",
  activity: "Activity",
};

export async function generateMetadata({
  params,
}: PageProps<"/app/repos/[owner]/[repo]/[tab]">): Promise<Metadata> {
  const { owner, repo, tab } = await params;
  return { title: `${TITLES[tab as Tab] ?? tab} · ${owner}/${repo}` };
}

export default function RepoTabPage(props: PageProps<"/app/repos/[owner]/[repo]/[tab]">) {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-sheet shadow-card" />}>
      <TabBody {...props} />
    </Suspense>
  );
}

type Data = NonNullable<Awaited<ReturnType<typeof repoDetailCached>>>;

/**
 * The repository's own installation, whichever one the switcher shows (U3 review): the page was
 * authorized for this repository, so its tabs read it there.
 */
const repoScope = (data: Data, userId: string): Scope => ({
  installationId: data.repo.installationId,
  account: null,
  publicOnly: false,
  userId,
});

async function TabBody({ params, searchParams }: PageProps<"/app/repos/[owner]/[repo]/[tab]">) {
  await connection();
  const [{ owner, repo: name, tab }, query, session] = await Promise.all([
    params,
    searchParams,
    getSession(),
  ]);
  if (!TABS.includes(tab as Tab)) notFound();
  if (!session) return null;
  const fullName = `${owner}/${name}`;
  const data = await repoDetailCached(session.user.id, fullName);
  if (!data) notFound();
  const group = typeof query.group === "string" ? query.group : null;
  switch (tab as Tab) {
    case "findings":
      return <Findings data={data} fullName={fullName} focus={group} userId={session.user.id} />;
    case "prs":
      return <Prs data={data} fullName={fullName} userId={session.user.id} />;
    case "runs":
      return <Runs data={data} userId={session.user.id} />;
    case "inventory":
      return <Inventory data={data} />;
    case "providers":
      return <Providers data={data} />;
    case "config":
      return (
        <Config data={data} fullName={fullName} picked={typeof query.key === "string" ? query.key : null} />
      );
    case "activity":
      return <Activity data={data} />;
  }
}

function Heading({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h2 className="eyebrow">
      {children}
      {count !== undefined ? <span className="ml-1.5 font-mono normal-case">{count}</span> : null}
    </h2>
  );
}

/** `zod` from `npm/zod/4.6.6`; a provider group (`models/openai`) as it is. */
function upgradeName(u: ScanUpgrade) {
  const eco = u.groupKey.split("/")[0] ?? "";
  return u.groupKey.endsWith(`/${u.to}`) ? u.groupKey.slice(eco.length + 1, -(u.to.length + 1)) : u.groupKey;
}

async function Findings({
  data,
  fullName,
  focus,
  userId,
}: {
  data: Data;
  fullName: string;
  focus: string | null;
  userId: string;
}) {
  const { repo, scan, fixMode } = data;
  // Each group's proof chain: its newest run (plan revision 3.3, "the proof chain on every finding").
  const mine = { scope: repoScope(data, userId) };
  // The runs behind the latest 25, every PR or issue, and each change's own latest run (queued ones
  // included), so every finding shows the run it really has.
  const ids = [
    ...new Set([
      ...data.runs.map((x) => x.id),
      ...data.artifacts.flatMap((a) => (a.runId ? [a.runId] : [])),
      ...data.groupRunIds,
    ]),
  ];
  const rows = ids.length ? await rowsOf(mine.scope, inArray(runs.id, ids), ids.length) : [];
  const byRun = new Map(rows.map((r) => [r.id, r]));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of [...rows].sort((a, c) => c.createdAt.getTime() - a.createdAt.getTime()))
    if (r.groupKey && !latest.has(r.groupKey)) latest.set(r.groupKey, r);
  const open = data.findings.filter((f) => f.state === "open");
  const ignored = groupFindings(data.findings.filter((f) => f.state === "ignored"));
  // Every ignore, not only findings now ignored: `@teire ignore` entries (with their update type)
  // and teire.yml's own list (U4 review).
  const byCommand = ((data.repo.ignores as string[] | null) ?? []).map((entry) => {
    const m = /^(.*)@(major|minor|patch)$/.exec(entry);
    return { entry, target: m?.[1] ?? entry, update: m?.[2] as "major" | "minor" | "patch" | undefined };
  });
  const byFile = ((data.repo.config as { ignore?: string[] } | null)?.ignore ?? []).filter(
    (i) => !byCommand.some((c) => c.entry === i),
  );
  const b = bucketGroups(groupFindings(open));
  const coverage = scan?.coverage as
    | (OutcomeCoverage & {
        filesScanned?: number;
        advisoryStatus?: "complete" | "partial" | "unavailable";
        gaps?: string[];
      })
    | null;
  // Archived, no commits yet, or nothing Teire reads: said by name instead of "Nothing reaches this code".
  const outcome = installOutcome(coverage, repo);
  const gaps = coverage?.gaps ?? [];
  const prFor = new Map(data.artifacts.filter((a) => a.kind === "pr").map((a) => [a.changeKey, a]));
  const off = fixMode.mode === "off";
  const shown = new Set([...b.affected, ...b.human, ...b.undecided].map((g) => g.key));
  const lineagePr = new Map(
    data.artifacts
      .filter((a) => a.kind === "pr" && a.state === "open" && a.lineageKey)
      .map((a) => [a.lineageKey as string, a]),
  );
  const upgrades =
    fixMode.mode === "auto"
      ? []
      : ((scan?.upgrades ?? []) as ScanUpgrade[]).filter(
          (u) => !shown.has(u.groupKey) && !prFor.has(u.groupKey),
        );
  // A deep link (`?group=…`) puts its group first.
  const reaching = [...b.affected, ...b.human].sort(
    (a, c) => Number(c.key === focus) - Number(a.key === focus),
  );
  const issueFor = new Map(
    data.artifacts.filter((a) => a.kind === "issue" && a.state === "open").map((a) => [a.changeKey, a]),
  );
  const flowOf = (g: (typeof reaching)[number], undecided = false) => {
    const pr = prFor.get(g.key);
    const opened = pr?.state === "open" ? pr : issueFor.get(g.key);
    // A run going now speaks for the group; otherwise the run behind its open PR, else its newest.
    const newest = latest.get(g.key);
    const run =
      newest && ["queued", "running", "stopping"].includes(newest.status)
        ? newest
        : ((opened?.runId ? byRun.get(opened.runId) : undefined) ?? newest);
    return (
      <FindingFlow
        key={g.key}
        group={g}
        repo={fullName}
        sha={repo.lastScannedSha}
        latest={run}
        opened={opened}
        mode={fixMode.mode}
        undecided={undecided}
        focus={g.key === focus}
        compact
        actions={
          <>
            {pr?.url && pr.state === "open" ? (
              <Button asChild size="sm" variant="outline">
                <a href={pr.url}>PR #{pr.number}</a>
              </Button>
            ) : run && ["queued", "running", "stopping"].includes(run.status) ? (
              // Already on its way: the button says where, never "Fix now" over a waiting run.
              <Button asChild size="sm" variant="outline" title={run.step ?? undefined}>
                <Link href={`/runs/${run.id}`}>{runStateLabel(run.status, run.step)}</Link>
              </Button>
            ) : g.key.startsWith("runtime/") ? null : (
              <ActionButton
                kind="fix"
                repo={fullName}
                params={{ target: g.key }}
                variant="default"
                disabled={off}
                title={
                  off
                    ? `Fixes are Off here (${fixMode.file ? `set in ${fixMode.file}` : "change it above"})`
                    : undefined
                }
              >
                {run && (run.status === "failed" || run.status === "cancelled")
                  ? "Try again"
                  : undecided
                    ? "Upgrade and check"
                    : "Fix now"}
              </ActionButton>
            )}
            <IgnoreMenu repo={fullName} group={g.key} />
            <AskButton
              icon
              question={`Explain the finding ${g.key} on ${fullName}: what changed, where it reaches the code and what Teire will do`}
            />
          </>
        }
      />
    );
  };
  const couldnt = [
    ...(coverage?.advisoryStatus && coverage.advisoryStatus !== "complete"
      ? [`Security advisories: ${coverage.advisoryStatus}`]
      : []),
    ...gaps,
  ];
  const ignoredCount = ignored.length + byCommand.length + byFile.length;
  return (
    <div className="flex flex-col gap-4">
      {outcome ? (
        <div className="flex items-start gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
          <TileSquare tile={{ entity: "repository", state: "skipped", label: "" }} size="sm" />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-sm text-ink">{outcome.label}</span>
            <span className="text-xs text-ink-2">{outcome.why}</span>
            {coverage?.searched?.length ? (
              <span className="font-mono text-[11px] text-ink-3">
                Looked for: {coverage.searched.join(" · ")}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      {reaching.length || b.undecided.length ? (
        <div className="flex flex-col gap-3">
          {[...reaching.map((g) => flowOf(g)), ...b.undecided.map((g) => flowOf(g, true))]}
        </div>
      ) : outcome ? null : (
        <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
          <TileSquare
            tile={{ entity: "check", state: couldnt.length ? "not_proven" : "proven", label: "" }}
            size="sm"
          />
          <span className="flex flex-col">
            <span className="text-sm text-ink">Nothing reaches this code</span>
            {coverage?.filesScanned ? (
              <span className="font-mono text-[11px] text-ink-3">{coverage.filesScanned} files searched</span>
            ) : null}
          </span>
        </div>
      )}
      {upgrades.length ? (
        <section className="flex flex-col gap-2">
          <Heading count={upgrades.length}>Upgrades {off ? "(fixes off)" : "waiting for you"}</Heading>
          <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
            {upgrades.map((u) => {
              const older = lineagePr.get(lineageKey(u.groupKey, u.security ? "security" : "version"));
              return (
                <li key={u.groupKey} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Mark brand={subjectMark(u.groupKey)} size="sm" />
                    <span className="min-w-0 truncate font-mono text-xs text-ink">
                      {upgradeName(u)} <span className="text-ink-3">{u.from ? `${u.from} → ` : "→ "}</span>
                      {u.to}
                    </span>
                    {u.security ? <StatusChip tone="attention">security</StatusChip> : null}
                    {older ? (
                      <span className="font-mono text-[11px] text-ink-3">after #{older.number}</span>
                    ) : null}
                  </span>
                  {off ? null : (
                    <ActionButton
                      kind="fix"
                      repo={fullName}
                      params={{ target: u.groupKey }}
                      variant="default"
                    >
                      Upgrade
                    </ActionButton>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {couldnt.length || b.quiet.length || ignoredCount ? (
        <div className="flex flex-col gap-2">
          {couldnt.length ? (
            <Fold tone="attention" label="Couldn't check" count={couldnt.length}>
              <ul className="flex flex-col gap-1 p-4 text-sm text-ink-2">
                {couldnt.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </Fold>
          ) : null}
          {b.quiet.length ? (
            <Fold tone="proven" label="Checked, not reaching" count={b.quiet.length}>
              <ul className="divide-y divide-rule">
                {b.quiet.map((g) => (
                  <li key={g.key} className="flex items-center gap-2.5 px-4 py-2">
                    <Mark brand={subjectMark(g.key)} size="sm" />
                    {g.changeIds[0] ? (
                      <Link
                        href={`/changes/${g.changeIds[0]}`}
                        className="min-w-0 truncate text-sm text-ink hover:underline"
                      >
                        {g.title}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate text-sm text-ink">{g.title}</span>
                    )}
                    {g.reason ? (
                      <span className="ml-auto hidden max-w-[45%] truncate text-xs text-ink-3 md:inline">
                        {g.reason}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Fold>
          ) : null}
          {ignoredCount ? (
            <Fold tone="neutral" label="Ignored" count={ignoredCount} id="ignored">
              <ul className="divide-y divide-rule">
                {byCommand.map((c) => (
                  <li key={c.entry} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="truncate font-mono text-xs text-ink">
                      {c.target}
                      {c.update ? <span className="text-ink-3"> · {c.update}</span> : null}
                      <span className="ml-2 text-ink-3">@teire ignore</span>
                    </span>
                    <ActionButton
                      kind="unignore"
                      repo={fullName}
                      params={{ target: c.target, ...(c.update ? { update: c.update } : {}) }}
                      variant="ghost"
                    >
                      Unignore
                    </ActionButton>
                  </li>
                ))}
                {byFile.map((i) => (
                  <li key={i} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="truncate font-mono text-xs text-ink">
                      {i}
                      <span className="ml-2 text-ink-3">teire.yml</span>
                    </span>
                    <Link
                      href={`/app/repos/${fullName}/config`}
                      className="text-xs text-ink-2 hover:text-ink"
                    >
                      Config ›
                    </Link>
                  </li>
                ))}
                {ignored.map((g) => (
                  <li key={g.key} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    {g.changeIds[0] ? (
                      <Link href={`/changes/${g.changeIds[0]}`} className="truncate text-ink hover:underline">
                        {g.title}
                      </Link>
                    ) : (
                      <span className="truncate text-ink">{g.title}</span>
                    )}
                    <ActionButton kind="unignore" repo={fullName} params={{ target: g.key }} variant="ghost">
                      Unignore
                    </ActionButton>
                  </li>
                ))}
              </ul>
            </Fold>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A folded list under the findings: a chip with its count that opens in place. */
function Fold({
  label,
  count,
  tone,
  id,
  children,
}: {
  label: string;
  count: number;
  tone: "attention" | "proven" | "neutral";
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <details id={id} className="group/fold overflow-hidden rounded-xl bg-sheet shadow-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full",
            tone === "attention" ? "bg-attention" : tone === "proven" ? "bg-proven" : "bg-ink-3",
          )}
        />
        {label}
        <span className="font-mono text-xs text-ink-3">{count}</span>
        <ChevronDown
          aria-hidden
          className="ml-auto size-3.5 text-ink-3 transition-transform group-open/fold:rotate-180"
        />
      </summary>
      <div className="border-t border-rule">{children}</div>
    </details>
  );
}

async function Prs({ data, fullName, userId }: { data: Data; fullName: string; userId: string }) {
  const scope = repoScope(data, userId);
  const ids = data.artifacts.map((a) => a.runId).filter((x): x is string => !!x);
  const flows = await runFlowsOf(scope, ids);
  const label = (kind: string) =>
    kind === "issue"
      ? "Issue"
      : kind === "onboarding"
        ? "Onboarding PR"
        : kind === "config"
          ? "Config PR"
          : "PR";
  const list = [...data.artifacts].sort((a, b) => Number(b.state === "open") - Number(a.state === "open"));
  if (!list.length) return <Quiet label="No pull request yet" />;
  return (
    <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
      {list.map((a) => {
        const input = a.runId ? flows.get(a.runId) : undefined;
        const graph = input ? runFlow(input) : null;
        const outcome = graph?.tiles.find((t) => t.entity === "outcome");
        const state =
          a.state === "merged"
            ? "proven"
            : a.state === "closed"
              ? "skipped"
              : a.kind === "issue"
                ? "failed"
                : (outcome?.state ?? "done");
        return (
          <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
            {graph ? (
              <Trail
                graph={graph}
                omit={["repository"]}
                runHref={`/runs/${a.runId}`}
                label={`How ${label(a.kind)} #${a.number} came about`}
                className="min-w-0 flex-1"
              />
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <TileSquare tile={{ entity: "outcome", state, label: label(a.kind) }} size="sm" />
                <a href={a.url ?? "#"} className="text-sm font-medium text-ink hover:underline">
                  {label(a.kind)} #{a.number}
                </a>
                <span className="truncate font-mono text-[11px] text-ink-3">
                  {a.changeKey || "Configure Teire"}
                </span>
              </span>
            )}
            {a.state !== "open" ? (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 font-mono text-[11px]",
                  a.state === "merged" ? "bg-proven-soft text-proven" : "bg-sunken text-ink-3",
                )}
              >
                {a.state}
              </span>
            ) : null}
            <span className="flex items-center gap-1">
              {a.kind === "pr" && a.state === "open" && a.runId ? (
                <ActionButton kind="reverify-run" repo={fullName} params={{ runId: a.runId }} variant="ghost">
                  Re-verify
                </ActionButton>
              ) : null}
              {a.kind === "pr" && a.state === "open" ? (
                <ActionButton kind="refresh" repo={fullName} params={{ group: a.changeKey }} variant="ghost">
                  Refresh
                </ActionButton>
              ) : null}
              {a.kind === "pr" && a.state !== "open" ? (
                <ActionButton kind="recreate" repo={fullName} params={{ group: a.changeKey }} variant="ghost">
                  Recreate
                </ActionButton>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A quiet tab: one tile and a few words, in place of an empty box. */
function Quiet({ label, meta }: { label: string; meta?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
      <TileSquare tile={{ entity: "check", state: "pending", label }} size="sm" />
      <span className="flex flex-col">
        <span className="text-sm text-ink-2">{label}</span>
        {meta ? <span className="font-mono text-[11px] text-ink-3">{meta}</span> : null}
      </span>
    </div>
  );
}

async function Runs({ data, userId }: { data: Data; userId: string }) {
  const ids = data.runs.map((r) => r.id);
  const flows = await runFlowsOf(repoScope(data, userId), ids);
  if (!ids.length) return <Quiet label="No runs yet" />;
  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
        {data.runs.map((r) => {
          const input = flows.get(r.id);
          return input ? (
            <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
              <Trail
                graph={runFlow(input)}
                omit={["repository"]}
                runHref={`/runs/${r.id}`}
                label="The run"
                className="min-w-0 flex-1"
              />
              <Link
                href={`/runs/${r.id}`}
                className="shrink-0 font-mono text-[11px] text-ink-3 hover:text-ink"
              >
                {r.status === "queued" ? "waiting" : ago(r.finishedAt ?? r.startedAt ?? r.createdAt)} ›
              </Link>
            </li>
          ) : null;
        })}
      </ul>
      {/* The newest few here; every run of the repository, paged, on Runs. */}
      <Link
        href={`/app/runs?repo=${encodeURIComponent(data.repo.fullName)}`}
        className="self-end font-mono text-xs text-ink-2 hover:text-ink"
      >
        Every run ›
      </Link>
    </div>
  );
}

async function Inventory({ data }: { data: Data }) {
  const counts = new Map<string, number>();
  for (const i of data.inventory) counts.set(i.ecosystem, (counts.get(i.ecosystem) ?? 0) + 1);
  if (!data.inventory.length) return <Quiet label="No completed scan yet" />;
  const facts = data.scan ? await inventoryFacts(data.scan.id) : new Map<string, InventoryFacts>();
  const found = findingsByPackage(data.findings);
  const planned = plannedByPackage(data.scan?.upgrades as ScanUpgrade[] | null | undefined);
  return (
    <InventoryTable
      rows={data.inventory.map((i) => {
        const pkg = `${i.ecosystem}/${i.name}`;
        const f = facts.get(String(i.id));
        return {
          id: String(i.id),
          ecosystem: i.ecosystem,
          name: i.name,
          version: i.version,
          workspace: i.workspace,
          manifest: i.manifestPath,
          direct: i.direct,
          source: i.source,
          latest: f?.latest ?? null,
          behind: f?.behind ?? null,
          advisories: found.get(pkg)?.advisories ?? 0,
          findings: found.get(pkg)?.findings ?? 0,
          planned: planned.get(pkg) ?? null,
        };
      })}
      ecosystems={[...counts].map(([key, count]) => ({ key, label: ecosystemOf(key)?.label ?? key, count }))}
    />
  );
}

function Providers({ data }: { data: Data }) {
  const apis = groupFindings(
    data.findings.filter((f) => f.state !== "ignored" && /^(models|api)\//.test(f.groupKey ?? "")),
  );
  if (!data.providers.length) return <Quiet label="No API or model provider in this code" />;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {data.providers.map((p) => {
        const logo = providerLogo(p.slug);
        const found = apis.filter((g) => g.key.split("/")[1] === p.slug);
        const reaching = found.filter((g) => g.verdict === "affected" || g.verdict === "needs_human");
        return (
          <li key={p.slug} className="flex flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card">
            <Link href={`/providers/${p.slug}`} className="flex items-center gap-3">
              <TileSquare
                tile={{
                  entity: "change",
                  state: reaching.length ? "not_proven" : "proven",
                  label: p.name ?? logo.name,
                  brand: { label: logo.name, light: logo.light, dark: logo.dark },
                }}
                size="sm"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-ink hover:underline">
                  {p.name ?? logo.name}
                </span>
                <span className="font-mono text-[11px] text-ink-3">seen {ago(p.seenAt)}</span>
              </span>
            </Link>
            {found.length ? (
              <ul className="flex flex-col divide-y divide-rule rounded-lg ring-1 ring-rule">
                {found.map((g) => (
                  <li key={g.key} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
                    {g.changeIds[0] ? (
                      <Link
                        href={`/changes/${g.changeIds[0]}`}
                        className="min-w-0 truncate text-ink-2 hover:text-ink"
                      >
                        {g.title}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate text-ink-2">{g.title}</span>
                    )}
                    {g.deadline ? (
                      <span className="shrink-0 font-mono text-[11px] text-attention">
                        {until(g.deadline)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Config({ data, fullName, picked }: { data: Data; fullName: string; picked: string | null }) {
  const config = data.repo.config as Record<string, unknown> | null;
  const problems =
    ((config?.problems ?? config?.issues) as { path?: string; message?: string }[] | undefined) ?? [];
  const present = !!config?.present;
  const key = picked && picked in CONFIG_PR_KEYS ? (picked as keyof typeof CONFIG_PR_KEYS) : undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-sheet px-3 py-1 font-mono text-ink-2 shadow-tile ring-1 ring-rule">
          {present ? String(config?.path ?? ".github/teire.yml") : "no teire.yml yet"}
        </span>
        <a href="/schema.json" className="rounded-full px-3 py-1 font-mono text-ink-3 hover:text-ink">
          schema.json
        </a>
        <Link href="/docs/guide/configuration" className="rounded-full px-3 py-1 text-ink-3 hover:text-ink">
          How settings combine ›
        </Link>
      </div>
      {problems.length ? (
        <ul className="divide-y divide-broke/15 overflow-hidden rounded-xl bg-broke-soft font-mono text-xs text-broke">
          {problems.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parser's problems, in file order
            <li key={i} className="flex items-center gap-2 px-4 py-2">
              <X className="size-3.5 shrink-0" strokeWidth={3} aria-hidden />
              {p.path ? <span className="font-medium">{p.path}</span> : null}
              <span className="truncate">{p.message}</span>
              <span className="ml-auto shrink-0 text-[11px]">uses its default</span>
            </li>
          ))}
        </ul>
      ) : null}
      <section id="change" className="flex scroll-mt-20 flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card">
        <ConfigPrForm
          key={key ?? "fixes"}
          repo={fullName}
          current={configCurrent(config, Object.keys(CONFIG_PR_KEYS))}
          {...(key ? { initialKey: key } : {})}
        />
        {!present || problems.length ? (
          <div className="flex items-center justify-between gap-3 border-t border-rule pt-3 text-sm text-ink-2">
            <span>{present ? "Replace it with the starter" : "Start from the starter"}</span>
            <ActionButton kind="starter-config-pr" repo={fullName}>
              Open starter config PR
            </ActionButton>
          </div>
        ) : null}
      </section>
      {config ? (
        <ConfigBoard config={config} base={`/app/repos/${fullName}/config`} picked={key ?? null} />
      ) : (
        <Quiet label="Read at the next scan" />
      )}
    </div>
  );
}

const ACTIVITY_ICON: Partial<Record<string, LucideIcon>> = {
  rescan: RefreshCw,
  pause: Pause,
  resume: Play,
  "set-fix-mode": SlidersHorizontal,
  "set-installation-fix-mode": SlidersHorizontal,
  fix: Wrench,
  "fix-in-all": Wrench,
  rebase: GitPullRequest,
  refresh: GitPullRequest,
  recreate: GitPullRequest,
  ignore: EyeOff,
  unignore: Eye,
  "cancel-run": X,
  "retry-run": RotateCcw,
  "reverify-run": ListChecks,
  "open-draft-anyway": GitPullRequestDraft,
  "config-pr": FileCog,
  "starter-config-pr": FileCog,
  feedback: MessageSquare,
  activate: Power,
};

const whoOf = (a: Data["activity"][number]) =>
  a.source === "teire"
    ? "Teire"
    : a.actor
      ? `@${a.actor}`
      : a.requester.startsWith("github:")
        ? `@${a.requester.slice(7)}`
        : "someone signed in";

const WHERE: Record<string, string> = { web: "dashboard", dashboard: "Dashboard issue", teire: "on its own" };

/** The repository's history as a rail (plan revision 3.4, V4): each action an icon tile in its outcome. */
function Activity({ data }: { data: Data }) {
  if (!data.activity.length)
    return <Quiet label="Nothing yet" meta="rescans, fixes, ignores and fix modes land here" />;
  return (
    <div className="flex flex-col gap-2">
      <ol className="relative flex flex-col gap-1 rounded-xl bg-sheet p-3 shadow-card">
        <span aria-hidden className="absolute top-6 bottom-6 left-[37px] w-px bg-rule" />
        {data.activity.map((a) => {
          const Icon = ACTIVITY_ICON[a.kind] ?? Zap;
          const state =
            a.status === "done"
              ? "done"
              : a.status === "refused" || a.status === "failed"
                ? "failed"
                : "live";
          return (
            <li key={a.id} className="relative flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-hover">
              <span
                className={cn(
                  "relative z-10 flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-sheet shadow-tile",
                  state === "done"
                    ? "ring-[1.5px] ring-ink/60"
                    : state === "failed"
                      ? "ring-2 ring-broke"
                      : "ring-2 ring-signal animate-live",
                )}
              >
                <Icon
                  className={cn("size-4", state === "failed" ? "text-broke" : "text-ink")}
                  strokeWidth={1.75}
                  aria-hidden
                />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm text-ink">{describeAction(a.kind as ActionKind, a.params)}</span>
                  <span className="font-mono text-[11px] text-ink-3" title={a.result ?? undefined}>
                    {whoOf(a)}
                    {a.source !== "web" ? ` · ${WHERE[a.source] ?? a.source}` : ""} · {ago(a.createdAt)}
                  </span>
                </span>
                {/* The outcome's words only when it went wrong; a done action is its green tile. */}
                {a.result && state === "failed" ? (
                  <span className="truncate text-xs text-broke">{a.result}</span>
                ) : null}
              </div>
              {a.links.length ? (
                <span className="flex shrink-0 items-center gap-2 text-xs">
                  {a.links.map((l) => (
                    <a key={l.href} href={l.href} className="text-link hover:underline">
                      {l.label}
                    </a>
                  ))}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {data.activity.length >= ACTIVITY_SHOWN ? (
        <p className="font-mono text-[11px] text-ink-3">the latest {ACTIVITY_SHOWN}</p>
      ) : null}
    </div>
  );
}
