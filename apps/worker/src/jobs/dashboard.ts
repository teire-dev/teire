import { sql } from "@teire/db";
import { findingsWithChanges, getArtifact, getRepo, openArtifacts, upsertArtifact } from "../store";
import { HELP } from "./commands";
import type { WorkerContext } from "./scan";

/**
 * The Teire Dashboard issue (card C7, plan S09): one per repo, constant title, a hidden marker.
 * Upcoming deadlines · Affected ("Fix now") · Open PRs ("Rebase") · Needs a human · Not affected
 * and Not applicable (collapsed) · Ignored ("Unignore") · inventory per ecosystem · config problems
 * · command help. A ticked box arrives as `issues.edited`; the worker acts on the boxes that went
 * from [ ] to [x], re-renders the issue (ticks cleared) and replies with what it started.
 */
export const DASHBOARD_TITLE = "Teire Dashboard";
const MARKER = "<!-- teire:dashboard -->";

export type DashboardAction = { kind: "fix" | "rebase" | "unignore" | "rescan"; key: string };

const box = (kind: DashboardAction["kind"], key: string, label: string) =>
  `- [ ] <!-- teire:${kind}=${key} --> ${label}`;

/** Boxes ticked in `after` that were not ticked in `before`. */
export function tickedActions(before: string, after: string): DashboardAction[] {
  const ticked = (body: string) =>
    new Set(
      [...body.matchAll(/^\s*[-*] \[[xX]\] <!-- teire:(fix|rebase|unignore|rescan)=([^ ]*) -->/gm)].map(
        (m) => `${m[1]}=${m[2]}`,
      ),
    );
  const was = ticked(before);
  return [...ticked(after)]
    .filter((k) => !was.has(k))
    .map((k) => {
      const at = k.indexOf("=");
      return { kind: k.slice(0, at) as DashboardAction["kind"], key: k.slice(at + 1) };
    });
}

export interface DashboardInput {
  fullName: string;
  sha: string | null;
  scannedAt: Date | null;
  status: string;
  webUrl: string | null;
  findings: Awaited<ReturnType<typeof findingsWithChanges>>;
  artifacts: Awaited<ReturnType<typeof openArtifacts>>;
  inventory: { ecosystem: string; n: number }[];
  ignores: string[];
  configProblems: string[];
}

