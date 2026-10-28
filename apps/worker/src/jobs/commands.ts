import { rm } from "node:fs/promises";
import {
  describeConfig,
  describeFixMode,
  type EffectiveFixMode,
  matchesTarget,
  personMayStart,
  readTeireConfig,
} from "@teire/engine/config";
import { lineageKey } from "@teire/engine/contract";
import { directoryTree, fetchRepoTarball } from "@teire/engine/inventory";
import {
  appendEvent,
  artifactByNumber,
  claimRun,
  findingsWithChanges,
  fixInFlight,
  fixModeOf,
  getArtifact,
  getRepo,
  recordAction,
  recordFeedback,
  setFindingsState,
  setIgnore,
  setRepo,
} from "../store";
import type { EventContext } from "./events";

export { matchesTarget };

/**
 * `@teire` commands (card C7, plan S09) in comments on any issue or PR of an installed repo:
 * rescan · fix <id> · ignore <id|package|provider> · unignore <id> · rebase · recreate · explain ·
 * config · pause · resume · pause-fixes · resume-fixes · wrong <reason> · help. Receipt is acknowledged with 👀; the answer is a
 * reply. Bots are ignored; people without write access get a note and nothing runs.
 */
export const HELP = [
  "**Teire commands** (comment on any issue or PR in this repo):",
  "",
  "| Command | What it does |",
  "|---|---|",
  "| `@teire rescan` | Scan the default branch again |",
  "| `@teire fix <change or package>` | Start a fix run now (also: tick “Fix now” in the Dashboard issue) |",
  "| `@teire ignore <change, package or provider:name>` | Stop reporting it; closes its open PR |",
  "| `@teire unignore <change, package or provider:name>` | Report it again |",
  "| `@teire ignore <package> major\\|minor\\|patch` | Skip that kind of update for the package (on a Teire PR: `@teire ignore major`); newer minors or patches still come |",
  "| `@teire show ignores` | What this repo ignores, from teire.yml and from commands |",
  "| `@teire rebase` | On a Teire PR: re-apply on the current base and verify again |",
  "| `@teire recreate` | On a Teire PR (even closed): run the fix again from scratch |",
  "| `@teire explain` | On a Teire PR or issue: the evidence behind it |",
  "| `@teire config` | The resolved config, with where each value came from |",
  "| `@teire pause` / `@teire resume` | Stop or restart scans and PRs for this repo |",
  "| `@teire fix-mode automatic\\|ask\\|off\\|default` | How Teire fixes here: on its own, only when asked, or not at all (`default` follows the installation) |",
  "| `@teire pause-fixes` / `@teire resume-fixes` | Fix mode Off, or back to the installation's default |",
  "| `@teire wrong <reason>` | Tell us a finding is a false positive or negative |",
  "| `@teire help` | This list |",
].join("\n");

export const COMMANDS = [
  "rescan",
  "fix",
  "ignore",
  "unignore",
  "rebase",
  "recreate",
  "explain",
  "config",
  "pause",
  "resume",
  "pause-fixes",
  "fix-mode",
  "resume-fixes",
  "wrong",
  "show",
  "help",
] as const;
export type CommandName = (typeof COMMANDS)[number];

/** The first `@teire <command> …` (or `@<app-slug>`) line in a comment; unknown names → help. */
export function parseCommand(
  body: string,
  slug: string,
): { name: CommandName; args: string; known: boolean } | null {
  const mention = new RegExp(
    // The slug first: `@teire-bot-dev` must not match as `@teire` followed by "-bot-dev".
    `^\\s*@(?:${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|teire)(?:\\[bot\\])?(?=\\s|$)[ \\t]*(\\S*)[ \\t]*(.*)$`,
    "im",
  );
  const m = mention.exec(body);
  if (!m) return null;
  const word = (m[1] ?? "").toLowerCase();
  const known = (COMMANDS as readonly string[]).includes(word);
  return { name: known ? (word as CommandName) : "help", args: (m[2] ?? "").trim(), known };
}

// biome-ignore lint/suspicious/noExplicitAny: GitHub webhook JSON, read field by field
type Payload = Record<string, any>;

