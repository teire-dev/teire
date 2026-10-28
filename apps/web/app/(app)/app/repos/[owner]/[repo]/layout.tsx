import { ExternalLink, Lock } from "lucide-react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ActionButton } from "@/components/app/action-button";
import { FixModeControl } from "@/components/app/fix-mode-control";
import { RepoTabs } from "@/components/app/repo-tabs";
import { MarkStack } from "@/components/teire/mark";
import { ago } from "@/components/teire/run-row";
import { StatusChip } from "@/components/teire/status-chip";
import { Button } from "@/components/ui/button";
import { repoDetailCached } from "@/lib/dashboard";
import { bucketGroups, groupFindings } from "@/lib/findings";
import { languageMarks } from "@/lib/marks";
import { getSession } from "@/lib/session";
import { SignInCard } from "../../../gate";

/**
 * One repository (plan revision 3.3, U3): its header (name, visibility, state, the fix mode, Rescan,
 * Pause, GitHub) over tabs that are each their own URL.
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
  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="eyebrow flex items-center gap-2">
            {owner}
            {repo.isPrivate ? (
              <span className="flex items-center gap-1 normal-case">
                <Lock className="size-3" aria-hidden /> private
              </span>
            ) : null}
          </span>
          <h1 className="heading flex flex-wrap items-center gap-3 text-2xl text-ink">
            {name}
            <MarkStack brands={languageMarks(repo.languages)} />
            <StatusChip tone={state.tone}>{state.label}</StatusChip>
          </h1>
          <span className="font-mono text-[11px] text-ink-3">
            scanned {repo.lastScannedAt ? ago(repo.lastScannedAt) : "not yet"}
            {repo.lastScannedSha ? ` at ${repo.lastScannedSha.slice(0, 7)}` : ""}
            {repo.configSource ? ` · ${repo.configSource}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton kind="rescan" repo={fullName}>
            Rescan
          </ActionButton>
          <ActionButton kind={repo.status === "paused" ? "resume" : "pause"} repo={fullName}>
            {repo.status === "paused" ? "Resume Teire here" : "Pause Teire here"}
          </ActionButton>
          <Button asChild variant="outline" size="sm">
            <a href={`https://github.com/${fullName}`}>
              GitHub <ExternalLink data-icon="inline-end" aria-hidden />
            </a>
          </Button>
        </div>
      </div>
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
          { key: "runs", label: "Runs", count: data.runs.length },
          { key: "inventory", label: "Inventory", count: data.inventory.length },
          { key: "providers", label: "Providers", count: data.providers.length },
          { key: "config", label: "Config" },
          { key: "activity", label: "Activity", count: data.activity.length },
        ]}
      />
    </header>
  );
}
