import {
  and,
  artifacts,
  desc,
  eq,
  findings,
  installations,
  or,
  runs,
  type ScanUpgrade,
  scans,
  sql,
  systemState,
} from "@teire/db";
import { database } from "../db";
import { repoFixMode } from "../fix-mode";
import type { ReadableRepo } from "./viewer";

/**
 * "Why is there no PR?" (plan revision 3.3, U4): the gates a fix passes before Teire opens a pull
 * request, walked for one finding in the order the worker applies them (scan → fix mode → settings →
 * one PR per group → the run's outcome → the PR limit → the model budget). The first gate that
 * holds it is the answer; the rest are shown so a person sees what already passed.
 */
export interface Gate {
  gate: string;
  /** Passed, holding it, or only worth knowing. */
  state: "ok" | "holds" | "note";
  said: string;
  href?: string;
}

/**
 * A key naming the asked target as one of its segments: "anthropic" finds `models/anthropic`, "zod"
 * finds `npm/zod/4.1.0`, "npm/zod" finds `npm/zod/4.1.0`.
 */
export function keyHas(column: Parameters<typeof eq>[0], asked: string) {
  const t = asked.replace(/[%_\\]/g, "");
  return sql`(${column} = ${t} or ${column} like ${`${t}/%`} or ${column} like ${`%/${t}`} or ${column} like ${`%/${t}/%`})`;
}

const ISSUE_EVIDENCE = new Set(["regression", "unverified", "timeout", "pre_existing_failure"]);

