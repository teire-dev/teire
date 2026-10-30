import { PR_MODE_BY_EVIDENCE, PULL_REQUESTS } from "../constants";
import type { ChangeV2, Coverage, DependencyInstance } from "../contract";
import { usageCell } from "../fix/co-moved";
import type { MigrationNote } from "../fix/codemods";
import type { FixRun } from "../fix/run";
import type { DependencyVerdict, FindingDraft } from "../impact";
import { versionScheme } from "../registry/versions";
import type { CheckPlan } from "../verify/commands";

/** Evidence reasons as GitHub shows them: redacted and bounded (review R18); the run page keeps them whole. */
const saidReasons = (reasons: string[]) => reasons.map((r) => forGitHub(r, 400)).join("; ");

import type { SideResult } from "../verify/evidence";
import { forGitHub } from "./redact";

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
  [/nemotron-3\.5-super/i, "NVIDIA Nemotron 3.5 Super"],
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
/**
 * The run's flow as the body's first picture (plan revision 3.4, V6 and C12): Teire's own image of
 * the run (`/og/run/<id>`), linked to the live run page. A private repository's image draws only the
 * steps' states. Nothing when the run has no page.
 */
export function runFlowImage(runUrl: string | undefined) {
  // Versioned, so GitHub's image proxy fetches the current look rather than a cached older one.
  const image = runUrl?.replace(/\/runs\/([0-9a-f-]{36})$/, `/og/run/$1?v=${FLOW_IMAGE_VERSION}`);
  if (!runUrl || !image || image === runUrl) return null;
  return flowImage(
    image,
    runUrl,
    "The run as Teire drew it: the change, your code, the fix, your checks before and after, and this outcome",
  );
}

/** Any of Teire's flow images (a scan, a change) as a body's first picture, linked to its page. */
export function flowImage(image: string, href: string, alt: string) {
  return `[![${alt.replace(/[[\]]/g, "")}](${image})](${href})`;
}

/** The run image's look; bumped when it changes so the image proxy refetches it. */
const FLOW_IMAGE_VERSION = 2;

/** The sections a reviewer reads only to check something: folded under their own heading. */
const FOLDED = new Set(["What changed upstream", "Supply chain", "Receipt"]);

/**
 * Upstream's lead stays open (revamp S2: proof in view): the section's opening lines up to and
 * including its first quote show under the heading, and only the rest folds.
 */
const LEADS_OPEN = new Set(["What changed upstream"]);
const LEAD_BLOCKS = 3;

/**
 * Each folded section (a "### Title" block and the blocks under it, up to the next heading or the
 * footer) as one <details>, so the body opens on the verdict, why, verification and risks.
 */
export function foldSections(blocks: string[]) {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const head = /^### (.+)$/.exec(blocks[i] ?? "");
    if (!head?.[1] || !FOLDED.has(head[1])) {
      out.push(blocks[i] as string);
      continue;
    }
    const inner: string[] = [];
    while (i + 1 < blocks.length && !/^### |^<sub>Teire/.test(blocks[i + 1] ?? ""))
      inner.push(blocks[++i] as string);
    if (LEADS_OPEN.has(head[1])) {
      const quote = inner.findIndex((b) => b.startsWith(">"));
      const lead = inner.splice(0, quote >= 0 && quote < LEAD_BLOCKS ? quote + 1 : Math.min(1, inner.length));
      out.push(blocks[i - inner.length - lead.length] as string, ...lead);
      if (inner.length)
        out.push(
          `<details><summary><b>More from upstream</b></summary>\n\n${joinBlocks(inner)}\n\n</details>`,
        );
      continue;
    }
    out.push(`<details><summary><b>${head[1]}</b></summary>\n\n${joinBlocks(inner)}\n\n</details>`);
  }
  return out;
}

export function joinBlocks(blocks: string[]) {
  return blocks.join("\n\n").replace(/^(\|.*\|)\n\n(?=\|)/gm, "$1\n");
}

/**
 * A surface record's title without its "<name> <from> → <to>: " lead ("removes 34 API(s)"). Records
 * stored before both versions were in the title read "<name> <version> removes …".
 */
export function changeSummary(title: string, name: string) {
  const lead = title.indexOf(": ");
  if (lead > 0 && title.slice(0, lead).includes(" → ")) return title.slice(lead + 2);
  return title.startsWith(`${name} `) ? title.slice(name.length + 1).replace(/^\S+ /, "") : title;
}

/**
 * Upstream text (release notes, advisories, provider pages) made safe for a PR body, following
 * Dependabot's link and mention sanitiser (dependabot-core, MIT,
 * `common/lib/dependabot/pull_request_creator/message_builder/link_and_mention_sanitizer.rb`):
 * - `@user` becomes code with a zero-width space, so no maintainer is pinged;
 * - links to GitHub issues, PRs and commits go through `redirect.github.com`, so the upstream
 *   thread gets no back-reference;
 * - a bare `#123` links to the upstream repo's issue, never to this repo's;
 * - HTML is shown as text, so a stray `<details>` can't swallow the rest of the body.
 */
