import { PR_MODE_BY_EVIDENCE, PULL_REQUESTS } from "../constants";
import type { ChangeV2, DependencyInstance } from "../contract";
import type { MigrationNote } from "../fix/codemods";
import type { FixRun } from "../fix/run";
import type { DependencyVerdict, FindingDraft } from "../impact";
import type { CheckPlan } from "../verify/commands";
import type { SideResult } from "../verify/evidence";

const ECOSYSTEM_LABEL: Partial<Record<DependencyInstance["ecosystem"], string>> = {
  npm: "JavaScript / TypeScript (npm)",
  pypi: "Python (PyPI)",
  maven: "Java / Kotlin (Maven)",
  go: "Go modules",
  cargo: "Rust (crates.io)",
  rubygems: "Ruby (RubyGems)",
};

/**
 * Pull request and onboarding bodies with the same anatomy everywhere (rule 5): verdict first →
 * why this repo → what changed upstream (quoted, linked) → changes per file → verification
 * (baseline vs after) → receipt (which model did what, tokens, cost, sandbox time) → risks not
 * covered → rollback → commands. Bodies stay under GitHub's 65,536 characters by dropping the
 * inline diff first, then trimming lists.
 */
const MODEL_NAMES: [RegExp, string][] = [
  [/nemotron-3-ultra/i, "NVIDIA Nemotron 3 Ultra"],
  [/nemotron-3-super/i, "NVIDIA Nemotron 3 Super"],
];

export function modelName(id: string) {
  return MODEL_NAMES.find(([re]) => re.test(id))?.[1] ?? id;
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 3)}`;
const escapeCell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export interface RepoRef {
  owner: string;
  repo: string;
  baseSha: string;
}

const blob = (r: RepoRef, file: string, line?: number) =>
  `https://github.com/${r.owner}/${r.repo}/blob/${r.baseSha}/${file}${line ? `#L${line}` : ""}`;

function cell(side: SideResult, name: string) {
  const c = side.checks.find((x) => x.name === name);
  if (!c) return "not run";
  if (c.timedOut) return "timed out";
  const counts = c.counts
    ? `${c.counts.passed}/${c.counts.collected} passed${c.counts.failed ? `, ${c.counts.failed} failed` : ""}`
    : "";
  const errors = c.typeErrors ? `${c.typeErrors} type errors` : "";
  return `${c.exitCode === 0 ? "✓" : "✗"} exit ${c.exitCode}${counts || errors ? ` · ${[counts, errors].filter(Boolean).join(", ")}` : ""}`;
}

/** The Verification section: one table, both sides, then the evidence that decided the PR. */
/** Blocks joined by blank lines, except table rows, which must stay on consecutive lines to render as a table. */
export function joinBlocks(blocks: string[]) {
  return blocks.join("\n\n").replace(/^(\|.*\|)\n\n(?=\|)/gm, "$1\n");
}

/** A quoted table row reads as text: `| Oct 23, 2026 | \`gpt-4.1-nano\` | …` → "Oct 23, 2026 · gpt-4.1-nano · …". */
export function displayQuote(quote: string) {
  if (!quote.trim().startsWith("|")) return quote;
  return quote
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\\\|/g, "/")
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(" · ");
}

/** The closing line names the models that worked on this PR, and says so when none did. */
function footer(runUrl: string | undefined, run: FixRun, extra: (string | undefined)[] = []) {
  const models = [
    ...new Set(
      [...run.attempts.map((a) => a.model), run.review?.model, ...extra]
        .filter((m): m is string => !!m)
        .map(modelName),
    ),
  ];
  return `<sub>Teire${runUrl ? ` · [live run](${runUrl})` : ""} · ${models.length ? `${models.join(" and ")} on Nebius Token Factory` : "deterministic fix, no model call"}</sub>`;
}

