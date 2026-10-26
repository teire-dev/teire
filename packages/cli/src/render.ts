import { isAbsolute, relative } from "node:path";

/** A site's file as the repository names it: locators give paths relative to the root, some absolute. */
function shownPath(root: string, file: string) {
  return isAbsolute(file) ? relative(root, file) || file : file;
}

import { styleText } from "node:util";
import { type ChangeV2, PR_OPENING_KINDS } from "@teire/engine/contract";
import { displayQuote } from "@teire/engine/github";
import type { FindingDraft } from "@teire/engine/impact";
import type { ScanResult } from "./scan";

/**
 * The scan as the Dashboard issue lays it out (card C7): upcoming deadlines, affected (by PR
 * priority), needs a human, then not affected and not applicable as counts. Findings group by PR
 * (`groupKey`) exactly as the dashboard groups them.
 */
type Style = Parameters<typeof styleText>[0];
const paint = (style: Style, text: string) => styleText(style, text, { stream: process.stdout });

export interface Group {
  key: string;
  title: string;
  verdict: FindingDraft["verdict"];
  priority: number | null;
  deadline: string | null;
  findings: FindingDraft[];
}

const RANK: Record<FindingDraft["verdict"], number> = {
  affected: 0,
  needs_human: 1,
  check_by_hand: 2,
  inconclusive: 3,
  not_affected: 4,
  not_applicable: 5,
};

