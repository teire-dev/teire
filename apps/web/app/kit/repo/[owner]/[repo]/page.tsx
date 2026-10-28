import {
  ChevronDown,
  ExternalLink,
  GitPullRequest,
  MessageCircleQuestion,
  RefreshCw,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AssistantPanel, type AssistantTurn } from "@/components/teire/assistant-panel";
import { KitShell } from "@/components/teire/kit-shell";
import { Mark, MarkStack } from "@/components/teire/mark";
import { ProofGlyphs } from "@/components/teire/proof-chain";
import { RunRowItem } from "@/components/teire/run-row";
import { StatusChip, type Tone } from "@/components/teire/status-chip";
import { Surface } from "@/components/teire/surface";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { kitRepo, kitRun, kitShell, type RunRow, requireKit } from "@/lib/kit";
import { languageMarks, subjectMark } from "@/lib/marks";
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

/** A finding group's name: the package, or the provider whose models or API changed. */
function titleOf(key: string) {
  const [head, ...rest] = key.split("/");
  if (head === "models") return `${rest[0]} models`;
  if (head === "api") return `${rest[0]} API`;
  return rest.slice(0, -1).join("/") || key;
}

function Countdown({ date }: { date: Date }) {
  const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
  return days < 0 ? (
    <StatusChip tone="broke">{-days}d past shutdown</StatusChip>
  ) : (
    <StatusChip tone={days <= 90 ? "attention" : "neutral"}>in {days}d</StatusChip>
  );
}

/** The assistant turn shown docked: why this repository's latest draft is a draft, from its record. */
async function draftTurn(fullName: string, runs: RunRow[]): Promise<AssistantTurn | null> {
  const draft = runs.find((r) => r.pr?.kind === "pr" && r.evidence && r.evidence !== "verified");
  if (!draft) return null;
  const run = await kitRun(draft.id);
  if (!run) return null;
  const reason = run.verification?.reasons?.[0] ?? draft.evidence?.replace(/_/g, " ") ?? "";
  // The check that failed, in words (the sandbox's raw output stays on the run page).
  const failedCheck = [...(run.verification?.baseline ?? []), ...(run.verification?.after ?? [])].find(
    (c) => c.exitCode !== 0 || c.timedOut,
  );
  const side =
    failedCheck && run.verification?.baseline?.includes(failedCheck)
      ? "before the change"
      : "after the change";
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
      ...(failedCheck
        ? [
            `Your ${failedCheck.name} check failed ${side}${failedCheck.counts ? ` (${failedCheck.counts.passed}/${failedCheck.counts.collected} passed)` : ""}.`,
          ]
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
  const { repo, fixMode, groups, runs } = data;
  const turn = await draftTurn(fullName, runs);
  const mode = fixMode.mode;
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
              <span className="eyebrow flex items-center gap-2">
                Repository <MarkStack brands={languageMarks(repo.languages)} />
              </span>
              <h1 className="heading flex flex-wrap items-center gap-2 text-3xl text-ink">
                <span>{repo.fullName.split("/")[1]}</span>
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
          <div className="flex flex-wrap items-center gap-3">
            <span className="eyebrow">Fixes</span>
            <ToggleGroup
              type="single"
              defaultValue={mode}
              aria-label="Fix mode"
              className="rounded-lg bg-sunken p-0.5 ring-1 ring-rule ring-inset"
            >
              {[
                ["auto", "Automatic"],
                ["ask", "Ask first"],
                ["off", "Off"],
              ].map(([value, label]) => (
                <ToggleGroupItem
                  key={value}
                  value={value as string}
                  className="h-7 rounded-md px-3 text-xs text-ink-2 data-[state=on]:bg-sheet data-[state=on]:text-ink data-[state=on]:shadow-card"
                >
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <span className="font-mono text-[11px] text-ink-3">
              {fixMode.file
                ? `set in ${fixMode.file}`
                : fixMode.origin === "dashboard"
                  ? "set here"
                  : "installation default"}
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
                    <div className="flex min-w-0 items-start gap-3">
                      <Mark brand={subjectMark(key)} />
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <span className="flex flex-wrap items-center gap-2">
                          <h2 className="heading text-base text-ink">{titleOf(key)}</h2>
                          <StatusChip tone={cls.tone}>{cls.label}</StatusChip>
                          {first?.change?.deadline ? (
                            <Countdown date={new Date(first.change.deadline as unknown as string)} />
                          ) : null}
                        </span>
                        {first?.change?.title ? (
                          <span className="truncate text-xs text-ink-3">
                            {first.change.title.replace(/^[\w.-]+: /, "")}
                          </span>
                        ) : null}
                        <span className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                          {[
                            ...new Set(
                              rows
                                .map((r) => (r.finding.position as { version?: string } | null)?.version)
                                .filter(Boolean),
                            ),
                          ]
                            .slice(0, 3)
                            .map((v) => (
                              <span
                                key={v}
                                className="rounded bg-sunken px-1.5 py-0.5 text-ink-3 line-through decoration-ink-3/40 ring-1 ring-rule ring-inset"
                              >
                                {v}
                              </span>
                            ))}
                          <span className="text-ink-3">→</span>
                          {[
                            ...new Set(
                              rows
                                .map((r) => (r.finding.position as { target?: string } | null)?.target)
                                .filter(Boolean),
                            ),
                          ]
                            .slice(0, 2)
                            .map((v) => (
                              <span
                                key={v}
                                className="rounded bg-sheet px-1.5 py-0.5 text-ink ring-1 ring-rule-strong ring-inset"
                              >
                                {v}
                              </span>
                            ))}
                        </span>
                      </div>
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
                      <MessageCircleQuestion data-icon="inline-start" />
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
