import { PULL_REQUESTS } from "../constants";
import type { ChangeV2, DependencyInstance } from "../contract";
import type { MigrationNote } from "../fix/codemods";
import type { FixRun } from "../fix/run";
import type { DependencyVerdict } from "../impact";
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
    for (const m of run.manifest) out.push(`| \`${m.path}\` | \`${m.from}\` → \`${m.to}\` |`);
    if (run.lockfile)
      out.push(
        `| \`${run.lockfile.path}\` | regenerated by ${plan.manager}${plan.managerVersion ? ` ${plan.managerVersion}` : ""} (+${run.lockfile.added}/−${run.lockfile.removed} lines) |`,
      );
    for (const path of run.transactionFiles)
      if (path !== run.lockfile?.path && !run.manifest.some((m) => m.path === path))
        out.push(`| \`${path}\` | updated by ${plan.manager} |`);

    for (const f of codeFiles) {
      const mods = run.codemods.filter((c) => c.file === f.path).map((c) => c.reason);
      const by = mods.length ? `Teire: ${mods.join(", ")}` : "";
      const agent = run.attempts.length ? `${modelName(run.attempts.at(-1)?.model ?? "")}` : "";
      out.push(
        `| \`${f.path}\` | ${escapeCell([by, agent && !mods.length ? `edited by ${agent}` : ""].filter(Boolean).join("; ") || "edited")} |`,
      );
    }
    if (run.summary) out.push(`<sub>${escapeCell(run.summary).slice(0, 1200)}</sub>`);
    if (withDiff && codeFiles.length)
      out.push(
        `<details><summary>Code diff</summary>\n\n\`\`\`diff\n${codeFiles.map((f) => f.patch.replace(/^=+\n/, "")).join("\n")}\n\`\`\`\n\n</details>`,
      );

    // Verification
    out.push("### Verification");
    out.push(
      `Each side installed its own lockfile in its own sandbox (${input.backendNote.split(" (")[0]}; registry-only network), then ran the repo's checks with the network off.`,
    );
    out.push(`| Check | Before (${instance.version}) | After (${run.target}) |`, "|---|---|---|");
    for (const c of plan.checks)
      out.push(
        `| ${c.name} \`${escapeCell(c.argv.join(" ")).slice(0, 80)}\` | ${cell(run.baseline, c.name)} | ${cell(run.after, c.name)} |`,
      );
    out.push(`Evidence: **${run.evidence.kind.replace(/_/g, " ")}**. ${run.evidence.reasons.join("; ")}.`);

    // Receipt
    out.push("### Receipt");
    out.push("| Step | Model | Tokens in / out | Cost |", "|---|---|---|---|");
    if (input.notesReceipt)
      out.push(
        `| Read the release notes | ${modelName(input.notesReceipt.model)} | ${tokens(input.notesReceipt.tokensIn)} / ${tokens(input.notesReceipt.tokensOut)} | ${usd(input.notesReceipt.costUsd)} |`,
      );
    if (run.codemods.length) out.push(`| Deterministic edits (${run.codemods.length}) | none | — | $0 |`);
    for (const a of run.attempts) {
      const steps = run.agentSteps.filter((s) => s.model === a.model);
      const tin = steps.reduce((n, s) => n + s.tokensIn, 0);
      const tout = steps.reduce((n, s) => n + s.tokensOut, 0);
      out.push(
        `| Fix attempt ${a.n}${a.replan ? " (replanned)" : ""}: ${a.steps} steps → ${a.evidence.replace(/_/g, " ")} | ${modelName(a.model)}${a.failover ? " (failover)" : ""} | ${tokens(tin)} / ${tokens(tout)} | ${usd(a.costUsd)} |`,
      );
    }
    const sandboxMs = [...run.baseline.checks, ...run.after.checks].reduce(
      (n, c) => n + c.ms,
      run.baseline.install.ms + run.after.install.ms,
    );
    out.push(
      `| Sandboxes: install + checks, both sides | ${input.backendNote.split(" (")[0]} | — | ${Math.round(sandboxMs / 1000)} s |`,
    );
    out.push(`Model total: **${usd(run.costUsd + (input.notesReceipt?.costUsd ?? 0))}**.`);

    // Risks not covered
    out.push("### Risks not covered");
    const risks: string[] = [];
    for (const r of input.behaviour.slice(0, noteCap))
      risks.push(
        `${r.summary}${r.sources[0]?.quote ? ` — "${r.sources[0].quote.slice(0, 200)}" ([source](${r.sources[0].url}))` : ""}`,
      );
    if (run.evidence.kind !== "verified") risks.push(run.evidence.reasons.join("; "));
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
    out.push(
      `<sub>Teire${input.runUrl ? ` · [live run](${input.runUrl})` : ""} · fixed with NVIDIA Nemotron on Nebius Token Factory</sub>`,
    );
    return out.join("\n\n");
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

export function composeOnboarding(input: { repo: RepoRef; rows: OnboardingRow[]; scanUrl?: string }) {
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
  return { title: "Configure Teire", body: out.join("\n\n").slice(0, PULL_REQUESTS.bodyMaxChars) };
}