function verificationLines(
  run: FixRun,
  plan: CheckPlan,
  backendNote: string,
  setup: string,
  before: string,
  after: string,
) {
  const out = ["### Verification"];
  out.push(
    `${setup} (${backendNote.split(" (")[0]}; registry-only network), then ran the repo's checks with the network off.`,
  );
  out.push(`| Check | Before (${before}) | After (${after}) |`, "|---|---|---|");
  for (const c of plan.checks)
    out.push(
      `| ${c.name} \`${escapeCell(c.argv.join(" ")).slice(0, 80)}\` | ${cell(run.baseline, c.name)} | ${cell(run.after, c.name)} |`,
    );
  out.push(`Evidence: **${run.evidence.kind.replace(/_/g, " ")}**. ${run.evidence.reasons.join("; ")}.`);
  return out;
}

/** The Receipt section: model, tokens and cost per step, and sandbox time. */
function receiptLines(
  run: FixRun,
  backendNote: string,
  notesReceipt?: { model: string; tokensIn: number; tokensOut: number; costUsd: number },
) {
  const out = ["### Receipt", "| Step | Model | Tokens in / out | Cost |", "|---|---|---|---|"];
  if (notesReceipt)
    out.push(
      `| Read the release notes | ${modelName(notesReceipt.model)} | ${tokens(notesReceipt.tokensIn)} / ${tokens(notesReceipt.tokensOut)} | ${usd(notesReceipt.costUsd)} |`,
    );
  if (run.codemods.length) out.push(`| Deterministic edits (${run.codemods.length}) | none | — | $0 |`);
  for (const a of run.attempts) {
    const steps = run.agentSteps.filter((s) =>
      s.attempt === undefined ? s.model === a.model : s.attempt === a.n,
    );
    const tin = steps.reduce((n, s) => n + s.tokensIn, 0);
    const tout = steps.reduce((n, s) => n + s.tokensOut, 0);
    out.push(
      `| Fix attempt ${a.n}${a.replan ? " (replanned)" : ""}: ${a.steps} steps → ${a.evidence.replace(/_/g, " ")} | ${modelName(a.model)}${a.failover ? " (failover)" : ""} | ${tokens(tin)} / ${tokens(tout)} | ${usd(a.costUsd)} |`,
    );
  }
  if (run.review)
    out.push(
      `| Review of the passing diff: ${run.review.problems.length ? `${run.review.problems.length} problem(s) noted` : "no problems found"}${run.review.refuted?.length ? `, ${run.review.refuted.length} refuted by the checks` : ""} | ${modelName(run.review.model)} | ${tokens(run.review.tokensIn)} / ${tokens(run.review.tokensOut)} | ${usd(run.review.costUsd)} |`,
    );
  const sandboxMs = [...run.baseline.checks, ...run.after.checks].reduce(
    (n, c) => n + c.ms,
    run.baseline.install.ms + run.after.install.ms,
  );
  out.push(
    `| Sandboxes: install + checks, both sides | ${backendNote.split(" (")[0]} | — | ${Math.round(sandboxMs / 1000)} s |`,
  );
  out.push(`Model total: **${usd(run.costUsd + (notesReceipt?.costUsd ?? 0))}**.`);
  return out;
}

/** Problems the review of the passing diff still saw: stated, never hidden, and never a score. */
function reviewRisks(run: FixRun) {
  return (run.review?.problems ?? []).map(
    (p) =>
      `Review (${modelName(run.review?.model ?? "")}) of \`${p.file}\`: ${escapeCell(p.problem).slice(0, 300)}`,
  );
}

/** What the review questioned and the checks answered: kept, with the evidence. */
function reviewRefuted(run: FixRun) {
  return (run.review?.refuted ?? []).map(
    (p) =>
      `<sub>The review (${modelName(run.review?.model ?? "")}) questioned \`${p.file}\`: ${escapeCell(p.problem).slice(0, 240)} Kept: ${p.evidence}.</sub>`,
  );
}