export async function handleComment(ctx: EventContext, p: Payload) {
  const { db, gh } = ctx;
  const comment = p.comment;
  if (!comment || comment.user?.type === "Bot") return;
  const command = parseCommand(String(comment.body ?? ""), gh.slug);
  if (!command) return;
  const repo = await getRepo(db, p.repository.id);
  if (!repo?.installationId) return;
  const [owner = "", name = ""] = repo.fullName.split("/");
  const { octokit } = await gh.installation(repo.installationId);
  const issueNumber: number = p.issue.number;
  // Every command is written to the repository's Activity with Teire's answer (source `comment`): the
  // first reply is the outcome; a refusal ("…first", "Usage", "need write access") is said as one.
  let recorded = false;
  const reply = async (body: string) => {
    const sent = await octokit.rest.issues.createComment({
      owner,
      repo: name,
      issue_number: issueNumber,
      body,
    });
    if (!recorded) {
      recorded = true;
      const refusal =
        /need write access|first\.|^Usage|^I don't know|^No finding|^Fixes are|isn't|works on a Teire PR/.test(
          body,
        );
      await recordAction(db, {
        requester: `github:${comment.user.login}`,
        installationId: repo.installationId,
        repoId: repo.id,
        kind: command.name,
        params: command.args ? { args: command.args.slice(0, 300) } : {},
        source: "comment",
        status: refusal ? "refused" : "done",
        result: body.split("\n")[0]?.slice(0, 300) ?? "",
        links: [{ label: "Comment", href: sent.data.html_url }],
      }).catch(() => undefined);
    }
    return sent;
  };
  await octokit.rest.reactions
    .createForIssueComment({ owner, repo: name, comment_id: comment.id, content: "eyes" })
    .catch(() => undefined);

  if (!(await canWrite(octokit, owner, name, comment.user.login))) {
    await reply(
      `@${comment.user.login} Teire commands need write access to this repository, so nothing was run.`,
    );
    return;
  }
  const artifact = await artifactByNumber(db, repo.id, issueNumber);
  const by = comment.user.login as string;

  switch (command.name) {
    case "help":
      await reply(
        command.known
          ? HELP
          : `I don't know \`${String(comment.body).trim().split(/\s+/)[1] ?? ""}\`.\n\n${HELP}`,
      );
      return;
    case "rescan":
      if (repo.status === "paused") return void (await reply("This repo is paused; `@teire resume` first."));
      await ctx.enqueueScan(repo.id, "command");
      await reply(
        `Rescanning the default branch; ${repo.status === "active" ? "the Dashboard issue" : "the onboarding pull request"} updates when it finishes.`,
      );
      return;
    case "pause":
      if (repo.status !== "paused") await setRepo(db, repo.id, { status: "paused", pausedFrom: repo.status });
      await reply("Paused: no scans or PRs until `@teire resume`.");
      return;
    case "resume":
      if (repo.status === "paused")
        await setRepo(db, repo.id, {
          status: repo.pausedFrom ?? "active",
          pausedFrom: null,
          pausedReason: null,
        });
      await ctx.enqueueScan(repo.id, "command");
      await reply("Resumed; rescanning now.");
      return;
    case "pause-fixes":
    case "resume-fixes":
    case "fix-mode": {
      // D118, D124: one column, `fix_mode` (null follows the installation); a teire.yml `fixes:` wins.
      const word = command.name === "fix-mode" ? (command.args.trim().split(/\s+/)[0] ?? "") : "";
      const next =
        command.name === "pause-fixes"
          ? "off"
          : command.name === "resume-fixes" || word === "default"
            ? null
            : ({ automatic: "auto", auto: "auto", ask: "ask", "ask-first": "ask", off: "off" } as const)[
                word as "automatic"
              ];
      if (command.name === "fix-mode" && next === undefined)
        return void (await reply("Usage: `@teire fix-mode automatic|ask|off|default`"));
      await setRepo(db, repo.id, { fixMode: next ?? null });
      const mode = await fixModeOf(db, { ...repo, fixMode: next ?? null });
      const held = mode.origin === "repo-file" || mode.origin === "org-file";
      await reply(
        `Fixes here: **${describeFixMode(mode)}**.${held ? ` The file decides; change \`fixes:\` in ${mode.file} to change it.` : ""}${mode.mode === "ask" ? " Teire lists what it finds and starts a fix when someone asks (Fix now, `@teire fix`)." : mode.mode === "off" ? " Teire keeps scanning and reporting, and starts no fix runs." : ""}`,
      );
      if (mode.mode !== "off" && command.name !== "pause-fixes") await ctx.enqueueScan(repo.id, "command");
      return;
    }
    case "show": {
      if (!/^ignores\b/.test(command.args.trim())) return void (await reply("Usage: `@teire show ignores`"));
      // The config as the last scan resolved it; the command-made entries are listed apart.
      const fromCommands = (repo.ignores as string[] | null) ?? [];
      const fromConfig = ((repo.config as { ignore?: string[] } | null)?.ignore ?? []).filter(
        (i) => !fromCommands.includes(i),
      );
      const list = (items: string[]) => (items.length ? items.map((i) => `- \`${i}\``).join("\n") : "- none");
      return void (await reply(
        `**From teire.yml**\n${list(fromConfig)}\n\n**From \`@teire ignore\`**\n${list(fromCommands)}`,
      ));
    }
    case "ignore":
    case "unignore": {
      const words = command.args.split(/\s+/).filter(Boolean);
      const type = words.find((w) => /^(major|minor|patch)$/.test(w));
      let target = words.find((w) => !/^(major|minor|patch)$/.test(w)) ?? "";
      // On a Teire PR, `@teire ignore major` names the PR's package (D112).
      if (!target && type && artifact?.kind === "pr" && artifact.changeKey) {
        const parts = artifact.changeKey.split("/");
        target = `${parts[0]}:${parts.slice(1, -1).join("/")}`;
      }
      if (!target)
        return void (await reply(
          `Usage: \`@teire ${command.name} <change id, package or provider:name>\`, or \`@teire ${command.name} <package> major|minor|patch\``,
        ));
      const on = command.name === "ignore";
      if (type) {
        await setIgnore(db, repo.id, `${target}@${type}`, on);
        // Asked on the Teire PR it names: that PR's update is the one being declined, so it closes,
        // after the reply, so the reply isn't left on a closed PR (review R16).
        const closing = on && artifact?.kind === "pr" && artifact.state === "open" ? artifact.number : null;
        await reply(
          on
            ? `Ignoring ${type} updates of \`${target}\`; other updates still come.${closing ? " Closing this PR." : ""}`
            : `${type[0]?.toUpperCase()}${type.slice(1)} updates of \`${target}\` come again.`,
        );
        if (closing)
          await octokit.rest.pulls.update({ owner, repo: name, pull_number: closing, state: "closed" });
        return;
      }
      await setIgnore(db, repo.id, target, on);
      const n = await setFindingsState(db, repo.id, (f) => matchesTarget(target, f), on ? "ignored" : "open");
      // Ignoring closes the open PRs for it (C6: "Ignore this change"), after the reply names them,
      // so the reply isn't left on a closed PR (review R16).
      const open = new Set<number>();
      if (on)
        for (const f of (await findingsWithChanges(db, repo.id)).filter(
          (x) => matchesTarget(target, x) && x.groupKey,
        )) {
          const pr = await getArtifact(db, repo.id, "pr", f.groupKey as string);
          if (pr?.state === "open" && pr.number) open.add(pr.number);
        }
      const closes = [...open].map((pr) => (pr === issueNumber ? "this PR" : `#${pr}`));
      await reply(
        `${on ? "Ignored" : "Unignored"} \`${target}\` (${n} finding${n === 1 ? "" : "s"}).${closes.length ? ` Closing ${closes.join(", ")}.` : ""}`,
      );
      for (const pr of open) {
        if (pr !== issueNumber)
          await octokit.rest.issues.createComment({
            owner,
            repo: name,
            issue_number: pr,
            body: `Closed: @${by} ignored \`${target}\`.`,
          });
        await octokit.rest.pulls.update({ owner, repo: name, pull_number: pr, state: "closed" });
      }
      return;
    }
    case "fix":
    case "rebase":
    case "recreate": {
      const target = command.args.split(/\s+/)[0] ?? "";
      const all = await findingsWithChanges(db, repo.id);
      const groupKey =
        command.name === "fix"
          ? (all.find((f) => matchesTarget(target, f) && f.groupKey)?.groupKey ?? null)
          : artifact?.changeKey || null;
      if (!groupKey)
        return void (await reply(
          command.name === "fix"
            ? `No finding matches \`${target || "(nothing)"}\`; the Dashboard issue lists what can be fixed.`
            : `\`@teire ${command.name}\` works on a Teire PR.`,
        ));
      if (command.name === "fix") {
        const open = await getArtifact(db, repo.id, "pr", groupKey);
        if (open?.state === "open") return void (await reply(`Already open: ${open.url}`));
      }
      const started_ = await startRun(ctx, repo, octokit, groupKey, command.name, by).catch((error) => {
        if (error instanceof FixesOffError) return error;
        throw error;
      });
      if (started_ instanceof FixesOffError) return void (await reply(started_.message));
      const { run, created, sha } = started_;
      const link = ctx.webUrl ? `: ${ctx.webUrl}/runs/${run.id}` : ".";
      const started = created
        ? `Started (${command.name}) on \`${sha.slice(0, 7)}\`${link}`
        : `Already running for \`${sha.slice(0, 7)}\`${link}`;
      const { data: comment } = await reply(started);
      // The run edits this comment with how it ended (S15.8, the progress comment).
      if (created)
        await appendEvent(db, run.id, "progress", "comment", {
          owner,
          repo: name,
          commentId: comment.id,
          started,
        });
      return;
    }
    case "explain": {
      const group = artifact?.changeKey || command.args.split(/\s+/)[0] || "";
      const rows = (await findingsWithChanges(db, repo.id)).filter((f) => group && matchesTarget(group, f));
      if (!rows.length)
        return void (await reply(
          "Nothing to explain here; use it on a Teire PR or issue, or name a change.",
        ));
      const lines = rows.slice(0, 10).map((f) => {
        const sites = (f.callSites as { file: string; line: number }[])
          .slice(0, 5)
          .map((s) => `\`${s.file}:${s.line}\``)
          .join(", ");
        return `- **${f.title ?? f.changeId}** — ${f.verdict}${f.reason ? `: ${f.reason}` : ""}${sites ? `\n  Sites: ${sites}` : ""}`;
      });
      await reply(
        [
          `**Why Teire flagged this** (${rows.length} finding${rows.length === 1 ? "" : "s"}):`,
          "",
          ...lines,
          artifact?.runId && ctx.webUrl
            ? `\nRun with the full evidence: ${ctx.webUrl}/runs/${artifact.runId}`
            : "",
        ].join("\n"),
      );
      return;
    }
    case "config": {
      const token = await (await gh.installation(repo.installationId)).token();
      const checkout = await fetchRepoTarball(owner, name, repo.defaultBranch, { token });
      const orgText = await readOrgConfig(octokit, owner);
      // Read the config, then delete the checkout: nothing of the repository stays on disk.
      const config = (() => {
        try {
          return readTeireConfig(
            directoryTree(checkout.dir),
            orgText ? { orgText, orgFile: `${owner}/teire-config/teire.yml` } : {},
          );
        } finally {
          void rm(checkout.dir, { recursive: true, force: true });
        }
      })();
      await reply(
        [
          `**Resolved config** (${config.path ? `\`${config.path}\`` : "no teire.yml"}${orgText ? ` + \`${owner}/teire-config\`` : ""}):`,
          "",
          describeConfig(config),
          config.problems.length
            ? `\n**Problems** (defaults used):\n${config.problems.map((x) => `- ${x}`).join("\n")}`
            : "",
        ].join("\n"),
      );
      return;
    }
    case "wrong": {
      if (!command.args) return void (await reply("Usage: `@teire wrong <what is wrong>`"));
      await recordFeedback(db, {
        repoId: repo.id,
        groupKey: artifact?.changeKey || null,
        changeId: null,
        login: by,
        reason: command.args.slice(0, 2000),
        url: comment.html_url ?? null,
      });
      await reply(
        "Thanks; recorded. It is reviewed against the evidence before the next release of the rules.",
      );
      return;
    }
  }
}

/** Write access decides who may command Teire; author_association alone does not say it. */
export async function canWrite(
  octokit: Awaited<ReturnType<EventContext["gh"]["installation"]>>["octokit"],
  owner: string,
  repo: string,
  login: string,
) {
  const { data } = await octokit.rest.repos
    .getCollaboratorPermissionLevel({ owner, repo, username: login })
    .catch(() => ({ data: { permission: "none" } }));
  return ["admin", "maintain", "write"].includes(String(data.permission));
}

/**
 * A fix run for one group on the default branch's head: `fix` and Dashboard ticks once per head,
 * `rebase` re-applies on the new head, `recreate` always starts fresh (C6).
 */
/**
 * Thrown by `startRun` when fix mode is Off (D118): the one gate every run start passes. Its message
 * names the mode and where it was set, and the way round it.
 */
export class FixesOffError extends Error {
  constructor(readonly mode: EffectiveFixMode) {
    super(fixesOffReply(mode));
  }
}

export function fixesOffReply(mode: EffectiveFixMode) {
  return `Fixes are ${describeFixMode(mode)} here. ${
    mode.origin === "repo-file" || mode.origin === "org-file"
      ? `Change \`fixes:\` in ${mode.file} to turn them on.`
      : "`@teire fix-mode automatic` (or the dashboard) turns them on."
  }`;
}

export async function startRun(
  ctx: EventContext,
  repo: NonNullable<Awaited<ReturnType<typeof getRepo>>>,
  octokit: Awaited<ReturnType<EventContext["gh"]["installation"]>>["octokit"],
  groupKey: string,
  reason: "fix" | "rebase" | "recreate" | "ci-repair",
  by: string,
  /** Runs after the run exists and before its job is queued (the CI log a repair starts from). */
  beforeEnqueue?: (runId: string) => Promise<void>,
) {
  // Automatic and Ask first both run what a person (or a PR they asked for) needs; Off never does.
  const mode = await fixModeOf(ctx.db, repo);
  if (!personMayStart(mode)) throw new FixesOffError(mode);
  const [owner = "", name = ""] = repo.fullName.split("/");
  const { data: branch } = await octokit.rest.repos.getBranch({
    owner,
    repo: name,
    branch:
      (repo.config as { pullRequests?: { targetBranch?: string | null } } | null)?.pullRequests
        ?.targetBranch || repo.defaultBranch,
  });
  const sha = branch.commit.sha;
  // A package group's key ends in its target version; a model or API group's targets are the
  // replacements its findings name, as the scan records them.
  let fromVersion: string | null = null;
  let targetVersion: string | null = groupKey.split("/").pop() ?? null;
  if (/^(models|api)\//.test(groupKey)) {
    const positions = (await findingsWithChanges(ctx.db, repo.id))
      .filter((f) => f.groupKey === groupKey)
      .map((f) => f.position as { version?: string | null; target?: string | null } | null);
    const join = (values: (string | null | undefined)[]) =>
      [...new Set(values.filter(Boolean))].join(", ") || null;
    fromVersion = join(positions.map((p) => p?.version));
    targetVersion = join(positions.map((p) => p?.target)) ?? "the named replacements";
  }
  // A security update and a version update of one package are separate PR lines (D111).
  const security = (await findingsWithChanges(ctx.db, repo.id)).some(
    (f) => f.groupKey === groupKey && f.kind === "security-advisory",
  );
  const claim = (fresh: boolean) =>
    claimRun(ctx.db, {
      repoId: repo.id,
      groupKey,
      lineageKey: lineageKey(groupKey, security ? "security" : "version"),
      kind: "fix",
      status: "queued",
      fromVersion,
      targetVersion,
      baseSha: sha,
      requestedBy: `${reason}:${by}`,
      idempotencyKey: `${reason}:${repo.id}:${groupKey}:${sha}${fresh ? `:${Date.now()}` : ""}`,
    });
  // `fix` while a run for the group is queued or running (a scan's, a tick's) answers with that run.
  if (reason === "fix") {
    const pending = await fixInFlight(ctx.db, repo.id, groupKey);
    if (pending) return { run: pending, created: false, sha };
  }
  // Asking again after a run on this commit failed or was cancelled starts a new attempt; a queued,
  // running or finished run is the answer already.
  let { run, created } = await claim(reason === "recreate");
  if (!created && (run.status === "failed" || run.status === "cancelled"))
    ({ run, created } = await claim(true));
  if (created) {
    await beforeEnqueue?.(run.id);
    await ctx.enqueueFix(run.id, repo.id);
  }
  return { run, created, sha };
}

/** `<org>/teire-config`'s `teire.yml` (or `.github/teire.yml`), when the App can read it. */
export async function readOrgConfig(
  octokit: Awaited<ReturnType<EventContext["gh"]["installation"]>>["octokit"],
  owner: string,
) {
  for (const path of ["teire.yml", ".github/teire.yml"]) {
    const res = await octokit.rest.repos
      .getContent({ owner, repo: "teire-config", path, mediaType: { format: "raw" } })
      .catch(() => null);
    if (res && typeof res.data === "string") return res.data;
  }
  return null;
}
