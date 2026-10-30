import { maskSecrets } from "@teire/engine/redact";
import { Lock, Pause, Play, RefreshCw } from "lucide-react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { RemoveRepository } from "@/components/app/access-controls";
import { ActionButton } from "@/components/app/action-button";
import { FixModeControl } from "@/components/app/fix-mode-control";
import { RepoTabs } from "@/components/app/repo-tabs";
import { AskButton } from "@/components/assistant/ask-button";
import { AskContext } from "@/components/assistant/assistant-provider";
import { BrandLogo } from "@/components/brand-logo";
import { TileSquare } from "@/components/flow/tile";
import { MarkStack } from "@/components/teire/mark";
import { StatusChip } from "@/components/teire/status-chip";
import { Button } from "@/components/ui/button";
import { SPONSORS } from "@/lib/brands";
import { repoDetailCached } from "@/lib/dashboard";
import { bucketGroups, groupFindings } from "@/lib/findings";
import { languageMarks } from "@/lib/marks";
import { getSession } from "@/lib/session";
import { ago } from "@/lib/time";
import { SignInCard } from "../../../gate";

/**
 * One repository (plan revision 3.4, V4): its tile in its state (working, last scan failed, paused),
 * name and one line of where it stands, Rescan, Pause, Ask and GitHub, the fix mode, then tabs that
 * are each their own URL.
 */
export default function RepoLayout({ children, params }: LayoutProps<"/app/repos/[owner]/[repo]">) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <Suspense fallback={<div className="h-28 animate-pulse rounded-xl bg-sheet shadow-card" />}>
        <Header params={params} />
      </Suspense>
      {children}
    </div>
  );
}

async function Header({ params }: { params: LayoutProps<"/app/repos/[owner]/[repo]">["params"] }) {
  await connection();
  const [{ owner, repo: name }, session] = await Promise.all([params, getSession()]);
  const fullName = `${owner}/${name}`;
  if (!session) return <SignInCard next={`/app/repos/${fullName}`} />;
  const data = await repoDetailCached(session.user.id, fullName);
  if (!data) notFound();
  const { repo, fixMode } = data;
  const open = data.findings.filter((f) => f.state === "open");
  const b = bucketGroups(groupFindings(open));
  const state =
    repo.status === "paused"
      ? {
          label: `Paused${repo.pausedReason ? `: ${repo.pausedReason.replace(/_/g, " ")}` : ""}`,
          tone: "neutral" as const,
        }
      : repo.status === "active"
        ? { label: "Active", tone: "proven" as const }
        : {
            label: repo.status === "disabled" ? "Removed from the installation" : "Onboarding",
            tone: "attention" as const,
          };
  const base = `/app/repos/${fullName}`;
  const live = data.runs.some((r) => r.status === "running" || r.status === "stopping");
  const failed = data.latestScan?.status === "failed";
  const tile = live ? "live" : failed ? "failed" : repo.status === "paused" ? "skipped" : "done";
  return (
    <header className="flex flex-col gap-4">
      <AskContext kind="repo" id={fullName} label={fullName} />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <TileSquare tile={{ entity: "repository", state: tile, label: name }} size="md" />
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="heading flex items-center gap-2 text-2xl text-ink">
              <span className="truncate">{name}</span>
              {repo.isPrivate ? <Lock className="size-4 shrink-0 text-ink-3" aria-label="Private" /> : null}
              {repo.status !== "active" ? <StatusChip tone={state.tone}>{state.label}</StatusChip> : null}
            </h1>
            <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-3">
              <MarkStack brands={languageMarks(repo.languages)} max={3} />
              <span>{owner}</span>
              <span aria-hidden>·</span>
              <span title={repo.lastScannedSha ?? undefined}>
                {repo.lastScannedAt ? `scanned ${ago(repo.lastScannedAt)}` : "not scanned yet"}
                {repo.lastScannedSha ? ` at ${repo.lastScannedSha.slice(0, 7)}` : ""}
              </span>
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ActionButton kind="rescan" repo={fullName}>
            <RefreshCw data-icon="inline-start" aria-hidden />
            Rescan
          </ActionButton>
          <ActionButton kind={repo.status === "paused" ? "resume" : "pause"} repo={fullName} variant="ghost">
            {repo.status === "paused" ? (
              <Play data-icon="inline-start" aria-hidden />
            ) : (
              <Pause data-icon="inline-start" aria-hidden />
            )}
            {repo.status === "paused" ? "Resume" : "Pause"}
          </ActionButton>
          <AskButton
            icon
            question={`Explain where ${fullName} stands: what reaches its code, what Teire is doing and what needs me`}
            context={{ kind: "repo", id: fullName, label: fullName }}
          >
            Ask about this repository
          </AskButton>
          {repo.status !== "disabled" ? <RemoveRepository repo={fullName} /> : null}
          <Button asChild variant="ghost" size="icon-sm" aria-label="Open on GitHub" title="Open on GitHub">
            <a href={`https://github.com/${fullName}`}>
              <BrandLogo
                light={SPONSORS.github.light}
                dark={SPONSORS.github.dark}
                alt=""
                className="size-4"
              />
            </a>
          </Button>
        </div>
      </div>
      {data.suspended ? (
        <p className="w-fit rounded-full bg-attention-soft px-3 py-1 text-xs text-attention">
          Suspended on GitHub: nothing runs here
        </p>
      ) : null}
      {failed ? (
        <p className="flex items-center gap-2 rounded-lg bg-broke-soft px-3 py-2 text-xs text-broke">
          <span className="font-medium">Last scan failed</span>
          {data.latestScan?.error ? (
            <span className="truncate font-mono" title={maskSecrets(data.latestScan.error)}>
              {maskSecrets(data.latestScan.error).slice(0, 160)}
            </span>
          ) : null}
        </p>
      ) : null}
      <FixModeControl repo={fullName} mode={fixMode.mode} origin={fixMode.origin} file={fixMode.file} />
      <RepoTabs
        base={base}
        tabs={[
          { key: "findings", label: "Findings", count: b.affected.length + b.human.length },
          {
            key: "prs",
            label: "Pull requests",
            count: data.artifacts.filter((a) => a.state === "open").length,
          },
          // The tabs read the latest 25 runs and 40 actions; a full page says so instead of a total.
          { key: "runs", label: "Runs", count: data.runs.length >= 25 ? "25+" : data.runs.length },
          { key: "inventory", label: "Inventory", count: data.inventory.length },
          { key: "providers", label: "Providers", count: data.providers.length },
          { key: "config", label: "Config" },
          {
            key: "activity",
            label: "Activity",
            count: data.activity.length >= 40 ? "40+" : data.activity.length,
          },
        ]}
      />
    </header>
  );
}