export interface FixPullRequestInput {
  repo: RepoRef;
  runId: string;
  runUrl?: string;
  groupKey: string;
  instance: DependencyInstance;
  run: FixRun;
  plan: CheckPlan;
  backendNote: string;
  summary: DependencyVerdict;
  records: ChangeV2[];
  notes: MigrationNote[];
  /** Behaviour changes read from the notes (candidate records, quoted). */
  behaviour: ChangeV2[];
  notesReceipt?: { model: string; tokensIn: number; tokensOut: number; costUsd: number };
}

function verdictLine(input: FixPullRequestInput) {
  const { run, instance } = input;
  const code = run.files.filter((f) => !run.transactionFiles.includes(f.path)).length;
  const test = run.after.checks.find((c) => c.name === "test");
  const what = `\`${instance.name}\` ${instance.version} → ${run.target}${code ? `, with code changes in ${code} file${code === 1 ? "" : "s"}` : ""}`;
  switch (run.evidence.kind) {
    case "verified":
      return `**Verified.** ${what}. The repo's checks pass before and after the upgrade${test?.counts ? ` (${test.counts.passed}/${test.counts.collected} tests)` : ""}.`;
    case "typecheck_only":
      return `**Draft: typecheck only.** ${what}. The typecheck passes; there are no tests to confirm behaviour.`;
    case "pre_existing_failure":
      return `**Draft: checks already failing.** ${what}. Some checks fail on the base branch too; none got worse.`;
    case "needs_live_access":
      return `**Draft: needs live access.** ${what}. Tests that call real services cannot run in the sandbox (network off).`;
    case "needs_local_service":
      return `**Draft: needs a local service.** ${what}. Tests need a database or cache the sandbox does not run.`;
    case "environment_mismatch":
      return `**Draft: environment differs.** ${what}. The sandbox could not reproduce the repo's environment.`;
    default:
      return `**Needs a human.** ${what}. ${run.evidence.reasons.join("; ")}.`;
  }
}