export function groupFindings(scan: Pick<ScanResult, "findings" | "records">): Group[] {
  const groups = new Map<string, FindingDraft[]>();
  for (const f of scan.findings) {
    const key = f.groupKey ?? f.changeId;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const deadlineOf = (f: FindingDraft) => scan.records.get(f.changeId)?.applicability.effectiveOn ?? null;
  return [...groups].map(([key, list]) => {
    // As the dashboard does: within one verdict, a change that opens a PR leads, then the most urgent,
    // then the soonest date, so the group's title and deadline name the same change.
    const sorted = [...list].sort(
      (a, b) =>
        RANK[a.verdict] - RANK[b.verdict] ||
        Number(PR_OPENING_KINDS.has(b.changeKind)) - Number(PR_OPENING_KINDS.has(a.changeKind)) ||
        (a.priority ?? 9) - (b.priority ?? 9) ||
        (deadlineOf(a) ?? "9999").localeCompare(deadlineOf(b) ?? "9999"),
    );
    const head = sorted[0] as FindingDraft;
    const lead = sorted.filter((f) => f.verdict === head.verdict);
    const leadIds = [...new Set(lead.map((f) => f.changeId))];
    const priorities = lead.map((f) => f.priority).filter((p): p is number => p !== null);
    const record = scan.records.get(head.changeId);
    return {
      key,
      title: `${record?.title ?? head.changeId}${leadIds.length > 1 ? ` and ${leadIds.length - 1} more` : ""}`,
      verdict: head.verdict,
      priority: priorities.length ? Math.min(...priorities) : null,
      deadline: deadlineOf(head),
      findings: sorted,
    };
  });
}

/** Test, fixture and example files go last: the call sites a reader acts on are in the product's code. */
const SECONDARY =
  /(^|\/)(tests?|__tests__|spec|fixtures?|examples?|docs?|e2e|benchmarks?|testdata)\/|(^|\/)test_[^/]*$|[._-](test|spec)\.[a-z]+$/i;

export function sitesOf(group: Group, root: string, limit: number) {
  const seen = new Map<string, { site: string; snippet: string; secondary: boolean }>();
  // The lead verdict's sites, as the dashboard shows them.
  for (const f of group.findings.filter((x) => x.verdict === group.verdict))
    for (const s of f.callSites) {
      if (s.kind === "docs") continue;
      const file = shownPath(root, s.file);
      const site = `${file}:${s.line}`;
      if (!seen.has(site))
        seen.set(site, { site, snippet: s.snippet?.trim() ?? "", secondary: SECONDARY.test(file) });
    }
  const all = [...seen.values()].sort((a, b) => Number(a.secondary) - Number(b.secondary));
  return { shown: all.slice(0, limit), more: Math.max(0, all.length - limit), total: all.length };
}

export function renderScan(scan: ScanResult, options: { all?: boolean } = {}) {
  const out: string[] = [];
  const groups = groupFindings(scan);
  const inv = [
    ...scan.ecosystems.map(
      (e) => `${e.name} ${e.direct} direct${e.transitive ? ` + ${e.transitive} transitive` : ""}`,
    ),
    ...scan.skipped.map((name) => `${name} not scanned`),
  ].join(" · ");
  out.push(
    `${paint("bold", "Teire")} ${scan.label}`,
    paint(
      "dim",
      `${inv || "no manifests found"} · ${scan.filesScanned} files · ${(scan.ms / 1000).toFixed(1)} s`,
    ),
  );
  if (scan.providers.length) out.push(paint("dim", `APIs: ${scan.providers.join(", ")}`));
  out.push("");
  if (!scan.ecosystems.length && !scan.skipped.length && !scan.findings.length) {
    out.push(
      "No project found here: no package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml,",
      "Gemfile, pom.xml or build.gradle, and no model IDs or API URLs in the code.",
      "",
      `Run it inside a project, or scan a public GitHub repository: ${paint("bold", "npx teire-cli scan owner/name")}`,
      "",
    );
    if (scan.notes.length) {
      out.push(paint("bold", "Notes"));
      for (const n of scan.notes) out.push(paint("dim", `  ${n}`));
      out.push("");
    }
    return out.join("\n");
  }

  const live = groups.filter((g) => g.verdict !== "not_applicable");
  const deadlines = live
    .filter((g) => g.deadline)
    .sort((a, b) => (a.deadline as string).localeCompare(b.deadline as string));
  if (deadlines.length) {
    out.push(paint("bold", "Deadlines"));
    const today = new Date().toISOString().slice(0, 10);
    for (const g of deadlines.slice(0, 15)) {
      const day = (g.deadline as string).slice(0, 10);
      const state = `${day < today ? "passed · " : ""}${g.verdict.replace("_", " ")}`;
      out.push(`  ${day}  ${g.title}  ${paint("dim", state)}`);
    }
    out.push("");
  }
  const section = (title: string, color: "red" | "yellow" | "green" | "gray", list: Group[]) => {
    if (!list.length) return;
    out.push(paint(["bold", color], `${title} (${list.length})`));
    for (const g of list) {
      const sites = sitesOf(g, scan.root, 4);
      const meta = [
        g.priority !== null ? `priority ${g.priority}` : "",
        sites.total ? `${sites.total} site${sites.total === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      out.push(`  ${paint(color, "●")} ${g.title}${meta ? paint("dim", `  ${meta}`) : ""}`);
      out.push(paint("dim", `    ${g.key}`));
      for (const s of sites.shown) out.push(`    ${s.site}`);
      if (sites.more) out.push(paint("dim", `    … ${sites.more} more`));
      const reason = g.findings.find((f) => f.verdict === g.verdict)?.reason;
      if (reason && g.verdict !== "affected") out.push(paint("dim", `    ${reason.slice(0, 200)}`));
    }
    out.push("");
  };
  section(
    "Affected",
    "red",
    live.filter((g) => g.verdict === "affected").sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9)),
  );
  section(
    "Needs a human",
    "yellow",
    live.filter((g) => g.verdict === "needs_human" || g.verdict === "check_by_hand"),
  );
  const quiet = live.filter((g) => g.verdict === "not_affected" || g.verdict === "inconclusive");
  const outside = groups.filter((g) => g.verdict === "not_applicable");
  if (options.all) {
    section("Not affected", "green", quiet);
    section("Not applicable (installed version outside the change)", "gray", outside);
  } else if (quiet.length || outside.length) {
    out.push(
      paint(
        "dim",
        `${quiet.length} more change${quiet.length === 1 ? "" : "s"} checked, none reaching your code${outside.length ? `; ${outside.length} outside your installed versions` : ""} (--all lists them)`,
      ),
      "",
    );
  }
  if (!live.some((g) => g.verdict === "affected"))
    out.push(
      paint(
        "green",
        scan.skipped.length || scan.notes.some((n) => n.includes("direct packages were not compared"))
          ? "Nothing affected in what could be checked; the notes say what could not."
          : "Nothing affected right now.",
      ),
      "",
    );
  if (scan.notes.length) {
    out.push(paint("bold", "Notes"));
    for (const n of scan.notes) out.push(paint("dim", `  ${n}`));
    out.push("");
  }
  return out.join("\n");
}

export function scanJson(scan: ScanResult) {
  return {
    root: scan.label,
    ecosystems: scan.ecosystems,
    skipped: scan.skipped,
    providers: scan.providers,
    groups: groupFindings(scan).map((g) => ({
      ...g,
      findings: g.findings.map((f) => ({
        ...f,
        callSites: f.callSites.map((s) => ({ ...s, file: shownPath(scan.root, s.file) })),
      })),
    })),
    changes: Object.fromEntries(scan.records),
    notes: scan.notes,
    filesScanned: scan.filesScanned,
    ms: scan.ms,
  };
}

export function renderChange(r: ChangeV2) {
  const a = r.applicability;
  const subject = [r.subject.ecosystem, r.subject.provider, r.subject.name].filter(Boolean).join(" · ");
  const out = [
    paint("bold", r.title),
    paint("dim", `${r.id}`),
    paint("dim", `${r.kind} · ${a.class} · ${subject} · ${r.status}`),
    "",
    r.summary,
    "",
  ];
  const span = [
    a.fromVersion && `from ${a.fromVersion}`,
    a.toVersion && `to ${a.toVersion}`,
    a.effectiveOn && `on ${a.effectiveOn.slice(0, 10)}`,
  ]
    .filter(Boolean)
    .join(", ");
  if (span) out.push(`Applies ${span}`);
  if (a.fixedIn?.length) out.push(`Fixed in ${a.fixedIn.join(", ")}`);
  if (r.replacement)
    out.push(`Use instead: ${r.replacement.value}${r.replacement.note ? ` (${r.replacement.note})` : ""}`);
  if (r.migrationNotes.length) {
    out.push("", paint("bold", "Migration"));
    for (const n of r.migrationNotes) out.push(`  - ${n.text}`);
  }
  out.push("", paint("bold", "Sources"));
  for (const s of r.sources) {
    out.push(`  ${s.url} ${paint("dim", `(${s.kind}, ${s.trustBasis})`)}`);
    if (s.quote) out.push(paint("dim", `    “${displayQuote(s.quote).slice(0, 400)}”`));
  }
  return out.join("\n");
}

/**
 * What an agent reads (MCP): the report's shape without the bulk. Groups that need action carry
 * their first call sites; the rest are counted. `explain_finding` holds the detail.
 */
export function scanSummary(scan: ScanResult) {
  const groups = groupFindings(scan);
  const brief = (g: Group) => {
    const sites = sitesOf(g, scan.root, 8);
    // The version the PR would move to, or the model the provider names instead.
    const target = g.findings.find((f) => f.verdict === g.verdict)?.position.target;
    return {
      key: g.key,
      title: g.title,
      verdict: g.verdict,
      priority: g.priority,
      deadline: g.deadline?.slice(0, 10) ?? null,
      ...(target ? { target } : {}),
      ...(sites.total ? { sites: sites.shown.map((s) => s.site) } : {}),
      ...(sites.more ? { moreSites: sites.more } : {}),
      ...(g.verdict === "affected"
        ? {}
        : { reason: g.findings.find((f) => f.verdict === g.verdict)?.reason }),
    };
  };
  const live = groups.filter((g) => g.verdict !== "not_applicable");
  return {
    root: scan.label,
    ecosystems: scan.ecosystems,
    ...(scan.skipped.length ? { notScanned: scan.skipped } : {}),
    providers: scan.providers,
    affected: live
      .filter((g) => g.verdict === "affected")
      .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))
      .map(brief),
    needsHuman: live.filter((g) => g.verdict === "needs_human" || g.verdict === "check_by_hand").map(brief),
    notAffected: live.filter((g) => g.verdict === "not_affected" || g.verdict === "inconclusive").length,
    notApplicable: groups.length - live.length,
    notes: scan.notes,
    next: "explain_finding with a group key gives its change records, migration notes, quoted sources and every call site.",
  };
}

/** One group in full for an agent: trimmed change records and up to `limit` call sites with their code. */
export function groupDetail(scan: ScanResult, group: Group, limit = 50) {
  const sites = sitesOf(group, scan.root, limit);
  const ids = [...new Set(group.findings.map((f) => f.changeId))];
  return {
    key: group.key,
    title: group.title,
    verdict: group.verdict,
    priority: group.priority,
    deadline: group.deadline?.slice(0, 10) ?? null,
    findings: group.findings.map((f) => ({
      changeId: f.changeId,
      verdict: f.verdict,
      reason: f.reason,
      sites: f.callSites.length,
    })),
    changes: ids
      .map((id) => scan.records.get(id))
      .filter((r): r is ChangeV2 => Boolean(r))
      .slice(0, 25)
      .map((r) => ({
        id: r.id,
        title: r.title,
        kind: r.kind,
        class: r.applicability.class,
        summary: r.summary,
        ...(r.applicability.effectiveOn ? { effectiveOn: r.applicability.effectiveOn.slice(0, 10) } : {}),
        ...(r.applicability.fixedIn.length ? { fixedIn: r.applicability.fixedIn } : {}),
        ...(r.replacement ? { replacement: r.replacement.value } : {}),
        ...(r.migrationNotes.length ? { migrationNotes: r.migrationNotes.map((n) => n.text) } : {}),
        sources: r.sources.map((s) => ({
          url: s.url,
          ...(s.quote ? { quote: displayQuote(s.quote).slice(0, 300) } : {}),
        })),
      })),
    ...(ids.length > 25 ? { moreChanges: ids.length - 25 } : {}),
    sites: sites.shown.map((s) => ({ site: s.site, code: s.snippet.slice(0, 160) })),
    ...(sites.more ? { moreSites: sites.more } : {}),
  };
}