export function sanitizeUpstream(text: string, upstream?: { owner: string; repo: string } | null) {
  return text
    .replace(/</g, "&lt;")
    .replace(
      /(^|[\s(])@([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w.-]*@)/gi,
      (_, pre: string, user: string) => `${pre}\`@\u200B${user}\``,
    )
    .replace(
      /https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+\/(?:issues|pull|commit|discussions)\/[\w#-]+)/g,
      "https://redirect.github.com/$1",
    )
    .replace(
      /(^|[\s(])([\w.-]+\/[\w.-]+)#(\d+)\b/g,
      (_, pre: string, nwo: string, n: string) =>
        `${pre}[${nwo}#${n}](https://redirect.github.com/${nwo}/issues/${n})`,
    )
    .replace(/(^|[\s(])#(\d+)\b/g, (_, pre: string, n: string) =>
      upstream
        ? `${pre}[${upstream.owner}/${upstream.repo}#${n}](https://redirect.github.com/${upstream.owner}/${upstream.repo}/issues/${n})`
        : `${pre}#\u200B${n}`,
    );
}

/** The GitHub repo a source URL belongs to, for linking its bare `#123` references. */
export function upstreamRepoOf(url: string | undefined) {
  const m = url ? /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/.exec(url) : null;
  return m ? { owner: m[1] as string, repo: (m[2] as string).replace(/\.git$/, "") } : null;
}

/** A quote as a Markdown blockquote: every line prefixed, so a multi-line quote stays inside it. */
export function blockquote(text: string) {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** The last path segment of a URL as a link label, or null when the URL doesn't parse. */
function urlLabel(url: string) {
  return safeUrl(url) ? (new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "source") : null;
}

/**
 * An upstream URL fit to link (D-17): http(s) only, with the characters that would end a Markdown
 * link escaped. Anything else (`javascript:`, a relative path, text that doesn't parse) is null.
 */
export function safeUrl(url: string | null | undefined) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.href.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
  } catch {
    return null;
  }
}

/** `[label](url)` for a safe URL, else the label as plain text. */
export function link(label: string, url: string | null | undefined) {
  const safe = safeUrl(url);
  return safe ? `[${label}](${safe})` : label;
}

/**
 * A body cut to GitHub's limit, saying so and where the rest is (D-15). Whole blocks only: a table
 * is one block (joinBlocks keeps its rows together), so no row is cut, and a `<details>` the cut
 * leaves open is closed so the note after it isn't folded away.
 */
export function fitBody(body: string, max: number, runUrl?: string) {
  if (body.length <= max) return body;
  const note = `\n\n_Description shortened to fit GitHub's limit${runUrl ? `; the full evidence is on the [run page](${runUrl})` : ""}._`;
  const open = (text: string) =>
    (text.match(/<details\b/g) ?? []).length - (text.match(/<\/details>/g) ?? []).length;
  const closing = (text: string) => "\n\n</details>".repeat(Math.max(0, open(text)));
  const kept: string[] = [];
  for (const block of body.split("\n\n")) {
    const next = [...kept, block].join("\n\n");
    if (next.length + closing(next).length + note.length > max) break;
    kept.push(block);
  }
  const text = kept.join("\n\n");
  return `${text}${closing(text)}${note}`;
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
    backendNote.startsWith("Token Factory")
      ? `${setup} (Token Factory Sandboxes, a microVM per command; the install had the network, the checks had no network interface).`
      : `${setup} (${backendNote.split(" (")[0]}; registry-only network), then ran the repo's checks with the network off.`,
  );
  out.push(`| Check | Before (${before}) | After (${after}) |`, "|---|---|---|");
  for (const c of plan.checks)
    out.push(
      `| ${c.name} \`${escapeCell(c.argv.join(" ")).slice(0, 80)}\` | ${cell(run.baseline, c.name)} | ${cell(run.after, c.name)} |`,
    );
  out.push(`Evidence: **${run.evidence.kind.replace(/_/g, " ")}**. ${saidReasons(run.evidence.reasons)}.`);
  // S15.6: a pass proven with no network says so, and how the network was kept out.
  if (run.evidence.kind === "verified") {
    const refused = run.after.deniedHosts.length;
    out.push(
      backendNote.startsWith("Token Factory")
        ? "**Proven offline:** the checks passed in microVMs with no network interface at all."
        : `**Proven offline:** the checks passed with every request refused${
            refused
              ? `; ${refused} host${refused === 1 ? "" : "s"} tried and ${refused === 1 ? "was" : "were"} refused (${run.after.deniedHosts
                  .slice(0, 5)
                  .map((h) => `\`${h}\``)
                  .join(", ")})`
              : ", and none was tried"
          }.`,
    );
  }
  // The other projects the change touches, each with its own checks (D94).
  if (run.others?.length) {
    const side = (s: FixRun["baseline"]) =>
      s.install.ok
        ? s.checks.map((c) => `${c.name} ${cell(s, c.name)}`).join(" · ") || "no checks"
        : `install ✗ exit ${s.install.exitCode}`;
    out.push(
      "The change also touches these projects; each installed and ran its own checks before and after:",
      "| Project | Before | After | Evidence |",
      "|---|---|---|---|",
    );
    for (const o of run.others)
      out.push(
        `| \`${o.root === "." ? "/" : o.root}\` (${ECOSYSTEM_LABEL[o.ecosystem] ?? o.ecosystem}) | ${side(o.baseline as FixRun["baseline"])} | ${side(o.after as FixRun["baseline"])} | ${o.evidence.kind.replace(/_/g, " ")} |`,
      );
  }
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
  if (run.triage)
    out.push(
      `| Why the install failed: ${run.triage.error ? "not concluded" : run.triage.kind} | ${modelName(run.triage.model)} | ${tokens(run.triage.tokensIn)} / ${tokens(run.triage.tokensOut)} | ${usd(run.triage.costUsd)} |`,
    );
  if (run.review)
    out.push(
      run.review.scope === "change"
        ? `| Review of the dependency change: ${run.review.error ? "not concluded" : run.review.problems.length ? `${run.review.problems.length} thing(s) to look at` : "nothing needs a person"} | ${modelName(run.review.model)} | ${tokens(run.review.tokensIn)} / ${tokens(run.review.tokensOut)} | ${usd(run.review.costUsd)} |`
        : `| Review of the passing diff: ${run.review.problems.length ? `${run.review.problems.length} problem(s) noted` : "no problems found"}${run.review.refuted?.length ? `, ${run.review.refuted.length} refuted by the checks` : ""} | ${modelName(run.review.model)} | ${tokens(run.review.tokensIn)} / ${tokens(run.review.tokensOut)} | ${usd(run.review.costUsd)} |`,
    );
  const sandboxMs = [...run.baseline.checks, ...run.after.checks].reduce(
    (n, c) => n + c.ms,
    run.baseline.install.ms + run.after.install.ms,
  );
  out.push(
    `| Sandboxes: install + checks, both sides | ${backendNote.split(" (")[0]} | — | ${Math.round(sandboxMs / 1000)} s |`,
  );
  if (run.depCache) out.push(`| Package cache: ${run.depCache.note} | — | — | — |`);
  out.push(`Model total: **${usd(run.costUsd + (notesReceipt?.costUsd ?? 0))}**.`);
  return out;
}

/** Problems the review of the passing diff still saw: stated, never hidden, and never a score. */
function reviewRisks(run: FixRun) {
  return [
    ...sandboxNotes(run),
    ...(run.review?.problems ?? []).map(
      (p) =>
        `Review (${modelName(run.review?.model ?? "")}) of \`${p.file}\`: ${escapeCell(p.problem).slice(0, 300)}`,
    ),
  ];
}

/** What the sandbox did differently from the repository as committed (review round 2). */
function sandboxNotes(run: FixRun) {
  const notes: string[] = [];
  if (run.baseline.install.output.includes("teire: Cargo.lock is behind Cargo.toml"))
    notes.push(
      "The committed `Cargo.lock` was behind `Cargo.toml`, so both sides were checked on the lock `cargo build` brings up to date, not the committed one.",
    );
  return notes;
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
  /** The updater resolved the package only this far (D103): the target was capped, and why. */
  targetMax?: { name: string; version: string; reason: string };
  /** Supply-chain changes between the installed version and the target (D-14). */
  supplyChain?: string[];
  /** The newer major tried first (D71): its checks still failed after the agent's attempts. */
  fallbackFrom?: { version: string; reason: string };
  /** Dependabot's open PRs for this package (S18.6), linked as superseded. */
  supersedes?: { number: number; title: string; url: string }[];
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
      // Also a project of the change that couldn't be checked at all (review round 2): the reasons say which.
      return `**Draft: not everything could be checked.** ${what}. ${saidReasons(run.evidence.reasons)}.`;
    default:
      return `**Needs a human.** ${what}. ${saidReasons(run.evidence.reasons)}.`;
  }
}

/**
 * Dependabot's `updated-dependencies` trailer (S20.2): the YAML block after `---` that merge bots
 * and `dependabot/fetch-metadata` parse, one entry per package the change moves.
 */
export function updatedDependenciesTrailer(
  instance: Pick<DependencyInstance, "name" | "direct" | "scope" | "version" | "ecosystem">,
  target: string,
  moved: { name: string; from: string | null; to: string | null; removed?: boolean }[] = [],
  /** The project's own declarations: a co-moved package it names directly is typed as Dependabot types it. */
  declared: Pick<DependencyInstance, "name" | "direct" | "scope">[] = [],
) {
  const scheme = versionScheme(instance.ecosystem);
  const updateType = (from: string | null, to: string) => {
    if (!from || !scheme.valid(from) || !scheme.valid(to)) return null;
    if (scheme.breaking(from, to)) return "version-update:semver-major";
    const minor = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 2).join(".");
    return minor(from) === minor(to) ? "version-update:semver-patch" : "version-update:semver-minor";
  };
  const typeOf = (i: Pick<DependencyInstance, "direct" | "scope">) =>
    i.direct
      ? `direct:${i.scope === "dev" || i.scope === "test" ? "development" : "production"}`
      : "indirect";
  const type = typeOf(instance);
  const entries = [
    { name: instance.name, to: target, type, update: updateType(instance.version, target) },
    ...moved
      .filter((m) => !m.removed && m.to && m.name !== instance.name)
      .map((m) => ({
        name: m.name,
        to: m.to as string,
        type: (() => {
          const own = declared.find((d) => d.name === m.name && d.direct);
          return own ? typeOf(own) : "indirect";
        })(),
        update: updateType(m.from, m.to as string),
      })),
  ];
  return [
    "---",
    "updated-dependencies:",
    ...entries.flatMap((e) => [
      `- dependency-name: ${e.name}`,
      `  dependency-version: ${e.to}`,
      `  dependency-type: ${e.type}`,
      ...(e.update ? [`  update-type: ${e.update}`] : []),
    ]),
    "...",
  ].join("\n");
}

