import { relative } from "node:path";
import { styleText } from "node:util";
import type { ChangeV2 } from "@teire/engine/contract";
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
  return [...groups].map(([key, list]) => {
    const head = [...list].sort((a, b) => RANK[a.verdict] - RANK[b.verdict])[0] as FindingDraft;
    const record = scan.records.get(head.changeId);
    const dates = list
      .map((f) => scan.records.get(f.changeId)?.applicability.effectiveOn)
      .filter((d): d is string => Boolean(d))
      .sort();
    return {
      key,
      title: record?.title ?? head.changeId,
      verdict: head.verdict,
      priority: list.reduce<number | null>(
        (p, f) => (f.priority === null ? p : p === null ? f.priority : Math.min(p, f.priority)),
        null,
      ),
      deadline: dates[0] ?? null,
      findings: list,
    };
  });
}

function sitesOf(group: Group, root: string, limit: number) {
  const seen = new Set<string>();
  for (const f of group.findings)
    for (const s of f.callSites) {
      if (s.kind === "docs") continue;
      seen.add(`${relative(root, s.file) || s.file}:${s.line}`);
    }
  const all = [...seen];
  return { shown: all.slice(0, limit), more: Math.max(0, all.length - limit), total: all.length };
}

export function renderScan(scan: ScanResult, options: { all?: boolean } = {}) {
  const out: string[] = [];
  const groups = groupFindings(scan);
  const inv = scan.ecosystems
    .map((e) => `${e.name} ${e.direct} direct${e.transitive ? ` + ${e.transitive} transitive` : ""}`)
    .join(" · ");
  out.push(
    `${paint("bold", "Teire")} ${scan.root}`,
    paint(
      "dim",
      `${inv || "no manifests found"} · ${scan.filesScanned} files · ${(scan.ms / 1000).toFixed(1)} s`,
    ),
  );
  if (scan.providers.length) out.push(paint("dim", `APIs: ${scan.providers.join(", ")}`));
  out.push("");

  const live = groups.filter((g) => g.verdict !== "not_applicable");
  const deadlines = live
    .filter((g) => g.deadline)
    .sort((a, b) => (a.deadline as string).localeCompare(b.deadline as string));
  if (deadlines.length) {
    out.push(paint("bold", "Upcoming deadlines"));
    for (const g of deadlines.slice(0, 15))
      out.push(
        `  ${(g.deadline as string).slice(0, 10)}  ${g.title}  ${paint("dim", g.verdict.replace("_", " "))}`,
      );
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
      for (const s of sites.shown) out.push(`    ${s}`);
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
        `${quiet.length} more change${quiet.length === 1 ? "" : "s"} checked, none reaching your code; ${outside.length} outside your installed versions (--all lists them)`,
      ),
      "",
    );
  }
  if (!live.some((g) => g.verdict === "affected"))
    out.push(paint("green", "Nothing affected right now."), "");
  if (scan.notes.length) {
    out.push(paint("bold", "Notes"));
    for (const n of scan.notes) out.push(paint("dim", `  ${n}`));
    out.push("");
  }
  return out.join("\n");
}

export function scanJson(scan: ScanResult) {
  return {
    root: scan.root,
    ecosystems: scan.ecosystems,
    providers: scan.providers,
    groups: groupFindings(scan).map((g) => ({
      ...g,
      findings: g.findings.map((f) => ({
        ...f,
        callSites: f.callSites.map((s) => ({ ...s, file: relative(scan.root, s.file) || s.file })),
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
    if (s.quote) out.push(paint("dim", `    “${s.quote.slice(0, 400)}”`));
  }
  return out.join("\n");
}
