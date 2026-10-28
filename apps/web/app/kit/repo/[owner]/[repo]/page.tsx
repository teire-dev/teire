import { ChevronDown, ExternalLink, GitPullRequest, RefreshCw, Sparkles, Wrench } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AssistantPanel, type AssistantTurn } from "@/components/teire/assistant-panel";
import { KitShell } from "@/components/teire/kit-shell";
import { ProofGlyphs } from "@/components/teire/proof-chain";
import { RunRowItem } from "@/components/teire/run-row";
import { StatusChip, type Tone } from "@/components/teire/status-chip";
import { Surface } from "@/components/teire/surface";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { kitRepo, kitRun, kitShell, type RunRow, requireKit } from "@/lib/kit";
import { cn } from "@/lib/utils";

export const metadata = { title: "Repository" };

export default function KitRepoPage({ params }: PageProps<"/kit/repo/[owner]/[repo]">) {
  return (
    <Suspense fallback={<div className="m-8 h-96 animate-pulse rounded-lg bg-sheet shadow-card" />}>
      <Repo params={params} />
    </Suspense>
  );
}

const CLASS: Record<string, { label: string; tone: Tone }> = {
  "already-broken": { label: "Already broken", tone: "broke" },
  security: { label: "Security", tone: "broke" },
  dated: { label: "Deadline", tone: "attention" },
  deprecated: { label: "Deprecated", tone: "attention" },
  major: { label: "Major", tone: "neutral" },
};

type Site = { file: string; line: number; snippet?: string };

/** The assistant turn shown docked: why this repository's latest draft is a draft, from its record. */
async function draftTurn(fullName: string, runs: RunRow[]): Promise<AssistantTurn | null> {
  const draft = runs.find((r) => r.pr?.kind === "pr" && r.evidence && r.evidence !== "verified");
  if (!draft) return null;
  const run = await kitRun(draft.id);
  if (!run) return null;
  const reason = run.verification?.reasons?.[0] ?? draft.evidence?.replace(/_/g, " ") ?? "";
  const failed = run.execs.find((x) => x.exitCode !== 0);
  const errorLine = `${failed?.stdoutTail ?? ""}\n${failed?.stderrTail ?? ""}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /error|Error|failed|cannot|refused/.test(l))
    .at(-1);
  const test = run.verification?.after?.find((c) => c.name === "test")?.counts;
  return {
    question: `Why is #${draft.pr?.number} a draft?`,
    steps: [
      { doing: "Reading the run", done: `Read run ${draft.id.slice(0, 8)} on ${fullName}` },
      { doing: "Reading its sandbox commands", done: `Read ${run.execs.length} sandbox commands` },
      { doing: "Reading the pull request", done: `Read #${draft.pr?.number}` },
    ],
    answer: [
      `#${draft.pr?.number} opened as a draft because Teire couldn't prove the change: ${reason}.`,
      ...(failed && errorLine
        ? [`The step that failed was “${failed.phase.replace(/_/g, " ")}”: ${errorLine.slice(0, 220)}`]
        : []),
      "Teire marks a pull request ready only when your own checks pass before and after the change. Re-verifying runs both sides again on the same files.",
    ],
    run: {
      id: draft.id,
      title: `${draft.groupKey} · #${draft.pr?.number}`,
      proof: draft.proof,
      evidence: draft.evidence,
      ledger: test ? `tests ${test.passed}/${test.collected}` : "no tests counted",
    },
    action: {
      effect: `Re-verify run ${draft.id.slice(0, 8)}: both sides again, same files`,
      scope: `${fullName} · #${draft.pr?.number} · needs write access`,
    },
    links: [
      { label: "How the evidence is decided", href: "/docs/build/verification" },
      { label: `Open the run's proof sheet`, href: `/kit/run/${draft.id}` },
    ],
  };
}