/**
 * The commit prefix a repository's own history uses (S20.2, D-16): Conventional Commits in most of its
 * recent subjects → `chore(deps): ` (`chore(deps-dev): ` for a development dependency), or the
 * type the repo itself uses for dependency commits (`build(deps): `); otherwise none.
 */
export function inferredCommitPrefix(
  commits: (string | { subject: string; bot?: boolean })[],
  development: boolean,
) {
  // As Dependabot reads them (S19 review B9): a person's commits, not merges or bots', and a style
  // that over 30% of them follow.
  const subjects = commits
    .map((c) => (typeof c === "string" ? { subject: c } : c))
    .filter((c) => !c.bot && !c.subject.startsWith("Merge "))
    .map((c) => c.subject);
  if (!subjects.length) return "";
  const share = (re: RegExp) => subjects.filter((s) => re.test(s)).length / subjects.length;
  if (share(/^[a-z]+(?:\([^)]*\))?!?: /) > 0.3) {
    const depsType = subjects
      .map((s) => /^([a-z]+)\(deps(?:-dev)?\)!?: /.exec(s)?.[1])
      .find((t): t is string => Boolean(t));
    const types = new Set(subjects.map((s) => /^([a-z]+)[(!:]/.exec(s)?.[1]));
    const type = depsType ?? (types.has("chore") && !types.has("build") ? "chore" : "build");
    return `${type}(deps${development ? "-dev" : ""}): `;
  }
  if (share(/^(?:Breaking|Build|Chore|Docs|Fix|New|Update|Upgrade): /) > 0.3) return "Upgrade: ";
  if (share(/^(?:\p{Extended_Pictographic}|:[a-z0-9_+-]+:)/u) > 0.3) return "⬆️ ";
  return "";
}