export function composeDashboard(d: DashboardInput) {
  const groups = new Map<string, DashboardInput["findings"]>();
  for (const f of d.findings) {
    const key = f.groupKey ?? f.changeId;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const prFor = new Map(d.artifacts.filter((a) => a.kind === "pr").map((a) => [a.changeKey, a]));
  const issueFor = new Map(d.artifacts.filter((a) => a.kind === "issue").map((a) => [a.changeKey, a]));
  const sites = (list: DashboardInput["findings"]) =>
    list.reduce((n, f) => n + ((f.callSites as unknown[]) ?? []).length, 0);
  const label = (key: string, list: DashboardInput["findings"]) => {
    const head = list[0];
    const title = head?.title ?? key;
    const n = sites(list);
    return `**${title}**${n ? ` — ${n} site${n === 1 ? "" : "s"}` : ""}${head?.priority != null ? ` · priority ${head.priority}` : ""}`;
  };
  const deadlines = d.findings
    .filter((f) => f.deadline && f.state === "open" && f.verdict !== "not_applicable")
    .sort((a, b) => (a.deadline as Date).getTime() - (b.deadline as Date).getTime());
  const open = [...groups].filter(([, list]) => list.some((f) => f.state === "open"));
  const affected = open.filter(
    ([k, list]) => list.some((f) => f.verdict === "affected") && !prFor.has(k) && !issueFor.has(k),
  );
  const notAffected = open.filter(([, list]) =>
    list.every((f) => f.verdict === "not_affected" || f.verdict === "inconclusive"),
  );
  const notApplicable = open.filter(([, list]) => list.every((f) => f.verdict === "not_applicable"));
  const ignored = [
    ...new Set([
      ...d.ignores,
      ...d.findings.filter((f) => f.state === "ignored").map((f) => f.groupKey ?? f.changeId),
    ]),
  ];
  const sha = d.sha ? `\`${d.sha.slice(0, 7)}\`` : "—";
  const lines = [
    MARKER,
    `Teire watches every dependency and API this repo uses. Last scan: ${sha}${d.scannedAt ? ` (${d.scannedAt.toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}${d.status === "paused" ? " · **paused** (`@teire resume`)" : ""}.${d.webUrl ? ` [Open in Teire](${d.webUrl})` : ""}`,
    "",
    box("rescan", "now", "Rescan now"),
    "",
  ];
  if (deadlines.length) {
    lines.push("## Upcoming deadlines", "", "| Change | Date | Status |", "|---|---|---|");
    for (const f of deadlines.slice(0, 15)) {
      const pr = f.groupKey ? prFor.get(f.groupKey) : undefined;
      lines.push(
        `| ${f.title ?? f.changeId} | ${(f.deadline as Date).toISOString().slice(0, 10)} | ${pr?.url ? `[PR #${pr.number}](${pr.url})` : f.verdict} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Affected", "");
  if (affected.length)
    for (const [k, list] of affected
      .sort((a, b) => (a[1][0]?.priority ?? 9) - (b[1][0]?.priority ?? 9))
      .slice(0, 40))
      lines.push(box("fix", k, `Fix now: ${label(k, list)}`));
  else lines.push("Nothing affected right now.");
  lines.push("");
  const prs = d.artifacts.filter((a) => a.kind === "pr");
  if (prs.length) {
    lines.push("## Open PRs", "");
    for (const a of prs)
      lines.push(box("rebase", a.changeKey, `Rebase [#${a.number}](${a.url}) \`${a.changeKey}\``));
    lines.push("");
  }
  const issues = d.artifacts.filter((a) => a.kind === "issue");
  if (issues.length) {
    lines.push("## Needs a human", "");
    for (const a of issues) lines.push(`- [#${a.number}](${a.url}) \`${a.changeKey}\``);
    lines.push("");
  }
  const collapsed = (title: string, rows: [string, DashboardInput["findings"]][]) => {
    if (!rows.length) return;
    lines.push(`<details><summary>${title} (${rows.length})</summary>`, "");
    for (const [k, list] of rows.slice(0, 60))
      lines.push(`- ${label(k, list)}${list[0]?.reason ? `: ${list[0].reason.slice(0, 160)}` : ""}`);
    lines.push("", "</details>", "");
  };
  collapsed("Not affected", notAffected);
  collapsed("Not applicable (installed version outside the change)", notApplicable);
  if (ignored.length) {
    lines.push("## Ignored", "");
    for (const k of ignored) lines.push(box("unignore", k, `Unignore \`${k}\``));
    lines.push("");
  }
  if (d.inventory.length)
    lines.push("## Inventory", "", d.inventory.map((i) => `${i.ecosystem}: ${i.n}`).join(" · "), "");
  if (d.configProblems.length)
    lines.push("## Config problems (defaults used)", "", ...d.configProblems.map((p) => `- ${p}`), "");
  lines.push("<details><summary>Commands</summary>", "", HELP, "", "</details>");
  return lines.join("\n");
}

/** Creates, updates or (when the config turns it off) closes the repo's Dashboard issue. */
export async function syncDashboard(ctx: WorkerContext, repoId: number) {
  const { db, gh } = ctx;
  const repo = await getRepo(db, repoId);
  if (!repo?.installationId) return null;
  const config = repo.config as { dashboardIssue?: boolean; problems?: string[] } | null;
  const [owner = "", name = ""] = repo.fullName.split("/");
  const { octokit } = await gh.installation(repo.installationId);
  const existing = await getArtifact(db, repoId, "dashboard");
  // The issue starts with the repository's first active scan; nothing before it creates one.
  if (!existing && repo.status !== "active") return null;
  if (config?.dashboardIssue === false) {
    if (existing?.number && existing.state === "open") {
      await octokit.rest.issues.update({ owner, repo: name, issue_number: existing.number, state: "closed" });
      await upsertArtifact(db, { ...existing, state: "closed" });
    }
    return null;
  }
  // Instances are stored per scan: the latest finished scan's, per ecosystem.
  const { rows: inventory } = await db.execute<{ ecosystem: string; n: number }>(sql`
    select ecosystem, count(distinct dependency_key)::int as n from dependency_instances
    where scan_id = (select id from scans where repo_id = ${repoId} and status = 'done' order by created_at desc limit 1)
    group by ecosystem order by ecosystem
  `);
  const body = composeDashboard({
    fullName: repo.fullName,
    sha: repo.lastScannedSha,
    scannedAt: repo.lastScannedAt,
    status: repo.status,
    webUrl: ctx.webUrl,
    findings: await findingsWithChanges(db, repoId),
    artifacts: (await openArtifacts(db, repoId)).filter((a) => a.kind === "pr" || a.kind === "issue"),
    inventory: inventory.map((i) => ({ ecosystem: i.ecosystem, n: Number(i.n) })),
    ignores: (repo.ignores as string[] | null) ?? [],
    configProblems: config?.problems ?? [],
  });
  if (existing?.number && existing.state === "open") {
    await octokit.rest.issues.update({ owner, repo: name, issue_number: existing.number, body });
    return existing.number;
  }
  const { data } = await octokit.rest.issues.create({
    owner,
    repo: name,
    title: DASHBOARD_TITLE,
    body,
    labels: ["teire"],
  });
  await upsertArtifact(db, {
    repoId,
    kind: "dashboard",
    changeKey: "",
    number: data.number,
    state: "open",
    url: data.html_url,
  });
  return data.number;
}