export function composeFixPullRequest(input: FixPullRequestInput): { title: string; body: string } {
  const { run, instance, repo, plan } = input;
  const codeFiles = run.files.filter((f) => !run.transactionFiles.includes(f.path));
  const advisories = input.records.filter((r) => r.kind === "security-advisory");
  const title = advisories.length
    ? `Upgrade ${instance.name} from ${instance.version} to ${run.target} to fix ${advisories.length === 1 ? (advisories[0]?.id.split("/").at(-1) ?? "an advisory") : `${advisories.length} advisories`}`
    : `Upgrade ${instance.name} from ${instance.version} to ${run.target}${codeFiles.length ? " and adapt the code" : ""}`;
  const sections = (withDiff: boolean, siteCap: number, noteCap: number) => {
    const out: string[] = [`<!-- teire:group=${input.groupKey} run=${input.runId} -->`, verdictLine(input)];

    // Why this repo
    const sites = input.summary.breaking.flatMap((f) => f.callSites.map((s) => ({ s, f })));
    out.push("### Why this repo");
    if (advisories.length) {
      out.push(
        `${instance.name} ${instance.version} is ${instance.direct ? "a direct dependency" : "locked as a dependency of your dependencies"} and is in the vulnerable range of:`,
      );
      for (const r of advisories)
        out.push(
          `- [${r.id.split("/").at(-1)}](${r.sources[0]?.url ?? "#"}) ${escapeCell(r.summary).slice(0, 240)}${r.applicability.fixedIn.length ? ` Fixed in ${r.applicability.fixedIn.join(", ")}.` : ""}`,
        );
      if (!sites.length)
        out.push(
          "The advisories name no function to look for, so Teire cannot rule out that your code reaches the vulnerable path.",
        );
    }
    if (sites.length) {
      out.push(
        `${instance.name} ${run.target} removes or changes APIs this repo calls (resolved by type, not by name):`,
      );
      for (const { s, f } of sites.slice(0, siteCap))
        out.push(
          `- [\`${s.file}:${s.line}\`](${blob(repo, s.file, s.line)}) \`${escapeCell(s.snippet).slice(0, 120)}\` (${f.changeKind.replace(/-/g, " ")})`,
        );
      if (sites.length > siteCap) out.push(`- and ${sites.length - siteCap} more`);
    } else if (!advisories.length) {
      const c = input.summary.coverage;
      out.push(
        `No located use of a removed or changed API${c ? ` (${c.filesScanned} files, ${c.resolutionLevel}-resolved, ${c.unresolvedSites} unresolved)` : ""}. This is a plain upgrade, verified in the sandbox.`,
      );
    }
    const drift = input.summary.annotations.flatMap((f) => f.callSites);
    if (drift.length)
      out.push(
        `<sub>Also used, annotated only: ${drift
          .slice(0, 8)
          .map((s) => `[\`${s.file}:${s.line}\`](${blob(repo, s.file, s.line)})`)
          .join(", ")} (type text or deprecation changed).</sub>`,
      );

    // What changed upstream
    out.push("### What changed upstream");
    const counts = input.records
      .filter((r) => r.kind !== "symbol-changed")
      .map((r) => `${r.title.replace(`${instance.name} ${run.target} `, "")}`);
    if (counts.length)
      out.push(
        `From the published type declarations, ${instance.version} vs ${run.target}: ${counts.join("; ")}.`,
      );
    for (const note of input.notes.slice(0, noteCap))
      out.push(
        `> ${note.quote.slice(0, 400)}${note.quote.length > 400 ? "…" : ""}\n>\n> — [${new URL(note.url).pathname.split("/").at(-1) ?? "notes"}](${note.url})`,
      );

    // Changes
    out.push("### Changes");
    out.push("| File | Change |", "|---|---|");
    // A manifest edit to a file the agent then edited (Go's import rewrite) is one row, below.
    for (const m of run.manifest)
      if (!codeFiles.some((f) => f.path === m.path))
        out.push(`| \`${m.path}\` | \`${m.from}\` → \`${m.to}\` |`);
    if (run.lockfile)
      out.push(
        `| \`${run.lockfile.path}\` | regenerated by ${plan.manager}${plan.managerVersion ? ` ${plan.managerVersion}` : ""} (+${run.lockfile.added}/−${run.lockfile.removed} lines) |`,
      );
    for (const path of run.transactionFiles)
      if (path !== run.lockfile?.path && !run.manifest.some((m) => m.path === path))
        out.push(`| \`${path}\` | updated by ${plan.manager} |`);

    for (const f of codeFiles) {
      const moved = run.manifest.find((m) => m.path === f.path);
      const mods = [
        ...(moved ? [`imports \`${moved.from}\` → \`${moved.to}\``] : []),
        ...run.codemods.filter((c) => c.file === f.path).map((c) => c.reason),
      ];
      const by = mods.length ? `Teire: ${mods.join(", ")}` : "";
      const agent = run.attempts.length ? `${modelName(run.attempts.at(-1)?.model ?? "")}` : "";
      out.push(
        `| \`${f.path}\` | ${escapeCell([by, agent && (moved || !mods.length) ? `edited by ${agent}` : ""].filter(Boolean).join("; ") || "edited")} |`,
      );
    }
    if (run.summary) out.push(`<sub>${escapeCell(run.summary).slice(0, 1200)}</sub>`);
    out.push(...reviewRefuted(run));
    if (withDiff && codeFiles.length)
      out.push(
        `<details><summary>Code diff</summary>\n\n\`\`\`diff\n${codeFiles.map((f) => f.patch.replace(/^=+\n/, "")).join("\n")}\n\`\`\`\n\n</details>`,
      );

    out.push(
      ...verificationLines(
        run,
        plan,
        input.backendNote,
        "Each side installed its own lockfile in its own sandbox",
        instance.version ?? "",
        run.target,
      ),
    );
    out.push(...receiptLines(run, input.backendNote, input.notesReceipt));

    // Risks not covered
    out.push("### Risks not covered");
    const risks: string[] = [];
    for (const r of input.behaviour.slice(0, noteCap))
      risks.push(
        `${r.summary}${r.sources[0]?.quote ? ` — "${r.sources[0].quote.slice(0, 200)}" ([source](${r.sources[0].url}))` : ""}`,
      );
    if (run.evidence.kind !== "verified") risks.push(run.evidence.reasons.join("; "));
    risks.push(...reviewRisks(run));
    risks.push(
      "Lint, end-to-end and integration suites were not run; dependencies were installed without lifecycle scripts.",
    );
    for (const r of risks) out.push(`- ${r}`);

    out.push("### Rollback");
    const reverted = [
      ...run.manifest.map((m) => `\`${m.path}\``),
      ...(run.lockfile ? [`\`${run.lockfile.path}\``] : []),
    ];
    out.push(
      `Revert this pull request: ${reverted.join(" and ")} return to ${instance.name} ${instance.version}.`,
    );
    out.push("### Commands");
    out.push(
      `\`@teire rebase\` · \`@teire recreate\` · \`@teire explain\` · \`@teire ignore ${instance.name}\``,
    );
    out.push(footer(input.runUrl, run, [input.notesReceipt?.model]));
    return joinBlocks(out);
  };
  for (const [diff, sites, notes] of [
    [true, PULL_REQUESTS.maxSitesPerFinding, 8],
    [false, PULL_REQUESTS.maxSitesPerFinding, 8],
    [false, 5, 3],
    [false, 2, 1],
  ] as const) {
    const body = sections(diff, sites, notes);
    if (body.length <= PULL_REQUESTS.bodyMaxChars) return { title, body };
  }
  return { title, body: sections(false, 1, 0).slice(0, PULL_REQUESTS.bodyMaxChars) };
}