/**
 * A commit message prefix as Dependabot writes an explicit one (S19 review B8): `(deps)` or
 * `(deps-dev)` when dependabot.yml says `include: scope`, a colon after a word, a bracket or a
 * parenthesis, then a space.
 */
export function formattedCommitPrefix(prefix: string, scope?: "deps" | "deps-dev") {
  if (!prefix) return "";
  let out = scope ? `${prefix}(${scope})` : prefix;
  if (/[A-Za-z0-9)\]]$/.test(out)) out += ":";
  return out.endsWith(" ") ? out : `${out} `;
}

/** The headline after its prefix: lowercase after a lowercase prefix, as Dependabot's (S19 review B6). */
export function prefixedHeadline(prefix: string, title: string) {
  return /^[a-z]/.test(prefix.trim())
    ? `${prefix}${title.charAt(0).toLowerCase()}${title.slice(1)}`
    : `${prefix}${title}`;
}

/** The version a PR moves from: the locked one, or the declared range when none is locked (D-37). */
const fromOf = (i: { version: string | null; declaredRange?: string; resolvedBy?: string }) =>
  i.resolvedBy === "range-floor" && i.declaredRange ? i.declaredRange : (i.version ?? "?");

export function composeFixPullRequest(input: FixPullRequestInput): { title: string; body: string } {
  const { run, instance, repo, plan } = input;
  const codeFiles = run.files.filter((f) => !run.transactionFiles.includes(f.path));
  const advisories = input.records.filter(
    (r) => r.kind === "security-advisory" && r.applicability.fixedIn.length > 0,
  );
  // Advisories with no published fix: the upgrade doesn't fix them, and the PR says so.
  const unfixed = input.records.filter(
    (r) => r.kind === "security-advisory" && r.applicability.fixedIn.length === 0,
  );
  // A peer-only dependency isn't installed here: its range is widened, not moved (D-22).
  const peerOnly = instance.scope === "peer";
  // A library's range admits the new version beside the old (S18.5); a project in a subfolder says
  // where, as Dependabot's titles do (D-16).
  const widened = run.manifest.some((m) => m.note === "library range widened");
  const dir = instance.manifestPath.includes("/")
    ? ` in /${instance.manifestPath.slice(0, instance.manifestPath.lastIndexOf("/"))}`
    : "";
  const title = `${
    peerOnly
      ? `Allow ${instance.name} ${run.target} in the peer range${codeFiles.length ? " and adapt the code" : ""}`
      : widened
        ? `Widen the ${instance.name} range to admit ${run.target}${codeFiles.length ? " and adapt the code" : ""}`
        : advisories.length
          ? `Upgrade ${instance.name} from ${fromOf(instance)} to ${run.target} to fix ${advisories.length === 1 ? (advisories[0]?.id.split("/").at(-1) ?? "an advisory") : `${advisories.length} advisories`}`
          : `Upgrade ${instance.name} from ${fromOf(instance)} to ${run.target}${codeFiles.length ? " and adapt the code" : ""}`
  }${dir}`;
  const sections = (withDiff: boolean, siteCap: number, noteCap: number) => {
    const image = runFlowImage(input.runUrl);
    const out: string[] = [
      `<!-- teire:group=${input.groupKey} run=${input.runId} -->`,
      ...(image ? [image] : []),
      verdictLine(input),
    ];
    for (const pr of input.supersedes ?? [])
      out.push(
        `**Supersedes Dependabot's [#${pr.number}](${pr.url})** (${forGitHub(pr.title, 120)}). This PR makes the change verified against your code; Dependabot closes its own once the dependency is updated.`,
      );
    if (input.fallbackFrom)
      out.push(
        `**Why ${run.target}, not ${input.fallbackFrom.version}.** Teire tried ${input.fallbackFrom.version} first; the repo's checks still failed after the agent's attempts (${sanitizeUpstream(forGitHub(input.fallbackFrom.reason, 400), null)}), so this PR moves to the newest version of the previous major.`,
      );
    if (input.targetMax?.name === instance.name)
      out.push(`**Why ${run.target}.** ${sanitizeUpstream(forGitHub(input.targetMax.reason, 400), null)}.`);
    const widened = run.manifest.find((m) => m.note === "peer range widened");
    if (widened)
      out.push(
        `**Peer range widened.** \`${forGitHub(widened.from, 80)}\` → \`${forGitHub(widened.to, 100)}\`: projects on the versions it already supports keep them.`,
      );
    // D-37: no lockfile pins it, so the comparison started at its range's floor; said, never hidden.
    if (!peerOnly && instance.resolvedBy === "range-floor" && instance.declaredRange)
      out.push(
        `**No lockfile pins ${instance.name}.** Teire compared it from ${instance.version}, the lowest version \`${forGitHub(instance.declaredRange, 80)}\` allows: a fresh install could still get it.`,
      );

    // Why this repo
    const sites = input.summary.breaking.flatMap((f) => f.callSites.map((s) => ({ s, f })));
    out.push("### Why this repo");
    if (advisories.length) {
      out.push(
        `${instance.name} ${instance.version} is ${instance.direct ? "a direct dependency" : "locked as a dependency of your dependencies"} and is in the vulnerable range of:`,
      );
      for (const r of advisories)
        out.push(
          `- ${link(r.id.split("/").at(-1) ?? r.id, r.sources[0]?.url)} ${sanitizeUpstream(escapeCell(r.summary).slice(0, 240), upstreamRepoOf(r.sources[0]?.url))}${r.applicability.fixedIn.length ? ` Fixed in ${r.applicability.fixedIn.join(", ")}.` : ""}`,
        );
      if (!sites.length)
        out.push(
          "The advisories name no function to look for, so Teire cannot rule out that your code reaches the vulnerable path.",
        );
      if (unfixed.length)
        out.push(
          `Not fixed by this upgrade (no fixed version is published yet): ${unfixed.map((r) => link(r.id.split("/").at(-1) ?? r.id, r.sources[0]?.url)).join(", ")}.`,
        );
    }
    if (sites.length) {
      // A Go major's target already names its new module path ("…/jwt/v5 v5.3.1").
      const target = run.target.includes(" ") ? run.target : `${instance.name} ${run.target}`;
      const how =
        input.summary.coverage?.resolutionLevel === "type"
          ? "resolved by type, not by name"
          : "found by name, not by type; the sandbox decides";
      out.push(`${target} removes or changes APIs this repo calls (${how}):`);
      for (const { s, f } of sites.slice(0, siteCap))
        out.push(
          `- [\`${s.file}:${s.line}\`](${blob(repo, s.file, s.line)}) \`${escapeCell(s.snippet).slice(0, 120)}\` (${f.changeKind.replace(/-/g, " ")})`,
        );
      if (sites.length > siteCap) out.push(`- and ${sites.length - siteCap} more`);
    } else if (!advisories.length) {
      const c = input.summary.coverage;
      out.push(
        `No located use of a removed or changed API${c ? ` (${c.filesScanned} files, ${c.resolutionLevel}-resolved, ${c.unresolvedSites} unresolved)` : ""}. This is a plain upgrade${run.evidence.kind === "verified" ? ", verified in the sandbox" : "; Verification below says what the sandbox showed"}.`,
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
      .map((r) => changeSummary(r.title, instance.name));
    if (counts.length)
      out.push(`Comparing the public API of ${instance.version} and ${run.target}: ${counts.join("; ")}.`);
    for (const note of input.notes.slice(0, noteCap))
      out.push(
        `${blockquote(sanitizeUpstream(`${note.quote.slice(0, 400)}${note.quote.length > 400 ? "…" : ""}`, upstreamRepoOf(note.url)))}\n>\n> — ${link(urlLabel(note.url) ?? "release notes", note.url)}${note.declared ? " (from this repository's teire.yml)" : ""}`,
      );

    // The commits between the versions, as dependabot-core's updater listed them (D-13).
    if (run.upstream) {
      const { commits, more, compare } = run.upstream;
      if (commits.length) {
        out.push(`Commits between ${instance.version} and ${run.target}:`);
        out.push(
          commits
            .map(
              (c) => `- ${link(`\`${c.sha}\``, c.url)} ${sanitizeUpstream(c.message, upstreamRepoOf(c.url))}`,
            )
            .join("\n"),
        );
      }
      if (compare || more)
        out.push(
          `${more ? `and ${more} more; ` : ""}${compare ? link("compare the versions", compare) : ""}`.trim(),
        );
    }

    if (input.supplyChain?.length) {
      out.push("### Supply chain");
      out.push(input.supplyChain.map((s) => `- ${s}`).join("\n"));
    }

    // Changes
    out.push("### Changes");
    out.push("| File | Change |", "|---|---|");
    // A manifest edit to a file the agent then edited (Go's import rewrite) is one row, below.
    for (const m of run.manifest)
      if (!codeFiles.some((f) => f.path === m.path))
        out.push(`| \`${m.path}\` | ${m.note ?? `\`${m.from}\` → \`${m.to}\``} |`);
    if (run.lockfile)
      out.push(
        `| \`${run.lockfile.path}\` | regenerated by ${plan.manager}${plan.managerVersion ? ` ${plan.managerVersion}` : ""} (+${run.lockfile.added}/−${run.lockfile.removed} lines) |`,
      );
    for (const path of run.transactionFiles)
      if (path !== run.lockfile?.path && !run.manifest.some((m) => m.path === path))
        out.push(`| \`${path}\` | updated by ${plan.manager} |`);
    // Co-upgrades (D-10): what else the updater had to move for this version to resolve.
    if (run.moved.length) {
      out.push(
        "",
        "Moved with it, so the new version resolves:",
        "",
        "| Package | Version | Your code |",
        "|---|---|---|",
      );
      for (const m of run.moved.slice(0, 30))
        out.push(
          `| \`${m.name}\` | ${m.removed ? `\`${m.from ?? "?"}\` removed` : `\`${m.from ?? "new"}\` → \`${m.to ?? "?"}\``} | ${m.requested ? `asked for by the fix agent: ${sanitizeUpstream(forGitHub(m.requested, 200), null).replace(/\|/g, "/").replace(/\n/g, " ")}` : m.removed ? "" : usageCell(m.yourCode, m)} |`,
        );
      if (run.moved.length > 30) out.push(`| and ${run.moved.length - 30} more | | |`);
      // Coverage, said (D-10): how many moved packages were diffed and located, when not all were.
      const moves = run.moved.filter((m) => !m.removed && !m.requested && m.from !== m.to);
      const diffed = moves.filter((m) => m.yourCode?.diffed).length;
      if (moves.some((m) => m.yourCode && !m.yourCode.diffed))
        out.push(
          "",
          `Diffed and located: ${diffed} of ${moves.length} moved packages; the table says why the others weren't.`,
        );
    }

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
        `${sanitizeUpstream(r.summary, upstreamRepoOf(r.sources[0]?.url))}${r.sources[0]?.quote ? ` — "${sanitizeUpstream(r.sources[0].quote.slice(0, 200).replace(/\n/g, " "), upstreamRepoOf(r.sources[0].url))}" ([source](${r.sources[0].url}))` : ""}`,
      );
    if (run.evidence.kind !== "verified") risks.push(saidReasons(run.evidence.reasons));
    risks.push(...reviewRisks(run));
    risks.push(
      "Lint, end-to-end and integration suites were not run; dependencies were installed without lifecycle scripts.",
    );
    for (const r of risks) out.push(`- ${r}`);

    out.push("### Rollback");
    out.push(
      `Revert this pull request: every file listed under Changes returns to ${instance.name} ${instance.version}.`,
    );
    out.push("### Commands");
    out.push(
      `\`@teire rebase\` · \`@teire recreate\` · \`@teire explain\` · \`@teire ignore ${instance.name}\``,
    );
    out.push(footer(input.runUrl, run, [input.notesReceipt?.model]));
    return joinBlocks(foldSections(out));
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
  return { title, body: fitBody(sections(false, 1, 0), PULL_REQUESTS.bodyMaxChars, input.runUrl) };
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
        ? `**Draft: ${run.evidence.kind.replace(/_/g, " ")}.** ${what}. ${saidReasons(run.evidence.reasons)}.`
        : `**Needs a human.** ${what}. ${saidReasons(run.evidence.reasons)}.`;
  const sections = (withDiff: boolean, siteCap: number) => {
    const image = runFlowImage(input.runUrl);
    const out: string[] = [
      `<!-- teire:group=${input.groupKey} run=${input.runId} -->`,
      ...(image ? [image] : []),
      verdict,
    ];
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
        `${blockquote(sanitizeUpstream(escapeCell(displayQuote(note.quote)).slice(0, 400), upstreamRepoOf(note.url)))}\n>\n> — ${sanitizeUpstream(note.summary, upstreamRepoOf(note.url))}${safeUrl(note.url) ? ` (${link("source", note.url)})` : ""}`,
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
      ...(run.evidence.kind !== "verified" ? [saidReasons(run.evidence.reasons)] : []),
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
    return joinBlocks(foldSections(out));
  };
  for (const [diff, sites] of [
    [true, PULL_REQUESTS.maxSitesPerFinding],
    [false, PULL_REQUESTS.maxSitesPerFinding],
    [false, 3],
  ] as const) {
    const body = sections(diff, sites);
    if (body.length <= PULL_REQUESTS.bodyMaxChars) return { title, body };
  }
  return { title, body: fitBody(sections(false, 1), PULL_REQUESTS.bodyMaxChars, input.runUrl) };
}

export interface OnboardingRow {
  instance: DependencyInstance;
  /** The registry lookup failed: newer versions are unknown, never "up to date" (D-52). */
  lookupFailed?: boolean;
  target: string | null;
  majorsBehind: number;
  deprecated: string | null;
  verdict: DependencyVerdict["verdict"] | null;
  breakingSites: number;
  coverage: string | null;
}

/**
 * Default `.github/teire.yml` the onboarding PR adds (keys and defaults from card C8). One space before
 * each comment, as Biome and Prettier format YAML, so the PR passes the repository's own format check
 * (teire-dev/teire#1 failed on aligned comments).
 */
export const DEFAULT_CONFIG = `# yaml-language-server: $schema=https://teire.vercel.app/schema.json
# Teire configuration. Every key is optional; these are the defaults.
# Reference: https://teire.vercel.app/docs/config
upgrades:
  majors: true # open upgrade PRs across major versions
  plainBumps: true # open verified upgrades with no code change (last in the queue)
  cooldownDays: 7 # wait this long after a release before proposing it
schedule: daily # daily and on pushes that change dependencies or code; weekly, push (pushes only) or off
pullRequests:
  limit: 5 # open Teire PRs at most
  perHour: 2 # new Teire PRs per hour at most
dashboardIssue: true
`;

/** The folder holding a dependency's lockfile (or manifest when it has none): one project. */
function projectOf(r: OnboardingRow) {
  const file = r.instance.lockfilePath ?? r.instance.manifestPath;
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  return dir || ".";
}

export interface UpgradeGroup {
  ecosystem: string;
  name: string;
  target: string;
  from: string[];
  projects: string[];
  verdict: OnboardingRow["verdict"];
  breakingSites: number;
  coverage: string | null;
  majorsBehind: number;
}

const VERDICT_RANK: Record<string, number> = { affected: 3, inconclusive: 2, not_affected: 1 };

/**
 * One upgrade per package and target across every lockfile root (rule 9, D94): the PR Teire opens.
 * A group is "affected" when any root's code breaks; call sites add up across roots.
 */
export function upgradeGroups(direct: OnboardingRow[]): UpgradeGroup[] {
  const groups = new Map<string, UpgradeGroup>();
  for (const r of direct) {
    if (!r.target) continue;
    const key = `${r.instance.ecosystem}/${r.instance.name}/${r.target}`;
    const g = groups.get(key) ?? {
      ecosystem: r.instance.ecosystem,
      name: r.instance.name,
      target: r.target,
      from: [],
      projects: [],
      verdict: null,
      breakingSites: 0,
      coverage: null,
      majorsBehind: 0,
    };
    if (r.instance.version && !g.from.includes(r.instance.version)) g.from.push(r.instance.version);
    const project = projectOf(r);
    if (!g.projects.includes(project)) g.projects.push(project);
    if ((VERDICT_RANK[r.verdict ?? ""] ?? 0) > (VERDICT_RANK[g.verdict ?? ""] ?? 0)) {
      g.verdict = r.verdict;
      g.coverage = r.coverage;
    }
    g.breakingSites += r.breakingSites;
    g.majorsBehind = Math.max(g.majorsBehind, r.majorsBehind);
    groups.set(key, g);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.verdict === "affected") - Number(a.verdict === "affected") || b.majorsBehind - a.majorsBehind,
  );
}

