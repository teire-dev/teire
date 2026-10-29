import type { ScanUpgrade } from "@teire/db";
import { inArray, runs } from "@teire/db";
import { type ActionKind, describeAction } from "@teire/engine/actions";
import { CONFIG_PR_KEYS } from "@teire/engine/config-keys";
import { lineageKey } from "@teire/engine/contract";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ActionButton } from "@/components/app/action-button";
import { ConfigPrForm } from "@/components/app/config-pr-form";
import { IgnoreMenu } from "@/components/app/ignore-menu";
import { InventoryTable } from "@/components/app/inventory-table";
import { BrandLogo } from "@/components/brand-logo";
import { FindingGroupCard } from "@/components/findings/finding-group";
import { ProofGlyphs } from "@/components/teire/proof-glyphs";
import { ago, RunRowItem } from "@/components/teire/run-row";
import { StatusChip } from "@/components/teire/status-chip";
import { ecosystemOf } from "@/lib/brands";
import { repoDetailCached } from "@/lib/dashboard";
import { bucketGroups, groupFindings } from "@/lib/findings";
import { configCurrent } from "@/lib/fix-mode";
import { providerLogo } from "@/lib/logos";
import { getSession } from "@/lib/session";
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
      return <Config data={data} fullName={fullName} />;
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
  const latest = new Map<string, Awaited<ReturnType<typeof rowsOf>>[number]>();
  if (data.runs.length)
    for (const r of await rowsOf(
      mine.scope,
      inArray(
        runs.id,
        data.runs.map((x) => x.id),
      ),
      data.runs.length,
    ))
      if (r.groupKey && !latest.has(r.groupKey)) latest.set(r.groupKey, r);
  const open = data.findings.filter((f) => f.state === "open");
  const ignored = groupFindings(data.findings.filter((f) => f.state === "ignored"));
  const b = bucketGroups(groupFindings(open));
  const coverage = scan?.coverage as {
    filesScanned?: number;
    advisoryStatus?: "complete" | "partial" | "unavailable";
    gaps?: string[];
    skipped?: "archived" | "empty";
  } | null;
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
  return (
    <div className="flex flex-col gap-6">
      {upgrades.length ? (
        <section className="flex flex-col gap-2">
          <Heading count={upgrades.length}>Upgrades available</Heading>
          <p className="text-sm text-ink-3">
            {off ? "Fixes are off here, so none of these starts." : "Teire won't start these until you ask."}
          </p>
          <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
            {upgrades.map((u) => {
              const older = lineagePr.get(lineageKey(u.groupKey, u.security ? "security" : "version"));
              return (
                <li key={u.groupKey} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="min-w-0 truncate font-mono text-xs text-ink">
                    {upgradeName(u)} <span className="text-ink-3">{u.from ? `${u.from} → ` : "→ "}</span>
                    {u.to}
                    {u.security ? <span className="ml-2 text-attention">security</span> : null}
                    {older ? <span className="ml-2 text-ink-3">newer than #{older.number}</span> : null}
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
      {reaching.length ? (
        <section className="flex flex-col gap-3">
          <Heading count={reaching.length}>Reaching your code</Heading>
          {reaching.map((g) => {
            const pr = prFor.get(g.key);
            return (
              <div
                key={g.key}
                id={`group-${g.key}`}
                className={g.key === focus ? "rounded-xl ring-2 ring-signal" : undefined}
              >
                <FindingGroupCard
                  group={g}
                  repo={fullName}
                  sha={repo.lastScannedSha}
                  action={
                    <>
                      {latest.get(g.key) ? (
                        <Link href={`/runs/${latest.get(g.key)?.id}`} title="Its latest run" className="mr-1">
                          <ProofGlyphs
                            proof={(latest.get(g.key) as NonNullable<ReturnType<typeof latest.get>>).proof}
                          />
                        </Link>
                      ) : null}
                      {pr?.url && pr.state === "open" ? (
                        <a href={pr.url} className="text-sm text-link hover:underline">
                          Open PR #{pr.number}
                        </a>
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
                              : fixMode.mode === "ask"
                                ? "Teire won't start this until you ask"
                                : undefined
                          }
                        >
                          Fix now
                        </ActionButton>
                      )}
                      <IgnoreMenu repo={fullName} group={g.key} />
                    </>
                  }
                />
              </div>
            );
          })}
        </section>
      ) : null}
      {b.undecided.length ? (
        <section className="flex flex-col gap-3">
          <Heading count={b.undecided.length}>Decided in the sandbox</Heading>
          <p className="text-sm text-ink-3">
            The code alone doesn&apos;t settle these: some references could not be resolved. Each upgrade runs
            this repository&apos;s checks before and after, and that result decides.
          </p>
          {b.undecided.map((g) => (
            <FindingGroupCard
              key={g.key}
              group={g}
              repo={fullName}
              sha={repo.lastScannedSha}
              action={
                <ActionButton
                  kind="fix"
                  repo={fullName}
                  params={{ target: g.key }}
                  variant="default"
                  disabled={off}
                >
                  Upgrade and check
                </ActionButton>
              }
            />
          ))}
        </section>
      ) : null}
      {coverage?.skipped ? (
        <p className="text-sm text-ink-3">
          {coverage.skipped === "archived"
            ? "This repository is archived, so it's read-only: Teire scans nothing and opens nothing until it is unarchived."
            : "This repository has no commits yet; Teire scans it once it has one."}
        </p>
      ) : null}
      {gaps.length || (coverage?.advisoryStatus && coverage.advisoryStatus !== "complete") ? (
        <section className="flex flex-col gap-2 rounded-xl bg-sheet p-4 shadow-card">
          <Heading>Couldn&apos;t check</Heading>
          <ul className="flex flex-col gap-1 text-sm text-ink-2">
            {coverage?.advisoryStatus && coverage.advisoryStatus !== "complete" ? (
              <li>Security advisories: {coverage.advisoryStatus}</li>
            ) : null}
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {!reaching.length && !b.undecided.length ? (
        <p className="rounded-xl bg-sheet px-4 py-6 text-center text-sm text-ink-3 shadow-card">
          {gaps.length
            ? "Nothing reaches this code in what Teire could check"
            : "Nothing reaches this code right now"}
          {coverage?.filesScanned ? ` (Teire searched ${coverage.filesScanned} files)` : ""}.
        </p>
      ) : null}
      {b.quiet.length ? (
        <details className="rounded-xl bg-sheet shadow-card">
          <summary className="cursor-pointer px-4 py-3 text-sm text-ink">
            Checked, not reaching this code <span className="font-mono text-ink-3">{b.quiet.length}</span>
          </summary>
          <div className="flex flex-col gap-3 border-t border-rule p-4">
            {b.quiet.map((g) => (
              <FindingGroupCard key={g.key} group={g} repo={fullName} sha={repo.lastScannedSha} />
            ))}
          </div>
        </details>
      ) : null}
      {ignored.length ? (
        <section id="ignored" className="flex flex-col gap-2">
          <Heading count={ignored.length}>Ignored</Heading>
          <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
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
        </section>
      ) : null}
    </div>
  );
}

async function Prs({ data, fullName, userId }: { data: Data; fullName: string; userId: string }) {
  const mine = { scope: repoScope(data, userId) };
  const ids = data.artifacts.map((a) => a.runId).filter((x): x is string => !!x);
  const rows = ids.length ? await rowsOf(mine.scope, inArray(runs.id, ids), ids.length) : [];
  const byRun = new Map(rows.map((r) => [r.id, r]));
  const label = (kind: string) =>
    kind === "issue"
      ? "Issue"
      : kind === "onboarding"
        ? "Onboarding PR"
        : kind === "config"
          ? "Config PR"
          : "PR";
  const list = [...data.artifacts].sort((a, b) => Number(b.state === "open") - Number(a.state === "open"));
  if (!list.length)
    return (
      <p className="rounded-xl bg-sheet px-4 py-6 text-center text-sm text-ink-3 shadow-card">
        Teire has not opened a pull request here yet.
      </p>
    );
  return (
    <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
      {list.map((a) => {
        const run = a.runId ? byRun.get(a.runId) : undefined;
        return (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="flex min-w-0 flex-col">
              <a href={a.url ?? "#"} className="truncate text-sm text-ink hover:underline">
                {label(a.kind)} #{a.number}
              </a>
              <span className="truncate font-mono text-[11px] text-ink-3">
                {a.changeKey || "Configure Teire"}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {run ? (
                <Link href={`/runs/${run.id}`} title="Open its run">
                  <ProofGlyphs proof={run.proof} />
                </Link>
              ) : null}
              <StatusChip tone={a.state === "open" ? "signal" : a.state === "merged" ? "proven" : "neutral"}>
                {a.state}
              </StatusChip>
              {a.kind === "pr" && a.state === "open" && a.runId ? (
                <ActionButton kind="reverify-run" repo={fullName} params={{ runId: a.runId }}>
                  Re-verify
                </ActionButton>
              ) : null}
              {a.kind === "pr" && a.state === "open" ? (
                <ActionButton kind="refresh" repo={fullName} params={{ group: a.changeKey }}>
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

async function Runs({ data, userId }: { data: Data; userId: string }) {
  const mine = { scope: repoScope(data, userId) };
  const ids = data.runs.map((r) => r.id);
  const rows = ids.length ? await rowsOf(mine.scope, inArray(runs.id, ids), ids.length) : [];
  return rows.length ? (
    <div className="flex flex-col gap-2">
      <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
        {rows.map((r) => (
          <RunRowItem key={r.id} row={r} href={`/runs/${r.id}`} />
        ))}
      </ul>
      {/* The newest few here; every run of the repository, paged, on Runs. */}
      <Link
        href={`/app/runs?repo=${encodeURIComponent(data.repo.fullName)}`}
        className="self-end font-mono text-xs text-ink-2 hover:text-ink"
      >
        Every run of {data.repo.fullName} →
      </Link>
    </div>
  ) : (
    <p className="rounded-xl bg-sheet px-4 py-6 text-center text-sm text-ink-3 shadow-card">No runs yet.</p>
  );
}

function Inventory({ data }: { data: Data }) {
  const counts = new Map<string, number>();
  for (const i of data.inventory) counts.set(i.ecosystem, (counts.get(i.ecosystem) ?? 0) + 1);
  return data.inventory.length ? (
    <InventoryTable
      rows={data.inventory.map((i) => ({
        id: String(i.id),
        ecosystem: i.ecosystem,
        name: i.name,
        version: i.version,
        scope: i.scope,
        workspace: i.workspace,
        direct: i.direct,
      }))}
      ecosystems={[...counts].map(([key, count]) => ({ key, label: ecosystemOf(key)?.label ?? key, count }))}
    />
  ) : (
    <p className="rounded-xl bg-sheet px-4 py-6 text-center text-sm text-ink-3 shadow-card">
      No completed scan yet.
    </p>
  );
}

function Providers({ data }: { data: Data }) {
  const apis = groupFindings(data.findings.filter((f) => /^(models|api)\//.test(f.groupKey ?? "")));
  return data.providers.length ? (
    <ul className="grid gap-3 sm:grid-cols-2">
      {data.providers.map((p) => {
        const logo = providerLogo(p.slug);
        const found = apis.filter((g) => g.key.split("/")[1] === p.slug);
        return (
          <li key={p.slug} className="flex flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card">
            <span className="flex items-center justify-between gap-3">
              <Link
                href={`/providers/${p.slug}`}
                className="flex items-center gap-2 text-sm font-medium text-ink hover:underline"
              >
                <BrandLogo light={logo.light} dark={logo.dark} alt="" className="h-5" />
                {p.name ?? logo.name}
              </Link>
              <span className="font-mono text-[11px] text-ink-3">seen {ago(p.seenAt)}</span>
            </span>
            {found.length ? (
              <ul className="flex flex-col gap-1">
                {found.map((g) => (
                  <li key={g.key} className="truncate text-xs text-ink-2">
                    {g.changeIds[0] ? (
                      <Link href={`/changes/${g.changeIds[0]}`} className="hover:underline">
                        {g.title}
                      </Link>
                    ) : (
                      g.title
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-ink-3">No change from {p.name ?? p.slug} reaches this code.</span>
            )}
          </li>
        );
      })}
    </ul>
  ) : (
    <p className="rounded-xl bg-sheet px-4 py-6 text-center text-sm text-ink-3 shadow-card">
      Teire found no API or model provider called from this code.
    </p>
  );
}

/** `teire.yml` as stored on the repo: dotted keys with their values and where each came from. */
function configRows(config: Record<string, unknown> | null) {
  if (!config) return [];
  const origins = (config.origins as Record<string, string> | undefined) ?? {};
  const rows: { key: string; value: string; origin: string }[] = [];
  const walk = (prefix: string, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, v);
      return;
    }
    const top = prefix.split(".")[0] as string;
    rows.push({
      key: prefix,
      value: JSON.stringify(value),
      origin:
        origins[prefix] ?? origins[prefix.split(".").slice(0, 2).join(".")] ?? origins[top] ?? "default",
    });
  };
  for (const [k, v] of Object.entries(config))
    if (!["present", "path", "problems", "issues", "origins"].includes(k)) walk(k, v);
  return rows;
}

function Config({ data, fullName }: { data: Data; fullName: string }) {
  const config = data.repo.config as Record<string, unknown> | null;
  const rows = configRows(config);
  const problems =
    ((config?.problems ?? config?.issues) as { path?: string; message?: string }[] | undefined) ?? [];
  const present = !!config?.present;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-ink-2">
        The configuration lives in the repository (<span className="font-mono">.github/teire.yml</span>, or
        the organisation&apos;s <span className="font-mono">teire-config</span>); every key is in the{" "}
        <a href="/schema.json" className="text-link hover:underline">
          schema
        </a>
        . Changes go through a pull request, so the repository keeps the record.
      </p>
      {problems.length ? (
        <section className="flex flex-col gap-2 rounded-xl bg-broke-soft p-4">
          <Heading count={problems.length}>Problems</Heading>
          <ul className="flex flex-col gap-1 font-mono text-xs text-broke">
            {problems.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parser's problems, in file order
              <li key={i}>
                {p.path ? `${p.path}: ` : ""}
                {p.message}
              </li>
            ))}
          </ul>
          <span className="text-xs text-ink-2">Those keys use their defaults until fixed.</span>
        </section>
      ) : null}
      <section className="flex flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card">
        <Heading>Change a setting</Heading>
        <ConfigPrForm repo={fullName} current={configCurrent(config, Object.keys(CONFIG_PR_KEYS))} />
        {!present || problems.length ? (
          <div className="flex items-center justify-between gap-3 border-t border-rule pt-3 text-sm text-ink-2">
            <span>
              {present
                ? "Replace the file with Teire's starter, every key at its default."
                : "No teire.yml yet: add Teire's starter, every key at its default."}
            </span>
            <ActionButton kind="starter-config-pr" repo={fullName}>
              Open starter config PR
            </ActionButton>
          </div>
        ) : null}
      </section>
      {rows.length ? (
        <div className="overflow-x-auto rounded-xl bg-sheet shadow-card">
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="border-b border-rule text-left text-ink-3">
                <th className="px-4 py-2 font-normal">key</th>
                <th className="px-4 py-2 font-normal">value</th>
                <th className="px-4 py-2 font-normal">from</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((c) => (
                <tr key={c.key}>
                  <td className="px-4 py-1.5 text-ink">{c.key}</td>
                  <td className="max-w-xs truncate px-4 py-1.5 text-ink-2">{c.value}</td>
                  <td className="px-4 py-1.5 text-ink-3">{c.origin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-ink-3">Read at the next scan.</p>
      )}
    </div>
  );
}

function Activity({ data }: { data: Data }) {
  return data.activity.length ? (
    <div className="flex flex-col gap-2">
      {data.activity.length >= ACTIVITY_SHOWN ? (
        <p className="font-mono text-xs text-ink-3">
          The latest {ACTIVITY_SHOWN} actions on this repository.
        </p>
      ) : null}
      <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
        {data.activity.map((a) => (
          <li key={a.id} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
            <div className="min-w-0">
              <span className="text-sm text-ink">{describeAction(a.kind as ActionKind, a.params)}</span>{" "}
              <span className="text-xs text-ink-3">
                ·{" "}
                {a.source === "teire"
                  ? "Teire"
                  : a.actor
                    ? `@${a.actor}`
                    : a.requester.startsWith("github:")
                      ? `@${a.requester.slice(7)}`
                      : "someone signed in"}{" "}
                ·{" "}
                {a.source === "web"
                  ? "dashboard"
                  : a.source === "dashboard"
                    ? "Dashboard issue"
                    : a.source === "teire"
                      ? "on its own"
                      : a.source}
              </span>
              {a.result ? <p className="truncate text-xs text-ink-3">{a.result}</p> : null}
            </div>
            <div className="flex items-center gap-3 text-xs">
              {a.links.map((l) => (
                <a key={l.href} href={l.href} className="text-link hover:underline">
                  {l.label}
                </a>
              ))}
              <StatusChip
                tone={
                  a.status === "done"
                    ? "proven"
                    : a.status === "refused" || a.status === "failed"
                      ? "broke"
                      : "signal"
                }
              >
                {a.status}
              </StatusChip>
              <span className="font-mono text-ink-3">{ago(a.createdAt)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  ) : (
    <p className="rounded-xl bg-sheet px-4 py-6 text-center text-sm text-ink-3 shadow-card">
      Nothing yet. Rescans, fixes, ignores and fix-mode changes show here, whether asked on this page, in a
      comment or in the Dashboard issue.
    </p>
  );
}