async function Repo({ params }: { params: PageProps<"/kit/repo/[owner]/[repo]">["params"] }) {
  const { owner, repo: name } = await params;
  await connection();
  await requireKit();
  const fullName = `${owner}/${name}`;
  const [data, shell] = await Promise.all([kitRepo(fullName), kitShell()]);
  if (!data) return <p className="p-8 text-sm text-ink-3">No public repository named {fullName}.</p>;
  const { repo, groups, runs } = data;
  const turn = await draftTurn(fullName, runs);
  const mode = repo.fixesPaused ? "off" : "auto";
  const affected = groups.filter(([, rows]) => rows.some((r) => r.finding.verdict === "affected"));

  return (
    <KitShell
      account={shell.account}
      repos={shell.repos}
      crumbs={[{ label: shell.account.login, href: "/kit/overview" }, { label: name }]}
      aside={turn ? <AssistantPanel context={fullName} turn={turn} /> : undefined}
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="eyebrow">Repository</span>
              <h1 className="heading flex flex-wrap items-center gap-2 text-2xl text-ink">
                <span className="font-mono">{repo.fullName}</span>
                <StatusChip tone="neutral" glyph={false}>
                  {repo.isPrivate ? "private" : "public"}
                </StatusChip>
                <StatusChip tone={repo.status === "active" ? "proven" : "attention"}>
                  {repo.status}
                  {repo.pausedReason ? ` · ${repo.pausedReason.replace(/_/g, " ")}` : ""}
                </StatusChip>
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm">
                <RefreshCw data-icon="inline-start" />
                Rescan
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={`https://github.com/${repo.fullName}`}>
                  GitHub
                  <ExternalLink data-icon="inline-end" />
                </a>
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-sheet px-4 py-3 shadow-card">
            <span className="eyebrow">Fixes</span>
            <ToggleGroup type="single" defaultValue={mode} variant="outline" size="sm" aria-label="Fix mode">
              <ToggleGroupItem value="auto">Automatic</ToggleGroupItem>
              <ToggleGroupItem value="ask">Ask first</ToggleGroupItem>
              <ToggleGroupItem value="off">Off</ToggleGroupItem>
            </ToggleGroup>
            <span className="text-xs text-ink-3">
              {mode === "off"
                ? "Off here: Teire lists what it finds and opens nothing. Set with @teire pause-fixes."
                : "Automatic: the installation's default. Teire opens a fix when a change reaches your code."}
            </span>
          </div>
          <nav aria-label="Repository" className="flex gap-1 overflow-x-auto border-b border-rule text-sm">
            {["Findings", "Pull requests", "Runs", "Inventory", "Providers", "Config", "Activity"].map(
              (t, i) => (
                <span
                  key={t}
                  className={cn(
                    "-mb-px shrink-0 border-b-2 px-3 py-2",
                    i === 0 ? "border-ink font-medium text-ink" : "border-transparent text-ink-3",
                  )}
                >
                  {t}
                </span>
              ),
            )}
          </nav>
        </header>

        <div className="flex flex-col gap-4">
          <p className="text-xs text-ink-3">
            {affected.length} change{affected.length === 1 ? "" : "s"} reach this code, in priority order.
          </p>
          {affected.slice(0, 8).map(([key, rows]) => {
            const first = rows[0];
            const cls = CLASS[first?.finding.class ?? ""] ?? {
              label: first?.finding.class ?? "change",
              tone: "neutral" as Tone,
            };
            const sites = rows.flatMap((r) =>
              Array.isArray(r.finding.callSites) ? (r.finding.callSites as Site[]) : [],
            );
            const run = runs.find((r) => r.groupKey === key);
            return (
              <Surface key={key} flush>
                <div className="flex flex-col gap-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="flex items-center gap-2">
                        <StatusChip tone={cls.tone}>{cls.label}</StatusChip>
                        <span className="font-mono text-[11px] text-ink-3">{key}</span>
                      </span>
                      <h2 className="heading text-base text-ink">{first?.change?.title ?? key}</h2>
                      {first?.finding.reason ? (
                        <p className="text-xs text-ink-2">{first.finding.reason}</p>
                      ) : null}
                    </div>
                    {run ? (
                      <Link
                        href={`/kit/run/${run.id}`}
                        className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-hover"
                      >
                        <ProofGlyphs proof={run.proof} />
                        <span className="font-mono text-[11px] text-ink-3">
                          {run.pr?.number ? `#${run.pr.number}` : "run"}
                        </span>
                      </Link>
                    ) : null}
                  </div>
                  {sites.length ? (
                    <ul className="flex flex-col overflow-hidden rounded-md bg-sunken ring-1 ring-rule ring-inset">
                      {sites.slice(0, 3).map((s) => (
                        <li
                          key={`${s.file}:${s.line}`}
                          className="flex gap-3 border-b border-rule px-3 py-1.5 font-mono text-[11px] last:border-0"
                        >
                          <span className="shrink-0 text-ink-3">
                            {s.file}:{s.line}
                          </span>
                          <span className="truncate text-ink">{s.snippet}</span>
                        </li>
                      ))}
                      {sites.length > 3 ? (
                        <li className="px-3 py-1.5 font-mono text-[11px] text-ink-3">
                          and {sites.length - 3} more
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    {run?.pr?.url ? (
                      <Button size="sm" asChild>
                        <a href={run.pr.url}>
                          <GitPullRequest data-icon="inline-start" />
                          Open {run.pr.kind === "issue" ? "issue" : "PR"} #{run.pr.number}
                        </a>
                      </Button>
                    ) : (
                      <Button size="sm">
                        <Wrench data-icon="inline-start" />
                        Fix now
                      </Button>
                    )}
                    <Button size="sm" variant="outline">
                      Ignore
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                    <Button size="sm" variant="ghost">
                      <Sparkles data-icon="inline-start" />
                      Explain
                    </Button>
                  </div>
                </div>
              </Surface>
            );
          })}
          <Surface eyebrow="Runs" title="This repository's runs" flush>
            <ul className="divide-y divide-rule">
              {runs.slice(0, 6).map((r) => (
                <RunRowItem key={r.id} row={r} href={`/kit/run/${r.id}`} />
              ))}
            </ul>
          </Surface>
        </div>
      </div>
    </KitShell>
  );
}