export function composeOnboarding(input: {
  repo: RepoRef;
  rows: OnboardingRow[];
  /** Transitive packages the inventory read (rows hold only those with an advisory). */
  transitive?: number;
  /** Provider changes found in the code (retired models, removed endpoints). */
  apiFindings?: FindingDraft[];
  scanUrl?: string;
  /** What the scan could not check (D96), as plain lines. */
  gaps?: string[];
  /** False when the repo has Issues turned off: the Dashboard lives on the Teire dashboard instead. */
  issuesEnabled?: boolean;
  dashboardUrl?: string;
  /** The scan's flow image (`/og/repo-scan/<id>`): the body's first picture. */
  scanImageUrl?: string;
}) {
  const { rows } = input;
  const direct = rows.filter((r) => r.instance.direct);
  const ecosystems = [...new Set(rows.map((r) => r.instance.ecosystem))];
  const upgrades = upgradeGroups(direct);
  const affected = upgrades.filter((g) => g.verdict === "affected");
  const projects = new Set(direct.map(projectOf));
  const out: string[] = ["<!-- teire:onboarding -->"];
  if (input.scanImageUrl)
    out.push(
      flowImage(
        input.scanImageUrl,
        input.dashboardUrl ?? input.scanImageUrl,
        "What Teire found: what it read, what reaches the code and the upgrades it will open",
      ),
    );
  out.push(
    `**Teire is ready for \`${input.repo.owner}/${input.repo.repo}\`.** Merge this pull request to turn it on; it only adds \`.github/teire.yml\` with the defaults.`,
  );
  out.push("### What Teire found");
  out.push(
    rows.length
      ? `${direct.length} direct ${direct.length === 1 ? "dependency" : "dependencies"} (${input.transitive ?? rows.length - direct.length} transitive)${projects.size > 1 ? ` across ${projects.size} projects` : ""} in ${ecosystems.join(", ")}, at the exact versions your lockfiles pin. ${affected.length ? `${affected.length} upgrade${affected.length === 1 ? "" : "s"} would break this repo's code; Teire fixes and verifies ${affected.length === 1 ? "it" : "those"} before opening a PR.` : "No upgrade would break this repo's code."}`
      : "No packages in the ecosystems Teire upgrades (npm, PyPI, Go, Cargo, RubyGems, Maven/Gradle). What it found instead, and what it could not check, is below.",
  );
  if (upgrades.length) {
    out.push("### Upgrades Teire will open after you merge, in this order");
    out.push(
      "One pull request per package; Projects lists every folder that declares it.",
      "| Package | From → to | Projects | What it means here |",
      "|---|---|---|---|",
    );
    // A name two ecosystems share (`openai` on npm and PyPI) says which one each row is.
    const shared = (g: UpgradeGroup) =>
      upgrades.some((o) => o.name === g.name && o.ecosystem !== g.ecosystem);
    for (const g of upgrades.slice(0, 30))
      out.push(
        `| \`${g.name}\`${shared(g) ? ` (${g.ecosystem})` : ""} | ${g.from.join(", ")} → ${g.target} | ${g.projects.map((p) => `\`${p}\``).join(", ")} | ${
          g.verdict === "affected"
            ? `breaks ${g.breakingSites} call site${g.breakingSites === 1 ? "" : "s"}: Teire fixes them and checks the fix in a sandbox before its PR opens`
            : g.verdict === "not_affected"
              ? `not affected${g.coverage ? ` (${g.coverage})` : ""}: plain upgrade, checked in the sandbox before its PR opens`
              : g.verdict === "inconclusive"
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
      `<details><summary>${ECOSYSTEM_LABEL[eco] ?? eco}: ${list.length} direct</summary>\n\n| Package | Version | Scope | Project | Position |\n|---|---|---|---|---|`,
    );
    for (const r of list) {
      const chips = [
        r.instance.version === null
          ? r.instance.environment?.markers
            ? `not installed on Linux (\`${r.instance.environment.markers}\`)`
            : `unresolved${r.instance.unresolvedReason ? `: ${r.instance.unresolvedReason}` : ""}`
          : null,
        r.lookupFailed ? "registry lookup failed: newer versions unknown" : null,
        r.majorsBehind > 0
          ? `${r.majorsBehind} major${r.majorsBehind === 1 ? "" : "s"} behind`
          : r.target
            ? `${r.target} available`
            : null,
        r.deprecated !== null ? "deprecated" : null,
      ].filter(Boolean);
      out.push(
        `| \`${r.instance.name}\` | ${r.instance.version ?? "—"} | ${r.instance.scope} | \`${projectOf(r)}\` | ${chips.join(" · ") || "up to date"} |`,
      );
    }
    out.push("\n</details>");
  }
  if (input.gaps?.length) {
    out.push("### What Teire could not check");
    for (const g of input.gaps) out.push(`- ${g}`);
  }
  if (input.issuesEnabled === false)
    out.push(
      `> **Issues are turned off in this repository,** so Teire can't keep its Dashboard issue or open "needs a human" issues here. They live on ${input.dashboardUrl ? `the [Teire dashboard](${input.dashboardUrl})` : "the Teire dashboard"} instead; turn Issues on in Settings to get them in GitHub.`,
    );
  out.push("### How it works here");
  out.push(
    "Teire reads your lockfiles, compares each package's published API between your version and the target, finds the lines that use what changed, fixes them with NVIDIA Nemotron on Nebius Token Factory, and runs your own typecheck and tests before and after in a sandbox with the network off. A PR is ready only when that verification passes; otherwise it opens as a draft that says what is not covered.",
  );
  out.push("### Commands");
  out.push("`@teire rescan` · `@teire pause` · `@teire resume` · `@teire help`");
  out.push(`<sub>Teire${input.scanUrl ? ` · [scan](${input.scanUrl})` : ""}</sub>`);
  return {
    title: "Configure Teire",
    body: fitBody(joinBlocks(out), PULL_REQUESTS.bodyMaxChars, input.scanUrl),
  };
}