export interface ApiChangePullRequestInput {
  repo: RepoRef;
  runId: string;
  runUrl?: string;
  groupKey: string;
  findings: FindingDraft[];
  records: ChangeV2[];
  run: FixRun;
  plan: CheckPlan;
  backendNote: string;
  notes: MigrationNote[];
  /** What each retired model became in the final code (the agent's choice where several were named). */
  applied?: { from: string; to: string }[];
  providerName?: string;
}

/**
 * A pull request for a provider's API change (a retired model, a removed endpoint), in the same
 * anatomy as an upgrade: verdict, why this repo, the provider's own words, changes, verification,
 * receipt, risks, rollback, commands.
 */
export function composeApiChangePullRequest(input: ApiChangePullRequestInput): {
  title: string;
  body: string;
} {
  const { run, repo, plan } = input;
  const affected = input.findings.filter((f) => f.verdict === "affected");
  const unsure = input.findings.filter((f) => f.verdict !== "affected");
  const provider = input.providerName ?? input.records[0]?.subject.provider ?? "the provider";
  const swaps = [
    ...new Set(
      input.applied?.length
        ? input.applied.map((a) => `${a.from} → ${a.to}`)
        : affected
            .filter((f) => f.position.target)
            .map((f) => `${f.position.version} → ${f.position.target}`),
    ),
  ];
  const broken = input.records.some((r) => r.applicability.class === "already-broken");
  const title =
    swaps.length === 1
      ? `Replace ${broken ? "retired" : "retiring"} model ${swaps[0]?.replace(" → ", " with ")}`
      : swaps.length
        ? `Replace ${swaps.length} ${broken ? "retired" : "retiring"} ${provider} models`
        : `Adapt to ${input.records[0]?.title ?? "an API change"}`;
  const test = run.after.checks.find((c) => c.name === "test");
  const code = run.files.length;
  const what = `${swaps.join(", ") || input.records.map((r) => r.title).join("; ")}${code ? `, ${code} file${code === 1 ? "" : "s"} changed` : ""}`;
  const verdict =
    run.evidence.kind === "verified"
      ? `**Verified.** ${what}. The repo's checks pass before and after${test?.counts ? ` (${test.counts.passed}/${test.counts.collected} tests)` : ""}.`
      : PR_MODE_BY_EVIDENCE[run.evidence.kind] === "draft"
        ? `**Draft: ${run.evidence.kind.replace(/_/g, " ")}.** ${what}. ${run.evidence.reasons.join("; ")}.`
        : `**Needs a human.** ${what}. ${run.evidence.reasons.join("; ")}.`;
  const sections = (withDiff: boolean, siteCap: number) => {
    const out: string[] = [`<!-- teire:group=${input.groupKey} run=${input.runId} -->`, verdict];
    out.push("### Why this repo");
    for (const f of affected) {
      const record = input.records.find((r) => r.id === f.changeId);
      out.push(`${f.reason}`);
      for (const s of f.callSites.slice(0, siteCap))
        out.push(
          `- [\`${s.file}:${s.line}\`](${blob(repo, s.file, s.line)}) \`${escapeCell(s.snippet).slice(0, 120)}\``,
        );
      if (f.callSites.length > siteCap) out.push(`- and ${f.callSites.length - siteCap} more`);
      if (record?.applicability.effectiveOn && record.applicability.class === "already-broken")
        out.push(`<sub>Calls with this model have failed since ${record.applicability.effectiveOn}.</sub>`);
    }
    if (unsure.length)
      out.push(
        `<sub>Also mentioned, not passed as a model, left unchanged: ${[
          ...new Set(unsure.flatMap((f) => f.callSites).map((s) => `${s.file}:${s.line}`)),
        ]
          .slice(0, 8)
          .map((at) => {
            const [file = "", line = "1"] = at.split(/:(?=\d+$)/);
            return `[\`${at}\`](${blob(repo, file, Number(line))})`;
          })
          .join(", ")}.</sub>`,
      );
    out.push("### What changed upstream");
    for (const note of input.notes.slice(0, 8))
      out.push(
        `> ${escapeCell(displayQuote(note.quote)).slice(0, 400)}\n>\n> — ${note.summary} ([source](${note.url}))`,
      );
    out.push("### Changes");
    out.push("| File | Change |", "|---|---|");
    for (const f of run.files) {
      const mods = run.codemods.filter((c) => c.file === f.path).map((c) => c.reason);
      const agent = run.attempts.length ? modelName(run.attempts.at(-1)?.model ?? "") : "";
      out.push(
        `| \`${f.path}\` | ${escapeCell([mods.length ? `Teire: ${mods.join(", ")}` : "", agent && !mods.length ? `edited by ${agent}` : ""].filter(Boolean).join("; ") || "edited")} |`,
      );
    }
    if (run.summary) out.push(`<sub>${escapeCell(run.summary).slice(0, 1200)}</sub>`);
    out.push(...reviewRefuted(run));
    if (withDiff && run.files.length)
      out.push(
        `<details><summary>Code diff</summary>\n\n\`\`\`diff\n${run.files.map((f) => f.patch.replace(/^=+\n/, "")).join("\n")}\n\`\`\`\n\n</details>`,
      );
    out.push(
      ...verificationLines(
        run,
        plan,
        input.backendNote,
        "Both sides installed the same lockfile in their own sandboxes",
        "old model",
        "new model",
      ),
    );
    out.push(...receiptLines(run, input.backendNote));
    out.push("### Risks not covered");
    const risks = [
      "Tests run with the network off, so no request reached the provider: the new model's answers were not checked against the live API.",
      ...(run.evidence.kind !== "verified" ? [run.evidence.reasons.join("; ")] : []),
      ...reviewRisks(run),
      "Prompts tuned for the old model may need review for the new one's style and output length.",
    ];
    for (const r of risks) out.push(`- ${r}`);
    out.push("### Rollback");
    out.push(
      "Revert this pull request: the model IDs and edited lines return to what they were. No dependency changed.",
    );
    out.push("### Commands");
    out.push("`@teire rebase` · `@teire recreate` · `@teire explain` · `@teire ignore`");
    out.push(footer(input.runUrl, run));
    return joinBlocks(out);
  };
  for (const [diff, sites] of [
    [true, PULL_REQUESTS.maxSitesPerFinding],
    [false, PULL_REQUESTS.maxSitesPerFinding],
    [false, 3],
  ] as const) {
    const body = sections(diff, sites);
    if (body.length <= PULL_REQUESTS.bodyMaxChars) return { title, body };
  }
  return { title, body: sections(false, 1).slice(0, PULL_REQUESTS.bodyMaxChars) };
}

