import type { ScanUpgrade } from "@teire/db";
import { type ActionKind, describeAction } from "@teire/engine/actions";
import { lineageKey } from "@teire/engine/contract";
import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActionButton } from "@/components/app/action-button";
import { FixModeControl } from "@/components/app/fix-mode-control";
import { BrandLogo } from "@/components/brand-logo";
import { FindingGroupCard } from "@/components/findings/finding-group";
import { EvidenceBadge } from "@/components/run/evidence-badge";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ecosystemOf } from "@/lib/brands";
import { repoDetail } from "@/lib/dashboard";
import { bucketGroups, groupFindings } from "@/lib/findings";
import { ago } from "@/lib/languages";
import { getSession } from "@/lib/session";
import { SignInCard } from "../../../gate";

type Params = PageProps<"/app/repos/[owner]/[repo]">["params"];

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { owner, repo } = await params;
  return { title: `${owner}/${repo}` };
}

/** One repository (C3–C8): findings with actions, inventory, PRs, runs and the resolved config. */
export default function RepoPage({ params, searchParams }: PageProps<"/app/repos/[owner]/[repo]">) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <Repo params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

/** `zod` from `npm/zod/4.6.6`; a provider group (`models/openai`) as it is. */
function upgradeName(u: ScanUpgrade) {
  const eco = u.groupKey.split("/")[0] ?? "";
  return u.groupKey.endsWith(`/${u.to}`) ? u.groupKey.slice(eco.length + 1, -(u.to.length + 1)) : u.groupKey;
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

async function Repo({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: PageProps<"/app/repos/[owner]/[repo]">["searchParams"];
}) {
  const [{ owner, repo: name }, , session] = await Promise.all([params, searchParams, getSession()]);
  const fullName = `${owner}/${name}`;
  if (!session) return <SignInCard next={`/app/repos/${fullName}`} />;
  const data = await repoDetail(session.user.id, fullName);
  if (!data) notFound();
  const { repo, scan } = data;
  // Only what the latest scan still reports: fixed, dismissed and gone findings are history.
  const open = data.findings.filter((f) => f.state === "open");
  const ignored = data.findings.filter((f) => f.state === "ignored");
  const b = bucketGroups(groupFindings(open));
  // What the scan could not check (D96): shown before any "nothing reaches this code".
  const coverage = scan?.coverage as {
    filesScanned?: number;
    advisoryStatus?: "complete" | "partial" | "unavailable";
    gaps?: string[];
    skipped?: "archived" | "empty";
  } | null;
  const gaps = coverage?.gaps ?? [];
  const skipped =
    coverage?.skipped === "archived"
      ? "This repository is archived, so it's read-only: Teire scans nothing and opens nothing until it is unarchived."
      : coverage?.skipped === "empty"
        ? "This repository has no commits yet; Teire scans it once it has one."
        : null;
  const ignoredGroups = groupFindings(ignored);
  const prFor = new Map(data.artifacts.filter((a) => a.kind === "pr").map((a) => [a.changeKey, a]));
  const byEcosystem = new Map<string, number>();
  for (const i of data.inventory) byEcosystem.set(i.ecosystem, (byEcosystem.get(i.ecosystem) ?? 0) + 1);
  const config = configRows(repo.config as Record<string, unknown> | null);
  // Ask first and Off (D125): what Automatic would have started, listed for a person to start.
  const { fixMode } = data;
  const off = fixMode.mode === "off";
  const shown = new Set([...b.affected, ...b.human, ...b.undecided].map((g) => g.key));
  // An upgrade in a lineage with an open PR at an older target is "newer than #n", as the PR says.
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

  return (
    <>
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            <span className="font-mono">{fullName}</span>
            <Badge
              variant={repo.status === "active" ? "clear" : repo.status === "paused" ? "quiet" : "running"}
            >
              {repo.status}
            </Badge>
          </h1>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <a
              href={`https://github.com/${fullName}`}
              className="flex items-center gap-1 hover:text-foreground"
            >
              GitHub <ExternalLink className="size-3" aria-hidden />
            </a>
            <span>·</span>
            <span>
              scanned {ago(repo.lastScannedAt)}
              {repo.lastScannedSha ? ` at ${repo.lastScannedSha.slice(0, 7)}` : ""}
            </span>
            {repo.configSource ? (
              <>
                <span>·</span>
                <span className="font-mono">{repo.configSource}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex gap-2">
          <ActionButton kind="rescan" repo={fullName}>
            Rescan
          </ActionButton>
          <ActionButton kind={repo.status === "paused" ? "resume" : "pause"} repo={fullName}>
            {repo.status === "paused" ? "Resume" : "Pause"}
          </ActionButton>
        </div>
      </header>

      <FixModeControl repo={fullName} mode={fixMode.mode} origin={fixMode.origin} file={fixMode.file} />

      <Tabs defaultValue="findings" className="gap-4">
        <TabsList>
          <TabsTrigger value="findings">Findings ({b.affected.length + b.human.length})</TabsTrigger>
          <TabsTrigger value="inventory">Inventory ({data.inventory.length})</TabsTrigger>
          <TabsTrigger value="prs">Pull requests ({data.artifacts.length})</TabsTrigger>
          <TabsTrigger value="runs">Runs ({data.runs.length})</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="activity">Activity ({data.activity.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="findings" className="flex flex-col gap-6">
          {upgrades.length ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">
                Upgrades available{" "}
                <span className="font-normal text-muted-foreground">({upgrades.length})</span>
              </h2>
              <p className="text-sm text-muted-foreground">
                {off
                  ? "Fixes are off here, so none of these starts."
                  : "Teire won't start these until you ask."}
              </p>
              <ul className="divide-y overflow-hidden rounded-lg bg-card text-sm shadow-card">
                {upgrades.map((u) => (
                  <li key={u.groupKey} className="flex items-center justify-between gap-3 px-4 py-2">
                    <span className="min-w-0 truncate font-mono text-xs">
                      {upgradeName(u)} {u.from ? `${u.from} → ` : "→ "}
                      {u.to}
                      {u.security ? <span className="ml-2 text-attention">security</span> : null}
                      {lineagePr.get(lineageKey(u.groupKey, u.security ? "security" : "version")) ? (
                        <span className="ml-2 text-muted-foreground">
                          newer than #
                          {lineagePr.get(lineageKey(u.groupKey, u.security ? "security" : "version"))?.number}
                        </span>
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
                ))}
              </ul>
            </section>
          ) : null}
          {[...b.affected, ...b.human].map((g) => {
            const pr = prFor.get(g.key);
            return (
              <FindingGroupCard
                key={g.key}
                group={g}
                repo={fullName}
                sha={repo.lastScannedSha}
                action={
                  <>
                    {pr?.url ? (
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
                    <ActionButton kind="ignore" repo={fullName} params={{ target: g.key }} variant="ghost">
                      Ignore
                    </ActionButton>
                  </>
                }
              />
            );
          })}
          {b.undecided.length ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">
                Decided in the sandbox{" "}
                <span className="font-normal text-muted-foreground">({b.undecided.length})</span>
              </h2>
              <p className="text-sm text-muted-foreground">
                The code alone doesn&apos;t settle these: some references could not be resolved. Each upgrade
                runs this repo&apos;s checks before and after, and that result decides.
              </p>
              {b.undecided.map((g) => (
                <FindingGroupCard
                  key={g.key}
                  group={g}
                  repo={fullName}
                  sha={repo.lastScannedSha}
                  action={
                    <ActionButton kind="fix" repo={fullName} params={{ target: g.key }} variant="default">
                      Upgrade and check
                    </ActionButton>
                  }
                />
              ))}
            </section>
          ) : null}
          {skipped ? <p className="text-sm text-muted-foreground">{skipped}</p> : null}
          {gaps.length ? (
            <section className="flex flex-col gap-2 rounded-lg bg-card p-4 shadow-card">
              <h2 className="text-sm font-medium">
                What Teire could not check
                {coverage?.advisoryStatus && coverage.advisoryStatus !== "complete"
                  ? ` · advisories ${coverage.advisoryStatus}`
                  : ""}
              </h2>
              <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                {gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {!b.affected.length && !b.human.length && !b.undecided.length ? (
            <p className="text-sm text-muted-foreground">
              {gaps.length
                ? "Nothing reaches this code in what Teire could check"
                : "Nothing reaches this code right now"}
              {coverage?.filesScanned ? ` (Teire searched ${coverage.filesScanned} files)` : ""}.
            </p>
          ) : null}
          {b.quiet.length ? (
            <details className="rounded-lg bg-card shadow-card">
              <summary className="cursor-pointer px-4 py-3 text-sm">
                <span className="font-medium">Checked, not reaching this code</span>{" "}
                <span className="text-muted-foreground">({b.quiet.length})</span>
              </summary>
              <div className="flex flex-col gap-3 border-t p-4">
                {b.quiet.map((g) => (
                  <FindingGroupCard key={g.key} group={g} repo={fullName} sha={repo.lastScannedSha} />
                ))}
              </div>
            </details>
          ) : null}
          {ignoredGroups.length ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Ignored</h2>
              <ul className="divide-y overflow-hidden rounded-lg bg-card text-sm shadow-card">
                {ignoredGroups.map((g) => (
                  <li key={g.key} className="flex items-center justify-between gap-3 px-4 py-2">
                    {g.changeIds[0] ? (
                      <Link href={`/changes/${g.changeIds[0]}`} className="truncate entity-link">
                        {g.title}
                      </Link>
                    ) : (
                      <span className="truncate">{g.title}</span>
                    )}
                    <ActionButton kind="unignore" repo={fullName} params={{ target: g.key }} variant="ghost">
                      Unignore
                    </ActionButton>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </TabsContent>

        <TabsContent value="inventory" className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4 text-sm">
            {[...byEcosystem].map(([eco, n]) => {
              const e = ecosystemOf(eco);
              return (
                <span key={eco} className="flex items-center gap-1.5">
                  {e ? <BrandLogo light={e.light} dark={e.dark} alt="" className="h-4" /> : null}
                  {e?.label ?? eco} <span className="text-muted-foreground">{n}</span>
                </span>
              );
            })}
          </div>
          {data.inventory.length ? (
            <div className="overflow-x-auto rounded-lg shadow-card">
              <table className="w-full bg-card font-mono text-xs">
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-normal">package</th>
                    <th className="px-3 py-2 text-left font-normal">version</th>
                    <th className="px-3 py-2 text-left font-normal">scope</th>
                    <th className="px-3 py-2 text-left font-normal">workspace</th>
                  </tr>
                </thead>
                <tbody>
                  {data.inventory.slice(0, 400).map((i) => (
                    <tr key={i.id} className="border-t">
                      <td className="px-3 py-1.5">
                        <Link
                          href={`/packages/${i.ecosystem}/${i.name.split("/").map(encodeURIComponent).join("/")}`}
                          className="entity-link"
                        >
                          {i.name}
                        </Link>
                        {i.direct ? "" : <span className="text-muted-foreground"> (transitive)</span>}
                      </td>
                      <td className="px-3 py-1.5">
                        {i.version ?? <span className="text-human">unresolved</span>}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{i.scope}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{i.workspace}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No completed scan yet.</p>
          )}
        </TabsContent>

        <TabsContent value="prs">
          {data.artifacts.length ? (
            <ul className="divide-y overflow-hidden rounded-lg bg-card text-sm shadow-card">
              {data.artifacts.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <a href={a.url ?? "#"} className="block truncate text-link hover:underline">
                      {a.kind === "issue" ? "Issue" : a.kind === "onboarding" ? "Onboarding PR" : "PR"} #
                      {a.number}
                    </a>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {a.changeKey || "Configure Teire"}
                    </span>
                  </span>
                  <Badge variant={a.state === "open" ? "running" : "quiet"}>{a.state}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Teire has not opened a pull request here yet.</p>
          )}
        </TabsContent>

        <TabsContent value="runs">
          {data.runs.length ? (
            <ul className="divide-y overflow-hidden rounded-lg bg-card text-sm shadow-card">
              {data.runs.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/runs/${r.id}`}
                    className="row-link flex items-center justify-between gap-3 px-4 py-3 pr-10 hover:bg-accent"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{r.groupKey}</span>
                      <span className="block text-xs text-muted-foreground">
                        {ago(r.createdAt)} · ${Number(r.costUsd).toFixed(4)}
                        {r.kind === "dry_run" ? " · dry run" : ""}
                      </span>
                    </span>
                    {r.evidenceKind ? (
                      <EvidenceBadge kind={r.evidenceKind} />
                    ) : (
                      <span className="text-xs text-running">{r.status}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          )}
        </TabsContent>

        <TabsContent value="config" className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            The configuration lives in the repository (<span className="font-mono">.github/teire.yml</span>,
            or the organisation&apos;s <span className="font-mono">teire-config</span>). Every key is
            described in the{" "}
            <a href="/schema.json" className="text-link hover:underline">
              schema
            </a>
            .
          </p>
          {config.length ? (
            <div className="overflow-x-auto rounded-lg shadow-card">
              <table className="w-full bg-card font-mono text-xs">
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-normal">key</th>
                    <th className="px-3 py-2 text-left font-normal">value</th>
                    <th className="px-3 py-2 text-left font-normal">from</th>
                  </tr>
                </thead>
                <tbody>
                  {config.map((c) => (
                    <tr key={c.key} className="border-t">
                      <td className="px-3 py-1.5">{c.key}</td>
                      <td className="max-w-xs truncate px-3 py-1.5">{c.value}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{c.origin}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Read at the next scan.</p>
          )}
        </TabsContent>
        <TabsContent value="activity" className="flex flex-col gap-3">
          {data.activity.length ? (
            <ul className="divide-y overflow-hidden rounded-lg bg-card text-sm shadow-card">
              {data.activity.map((a) => (
                <li
                  key={a.id}
                  className="grid gap-1 px-4 py-2.5 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4"
                >
                  <div className="min-w-0">
                    <span className="font-medium">{describeAction(a.kind as ActionKind, a.params)}</span>{" "}
                    <span className="text-muted-foreground">
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
                    {a.result ? <p className="truncate text-xs text-muted-foreground">{a.result}</p> : null}
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    {a.links.map((l) => (
                      <a key={l.href} href={l.href} className="text-link hover:underline">
                        {l.label}
                      </a>
                    ))}
                    <span
                      className={
                        a.status === "done"
                          ? "text-clear"
                          : a.status === "refused" || a.status === "failed"
                            ? "text-affected"
                            : "text-running"
                      }
                    >
                      {a.status}
                    </span>
                    <span className="text-muted-foreground">{ago(a.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing yet. Rescans, fixes, ignores and fix-mode changes show here, whether asked on this page,
              in a comment or in the Dashboard issue.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}