export async function whyNoPr(repo: ReadableRepo, asked: string) {
  const db = database();
  const target = asked.trim();
  const base = `/app/repos/${repo.fullName}`;
  const [rows, [scan], [inst], [credits]] = await Promise.all([
    db
      .select()
      .from(findings)
      .where(
        and(
          eq(findings.repoId, repo.id),
          or(
            eq(findings.groupKey, target),
            eq(findings.changeId, target),
            eq(findings.dependencyKey, target),
            keyHas(findings.groupKey, target),
            keyHas(findings.dependencyKey, target),
          ),
        ),
      )
      .orderBy(findings.priority)
      .limit(20),
    db
      .select({ upgrades: scans.upgrades, coverage: scans.coverage, createdAt: scans.createdAt })
      .from(scans)
      .where(and(eq(scans.repoId, repo.id), eq(scans.status, "done")))
      .orderBy(desc(scans.createdAt))
      .limit(1),
    db
      .select({
        defaultFixMode: installations.defaultFixMode,
        securityFixMode: installations.securityFixMode,
      })
      .from(installations)
      .where(eq(installations.id, repo.installationId ?? 0))
      .limit(1),
    db.select().from(systemState).where(eq(systemState.key, "credits")).limit(1),
  ]);
  const upgrade = ((scan?.upgrades as ScanUpgrade[] | null) ?? []).find(
    (u) =>
      u.groupKey.split("/").includes(target) || u.groupKey === target || u.groupKey.startsWith(`${target}/`),
  );
  const finding = rows.find((f) => f.state === "open") ?? rows[0];
  const group = finding?.groupKey ?? upgrade?.groupKey ?? null;
  const gates: Gate[] = [];
  const hold = (gate: string, said: string, href?: string) =>
    gates.push({ gate, state: "holds", said, href });
  const ok = (gate: string, said: string, href?: string) => gates.push({ gate, state: "ok", said, href });
  const note = (gate: string, said: string, href?: string) => gates.push({ gate, state: "note", said, href });

  // 1. Teire on this repository.
  if (repo.status === "active") ok("Teire here", "Active: scans run and fixes can start");
  else if (repo.status === "onboarding")
    hold(
      "Teire here",
      "Still onboarding: fix PRs start once the onboarding PR is merged or you Activate it",
      "/welcome",
    );
  else if (repo.status === "paused")
    hold(
      "Teire here",
      `Paused${repo.pausedReason ? ` (${repo.pausedReason.replace(/_/g, " ")})` : ""}: no scans or fixes until resumed`,
      base,
    );
  else hold("Teire here", `The repository is ${repo.status}; its first scan hasn't finished`, base);

  // 2. What the latest scan found.
  if (!finding && !upgrade)
    hold("Finding", `The latest scan has no finding or upgrade matching "${target}"`, `${base}/findings`);
  else if (!finding && upgrade)
    ok(
      "Finding",
      `An upgrade with no breaking change found: ${upgrade.from ?? "?"} → ${upgrade.to}`,
      `${base}/inventory`,
    );
  else if (finding) {
    const sites = Array.isArray(finding.callSites) ? finding.callSites.length : 0;
    const href = `${base}/findings?group=${encodeURIComponent(finding.groupKey ?? finding.changeId)}`;
    if (finding.state === "ignored")
      hold("Finding", "Ignored: Teire won't fix it until it's unignored", href);
    else if (finding.state === "fixed") hold("Finding", "Already fixed on the default branch", href);
    else if (finding.state !== "open") hold("Finding", `No longer open (${finding.state})`, href);
    else if (finding.verdict === "affected")
      ok(
        "Finding",
        `Reaches your code${sites ? ` at ${sites} call site${sites === 1 ? "" : "s"}` : ""}`,
        href,
      );
    else if (finding.verdict === "not_affected")
      hold("Finding", "Checked: your code doesn't use what changed, so there is nothing to fix", href);
    else if (finding.verdict === "needs_human" || finding.verdict === "check_by_hand")
      hold("Finding", "Needs a person: Teire opens an issue with the steps instead of a PR", href);
    else if (finding.verdict === "inconclusive")
      note("Finding", "Not decided from the code alone; the upgrade's sandbox run decides", href);
    else
      hold("Finding", `Doesn't apply to the version you use (${finding.verdict.replace(/_/g, " ")})`, href);
  }

  // 3. Ignores, from `@teire ignore` and teire.yml.
  const config = (repo.config ?? {}) as {
    ignore?: string[];
    upgrades?: { majors?: boolean; plainBumps?: boolean };
    pullRequests?: { limit?: number };
  };
  const pkg = group?.split("/").slice(1, -1).join("/") ?? "";
  const ignored = [...(repo.ignores ?? []), ...(config.ignore ?? [])].find(
    (i) => i === group || i === finding?.changeId || (pkg && (i === pkg || group?.startsWith(`${i}/`))),
  );
  if (ignored) hold("Ignores", `Ignored by "${ignored}" (teire.yml or @teire ignore)`, `${base}/config`);

  // 4. Fix mode, from the file, the dashboard, the org file or the installation's default.
  const mode = repoFixMode(repo, inst ?? null);
  const origin = mode.file
    ? `set in ${mode.file}`
    : mode.origin === "dashboard"
      ? "set on the dashboard"
      : "the installation's default";
  if (mode.mode === "off")
    hold("Fix mode", `Off (${origin}): Teire lists it but never starts a fix`, `${base}/config`);
  else if (mode.mode === "ask" && !(upgrade?.security && mode.security.mode === "auto"))
    hold("Fix mode", `Ask first (${origin}): it waits for you. Fix now starts it`, `${base}/findings`);
  else
    ok(
      "Fix mode",
      `${mode.mode === "auto" ? "Automatic" : "Ask first, but security fixes start on their own"} (${origin})`,
    );

  // 5. Upgrade settings for a plain bump or a major.
  if (upgrade && !finding && config.upgrades?.plainBumps === false)
    hold(
      "Settings",
      "upgrades.plainBumps is off: upgrades with no breaking change don't get PRs",
      `${base}/config`,
    );
  if (
    upgrade &&
    config.upgrades?.majors === false &&
    /^\d+/.test(upgrade.to) &&
    upgrade.from &&
    upgrade.to.split(".")[0] !== upgrade.from.replace(/^[^\d]*/, "").split(".")[0]
  )
    hold("Settings", "upgrades.majors is off: major upgrades don't get PRs", `${base}/config`);

  // 6. One PR per group: open, closed by a person, or merged.
  const [pr] = group
    ? await db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.repoId, repo.id),
            eq(artifacts.changeKey, group),
            sql`${artifacts.kind} in ('pr', 'issue')`,
          ),
        )
        .orderBy(desc(artifacts.updatedAt))
        .limit(1)
    : [];
  if (pr?.kind === "pr" && pr.state === "open")
    ok("Pull request", `PR #${pr.number} is open for it`, pr.url ?? undefined);
  else if (pr?.kind === "pr" && pr.state === "closed")
    hold(
      "Pull request",
      `PR #${pr.number} was closed without merging, so Teire won't reopen this version; a newer one gets a new PR`,
      pr.url ?? undefined,
    );
  else if (pr?.kind === "pr" && pr.state === "merged")
    note("Pull request", `PR #${pr.number} was merged`, pr.url ?? undefined);
  else if (pr?.kind === "issue" && pr.state === "open")
    note(
      "Pull request",
      `Issue #${pr.number} is open instead: the evidence didn't support a PR`,
      pr.url ?? undefined,
    );

  // 7. The latest run for the group and how it ended.
  const [run] = group
    ? await db
        .select()
        .from(runs)
        .where(and(eq(runs.repoId, repo.id), eq(runs.groupKey, group), eq(runs.kind, "fix")))
        .orderBy(desc(runs.createdAt))
        .limit(1)
    : [];
  if (run) {
    const href = `/runs/${run.id}`;
    const settledLately = Date.now() - run.createdAt.getTime() < 7 * 86_400_000;
    if (run.status === "queued" || run.status === "running" || run.status === "stopping")
      ok("Run", `A run is ${run.status === "queued" ? "waiting for its turn" : "going now"}`, href);
    else if (
      run.evidenceKind &&
      ISSUE_EVIDENCE.has(run.evidenceKind) &&
      !(pr?.kind === "pr" && pr.state === "open")
    )
      hold(
        "Run",
        `The last run's evidence was "${run.evidenceKind.replace(/_/g, " ")}", so it opened an issue, not a PR. Open draft anyway is on the run page`,
        href,
      );
    else if (run.status === "failed" && run.error?.startsWith("stopped:"))
      hold("Run", `The last run stopped: ${run.error.slice(9, 220)}`, href);
    else if (run.status === "failed")
      hold(
        "Run",
        `The last run failed: ${(run.error ?? "no reason recorded").slice(0, 200)}. Retry from the run page`,
        href,
      );
    else if (run.status === "cancelled")
      hold(
        "Run",
        `The last run was cancelled${run.cancelledBy ? ` by @${run.cancelledBy}` : ""}${settledLately ? "; Teire won't start it again on its own this week" : ""}`,
        href,
      );
    else if (run.step === "nothing to change" || run.step === "no longer applies")
      hold("Run", `The last run found ${run.step}`, href);
    else if (run.step?.startsWith("fell back")) note("Run", `The last run ${run.step}`, href);
    else
      note(
        "Run",
        `The last run ${run.status}${run.evidenceKind ? ` (${run.evidenceKind.replace(/_/g, " ")})` : ""}`,
        href,
      );
  } else if (group && gates.every((g) => g.state !== "holds")) note("Run", "No run yet for this group");

  // 8. The open-PR limit (teire.yml pullRequests.limit, 5 by default).
  const limit = config.pullRequests?.limit ?? 5;
  const [open] = (
    await db.execute<{ n: number }>(sql`
      select count(*)::int as n from artifacts where repo_id = ${repo.id} and kind = 'pr' and state = 'open'`)
  ).rows;
  if (!(pr?.kind === "pr" && pr.state === "open")) {
    if ((open?.n ?? 0) >= limit)
      hold(
        "PR limit",
        `${open?.n} of ${limit} PRs are open; a new one waits until one closes or merges`,
        `${base}/prs`,
      );
    else ok("PR limit", `${open?.n ?? 0} of ${limit} PRs open`);
  }

  // 9. The model budget for fixes (the worker's own rule).
  const [spent] = (
    await db.execute<{ usd: string }>(sql`
      select coalesce(sum(cost_usd), 0) as usd from llm_calls where created_at > now() - interval '24 hours'`)
  ).rows;
  const cap = Number(process.env.TEIRE_DAILY_COST_CAP_USD ?? 10);
  if ((credits?.value as { exhausted?: boolean } | undefined)?.exhausted)
    hold("Model budget", "Token Factory credits are used up; runs resume when they're topped up");
  else if (cap > 0 && Number(spent?.usd ?? 0) >= cap)
    hold("Model budget", `Today's fix budget ($${cap.toFixed(2)}) is used up; runs resume as it frees`);
  else ok("Model budget", "Within today's budget");

  // 10. What the scan couldn't check (only worth knowing).
  const cov = (scan?.coverage ?? null) as { gaps?: string[]; resolutionLevel?: string } | null;
  if (cov?.resolutionLevel && cov.resolutionLevel !== "type")
    note("Coverage", `Call sites here are located by ${cov.resolutionLevel}, not types`);

  const first = gates.find((g) => g.state === "holds");
  const opened = pr?.kind === "pr" && pr.state === "open";
  return {
    repo: repo.fullName,
    group,
    title: finding?.changeId ?? upgrade?.groupKey ?? target,
    answer: opened
      ? `There is a PR: #${pr?.number}`
      : first
        ? first.said
        : run && (run.status === "queued" || run.status === "running")
          ? "A run is on it now"
          : "Nothing holds it: the next scan starts a run, or Fix now starts one today",
    gates,
    asOf: scan?.createdAt?.toISOString() ?? null,
    link: group ? `${base}/findings?group=${encodeURIComponent(group)}` : `${base}/findings`,
  };
}