export interface OnboardingRow {
  instance: DependencyInstance;
  target: string | null;
  majorsBehind: number;
  deprecated: string | null;
  verdict: DependencyVerdict["verdict"] | null;
  breakingSites: number;
  coverage: string | null;
}

/** Default `.github/teire.yml` the onboarding PR adds (keys and defaults from card C8). */
export const DEFAULT_CONFIG = `# Teire configuration. Every key is optional; these are the defaults.
# Reference: https://teire.vercel.app/docs/config
version: 1
upgrades:
  majors: true          # open upgrade PRs across major versions
  plainBumps: true      # open verified upgrades with no code change (last in the queue)
  cooldownDays: 7       # wait this long after a release before proposing it
pullRequests:
  limit: 5              # open Teire PRs at most
  perHour: 2            # new Teire PRs per hour at most
dashboardIssue: true
`;

export function composeOnboarding(input: {
  repo: RepoRef;
  rows: OnboardingRow[];
  /** Provider changes found in the code (retired models, removed endpoints). */
  apiFindings?: FindingDraft[];
  scanUrl?: string;
}) {
  const { rows } = input;
  const direct = rows.filter((r) => r.instance.direct);
  const ecosystems = [...new Set(rows.map((r) => r.instance.ecosystem))];
  const affected = direct.filter((r) => r.verdict === "affected");
  const upgrades = direct
    .filter((r) => r.target)
    .sort(
      (a, b) =>
        Number(b.verdict === "affected") - Number(a.verdict === "affected") ||
        b.majorsBehind - a.majorsBehind,
    );
  const out: string[] = ["<!-- teire:onboarding -->"];
  out.push(
    `**Teire is ready for \`${input.repo.owner}/${input.repo.repo}\`.** Merge this pull request to turn it on; it only adds \`.github/teire.yml\` with the defaults.`,
  );
  out.push("### What Teire found");
  out.push(
    `${direct.length} direct dependencies (${rows.length - direct.length} transitive) in ${ecosystems.join(", ")}, at the exact versions your lockfiles pin. ${affected.length} would break this repo's code on upgrade; Teire fixes and verifies those before opening a PR.`,
  );
  if (upgrades.length) {
    out.push("### Upgrades Teire will open after you merge, in this order");
    out.push("| Package | From → to | What it means here |", "|---|---|---|");
    for (const r of upgrades.slice(0, 30))
      out.push(
        `| \`${r.instance.name}\` | ${r.instance.version} → ${r.target} | ${
          r.verdict === "affected"
            ? `breaks ${r.breakingSites} call site${r.breakingSites === 1 ? "" : "s"}: Teire fixes them and proves it`
            : r.verdict === "not_affected"
              ? `not affected${r.coverage ? ` (${r.coverage})` : ""}: verified plain upgrade`
              : r.verdict === "inconclusive"
                ? "could not be decided by type; the sandbox decides"
                : "upgrade checked in the sandbox"
        } |`,
      );
  }
  const found = (input.apiFindings ?? []).filter((f) => f.verdict === "affected");
  const where = (f: FindingDraft) => {
    const site = f.callSites[0];
    return site
      ? `[\`${site.file}:${site.line}\`](${blob(input.repo, site.file, site.line)})${f.callSites.length > 1 ? ` and ${f.callSites.length - 1} more` : ""}`
      : "—";
  };
  const models = found.filter(
    (f) => f.changeKind === "model-retirement" || f.changeKind === "model-rerouted",
  );
  if (models.length) {
    out.push("### Models the providers retired");
    out.push("| In your code | Status | Replacement named by the provider | Where |", "|---|---|---|---|");
    for (const f of models.slice(0, 30))
      out.push(
        `| \`${f.position.version ?? f.dependencyKey}\` | ${f.class === "already-broken" ? "already failing" : f.class === "breaks-on-date" ? "retiring" : f.class.replace(/-/g, " ")} | ${f.position.target ? `\`${f.position.target}\`` : "none named"} | ${where(f)} |`,
      );
    out.push(
      "Teire swaps each one where it is used as a model, adapts the code the new model needs, and proves it with your tests before opening the PR.",
    );
  }
  const apis = found.filter(
    (f) =>
      f.changeKind !== "model-retirement" &&
      f.changeKind !== "model-rerouted" &&
      f.changeKind !== "runtime-eol",
  );
  if (apis.length) {
    out.push("### API changes on operations you call");
    out.push("| Change | Your position → latest | Where |", "|---|---|---|");
    for (const f of apis.slice(0, 30))
      out.push(
        `| ${escapeCell(f.reason).slice(0, 220)} | ${f.position.version ?? "?"} → ${f.position.target ?? "?"} | ${where(f)} |`,
      );
  }
  const runtimes = found.filter((f) => f.changeKind === "runtime-eol");
  if (runtimes.length) {
    out.push("### Runtimes");
    out.push("| Runtime | Support | Move to | Set in |", "|---|---|---|---|");
    for (const f of runtimes)
      out.push(
        `| ${escapeCell(f.reason.split(" reach")[0] ?? f.dependencyKey)} | ${escapeCell(f.reason.split(";")[0]?.replace(/^.* (reached|reaches) /, "$1 ") ?? "")} | ${f.position.target ?? "—"} | ${where(f)} |`,
      );
    out.push(
      "<sub>Notices only: nothing in your code breaks on the date, so Teire opens no PR for them.</sub>",
    );
  }
  out.push("### Inventory");
  for (const eco of ecosystems) {
    const list = direct.filter((r) => r.instance.ecosystem === eco);
    out.push(
      `<details><summary>${ECOSYSTEM_LABEL[eco] ?? eco}: ${list.length} direct</summary>\n\n| Package | Version | Scope | Position |\n|---|---|---|---|`,
    );
    for (const r of list) {
      const chips = [
        r.instance.version === null
          ? r.instance.environment?.markers
            ? `not installed on Linux (\`${r.instance.environment.markers}\`)`
            : `unresolved${r.instance.unresolvedReason ? `: ${r.instance.unresolvedReason}` : ""}`
          : null,
        r.majorsBehind > 0 ? `${r.majorsBehind} major${r.majorsBehind === 1 ? "" : "s"} behind` : null,
        r.deprecated !== null ? "deprecated" : null,
      ].filter(Boolean);
      out.push(
        `| \`${r.instance.name}\` | ${r.instance.version ?? "—"} | ${r.instance.scope} | ${chips.join(" · ") || "up to date"} |`,
      );
    }
    out.push("\n</details>");
  }
  out.push("### How it works here");
  out.push(
    "Teire reads your lockfiles, compares each package's published API between your version and the target, finds the lines that use what changed, fixes them with NVIDIA Nemotron on Nebius Token Factory, and runs your own typecheck and tests before and after in a sandbox with the network off. A PR is ready only when that verification passes; otherwise it opens as a draft that says what is not covered.",
  );
  out.push("### Commands");
  out.push("`@teire rescan` · `@teire pause` · `@teire resume` · `@teire help`");
  out.push(`<sub>Teire${input.scanUrl ? ` · [scan](${input.scanUrl})` : ""}</sub>`);
  return { title: "Configure Teire", body: joinBlocks(out).slice(0, PULL_REQUESTS.bodyMaxChars) };
}