/**
 * A "needs a human" issue opened by a scan (rule 1, D96): a finding Teire can't fix on its own (no
 * fixed version published, an API surface it couldn't compare, a change with nothing to search
 * for). It says what changed, quoting the source, why a person is needed, where the code is, and what
 * to do next.
 */
export function composeHumanIssue(input: {
  repo: RepoRef;
  key: string;
  rows: {
    changeId: string;
    title: string | null;
    verdict: string;
    reason: string | null;
    callSites: { file: string; line: number; snippet?: string }[];
    /** The version this repo has and the one the change is about (S16.3). */
    position?: { version: string | null; target: string | null } | null;
    /** How far Teire's search could see (S16.3): a person reads the sites knowing what was missed. */
    coverage?: Coverage | null;
  }[];
  records: ChangeV2[];
  webUrl?: string | null;
}) {
  const { repo, rows } = input;
  const head = rows[0];
  const title = `Teire needs a human: ${(head?.title ?? input.key).slice(0, 180)}`;
  const out: string[] = [`<!-- teire:human=${input.key} -->`];
  // The change from the public catalog as the first picture: its source, the date, your code, the fix.
  const lead = input.records[0];
  if (lead && input.webUrl)
    out.push(
      flowImage(
        `${input.webUrl}/og/change/${lead.id}`,
        `${input.webUrl}/changes/${lead.id}`,
        `${lead.title}: from its source to your code`,
      ),
    );
  out.push("### Why a person is needed");
  for (const r of rows.slice(0, 6))
    out.push(`- **${r.title ?? r.changeId}**: ${r.reason ?? r.verdict.replace(/_/g, " ")}`);
  const sites = rows.flatMap((r) => r.callSites).slice(0, 12);
  if (sites.length) {
    out.push("### Where it is in this repo");
    for (const s of sites)
      out.push(
        `- [\`${s.file}:${s.line}\`](${blob(repo, s.file, s.line)})${s.snippet ? ` \`${escapeCell(s.snippet).slice(0, 100)}\`` : ""}`,
      );
  }
  const position = rows.find((r) => r.position?.version || r.position?.target)?.position;
  if (position)
    out.push(
      `**Your version:** ${position.version ? `\`${position.version}\`` : "unknown"}${position.target ? `; the change is about \`${position.target}\`` : ""}.`,
    );
  const coverage = rows.find((r) => r.coverage)?.coverage;
  if (coverage)
    out.push(
      `**How far Teire could see:** ${coverage.filesScanned} file${coverage.filesScanned === 1 ? "" : "s"} searched at ${coverage.resolutionLevel} level${coverage.unresolvedSites ? `, ${coverage.unresolvedSites} use${coverage.unresolvedSites === 1 ? "" : "s"} it couldn't resolve` : ""}${coverage.filesSkipped.length ? `, skipped: ${coverage.filesSkipped.map((f) => `${f.count} (${f.reason})`).join(", ")}` : ""}.`,
    );
  if (input.records.length) {
    out.push("### What changed upstream");
    for (const r of input.records.slice(0, 4)) {
      const source = r.sources[0];
      out.push(`**${r.title}**. ${sanitizeUpstream(r.summary.slice(0, 400), upstreamRepoOf(source?.url))}`);
      if (source?.quote)
        out.push(
          `${blockquote(sanitizeUpstream(displayQuote(source.quote).slice(0, 300), upstreamRepoOf(source.url)))}\n>\n> — ${link("source", source.url)}`,
        );
    }
  }
  out.push("### What you can do");
  // What a person does depends on what changed (S16.3): a parameter with no replacement, a behaviour
  // the checks can't see, a setting only the account can change.
  const kinds = new Set(input.records.map((r) => r.kind));
  if (kinds.has("parameter-change"))
    out.push(
      "- [ ] At each place above, stop passing the parameter the source says was removed; it names no replacement Teire could use, so the right value or call is yours to choose.",
    );
  if (kinds.has("behaviour-change"))
    out.push(
      "- [ ] Run the paths that reach the places above with real inputs, on your current version and on the new one.\n- [ ] Compare what comes back: output format, defaults, errors, timing.\n- [ ] Add a test that pins the behaviour you rely on, so the next upgrade is checked by your own suite.",
    );
  if (kinds.has("account-gated"))
    out.push(
      `- [ ] Change the setting the source names in the provider's dashboard or account (${input.records
        .filter((r) => r.kind === "account-gated")
        .map((r) => sanitizeUpstream(r.summary.slice(0, 160), upstreamRepoOf(r.sources[0]?.url)))
        .join("; ")}); then \`@teire fix ${input.key}\` runs again.`,
    );
  out.push(
    "- Read the source above and decide whether this repo is affected.\n- `@teire fix " +
      input.key +
      "` tries the upgrade anyway: it runs your checks before and after and opens a draft if they don't prove it.\n- `@teire ignore " +
      input.key +
      "` stops reporting it; `@teire wrong <reason>` tells us the finding is wrong.",
  );
  out.push(`<sub>Teire${input.webUrl ? ` · [dashboard](${input.webUrl})` : ""}</sub>`);
  return { title, body: fitBody(joinBlocks(out), PULL_REQUESTS.bodyMaxChars, input.webUrl ?? undefined) };
}
