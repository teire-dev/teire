import { CONFIG_PR_KEYS, type ConfigPrKey, isValidConfigText, setConfigKey } from "@teire/engine/config";
import { branchFor, commitToBranch, DEFAULT_CONFIG, openOrUpdatePullRequest } from "@teire/engine/github";
import { type getRepo, upsertArtifact } from "../store";
import type { WorkerContext } from "./scan";

type Octokit = Awaited<ReturnType<WorkerContext["gh"]["installation"]>>["octokit"];
type Repo = NonNullable<Awaited<ReturnType<typeof getRepo>>>;
type Outcome = { status: "done" | "refused"; result: string; links?: { label: string; href: string }[] };

/** Where the settings live: the organisation's `teire-config` keeps them at its root (C8). */
const configPath = (repo: Repo) =>
  repo.fullName.split("/")[1] === "teire-config" ? "teire.yml" : ".github/teire.yml";

/**
 * A `teire.yml` change through a pull request (plan revision 3.3, U3: the Config tab's "Change a
 * setting", Settings' organisation defaults, and "Generate starter" for a missing or broken file): the
 * file is read from the base branch, one key set with its comments kept (or replaced by Teire's
 * starter), checked against the schema, and opened as a PR from Teire's own branch, refreshed in place
 * when asked again. It writes no code, so every fix mode allows it.
 */
export async function configPr(
  ctx: WorkerContext,
  repo: Repo,
  octokit: Octokit,
  kind: "config-pr" | "starter-config-pr",
  params: Record<string, unknown>,
  login: string,
): Promise<Outcome> {
  if (repo.status === "paused")
    return { status: "refused", result: "This repository is paused; resume it first" };
  const [owner = "", name = ""] = repo.fullName.split("/");
  const path = configPath(repo);
  const config = repo.config as { pullRequests?: { targetBranch?: string | null } } | null;
  const base = config?.pullRequests?.targetBranch || repo.defaultBranch;
  const tip = (await octokit.rest.repos.getBranch({ owner, repo: name, branch: base })).data.commit.sha;
  const current = await octokit.rest.repos
    .getContent({ owner, repo: name, path, ref: tip })
    .then(({ data }) =>
      "content" in data && typeof data.content === "string"
        ? Buffer.from(data.content, "base64").toString("utf8")
        : null,
    )
    .catch((error: { status?: number }) => {
      if (error.status === 404) return null;
      throw error;
    });
  let text: string;
  let title: string;
  let branchKey: string;
  if (kind === "starter-config-pr") {
    if (current?.trim() === DEFAULT_CONFIG.trim())
      return { status: "done", result: `${path} is already Teire's starter` };
    // The starter replaces only a missing or broken file (U3 review): a valid one keeps its settings.
    if (current !== null && isValidConfigText(current))
      return { status: "refused", result: `${path} is valid; change a setting instead of replacing it` };
    text = DEFAULT_CONFIG;
    title = current === null ? `Add Teire's starter ${path}` : `Replace ${path} with Teire's starter`;
    branchKey = "config/starter";
  } else {
    const key = params.key as ConfigPrKey;
    const edited = setConfigKey(current ?? DEFAULT_CONFIG, key, String(params.value));
    if ("error" in edited)
      return { status: "refused", result: `Teire can't make that change: ${edited.error}` };
    if (!edited.changed && current !== null)
      return { status: "done", result: `${key} is already ${String(params.value)} in ${path}` };
    text = edited.text;
    const shown = String(params.value).trim();
    const entries = shown.split(/[\n,]/).filter((x) => x.trim()).length;
    title =
      CONFIG_PR_KEYS[key].kind === "list"
        ? `Set ${key} (${entries} ${entries === 1 ? "entry" : "entries"}) in ${path}`
        : `Set ${key} to ${shown} in ${path}`;
    branchKey = `config/${key}`;
  }
  const branch = branchFor(branchKey);
  const commit = await commitToBranch({
    octokit,
    owner,
    repo: name,
    branch,
    baseSha: tip,
    botLogin: ctx.gh.botLogin,
    headline: title,
    body: `Asked for by @${login} from the Teire dashboard.`,
    files: [{ path, content: text }],
  });
  const pr = await openOrUpdatePullRequest({
    octokit,
    owner,
    repo: name,
    branch,
    base,
    title,
    body: [
      `@${login} asked for this from the Teire dashboard.`,
      kind === "starter-config-pr"
        ? `It ${current === null ? "adds" : "replaces"} \`${path}\` with Teire's starter: every key at its default, each one commented.`
        : `It sets \`${String(params.key)}\` to ${
            CONFIG_PR_KEYS[params.key as ConfigPrKey].kind === "list"
              ? String(params.value)
                  .split(/[\n,]/)
                  .map((x) => x.trim())
                  .filter(Boolean)
                  .map((x) => `\`${x}\``)
                  .join(", ") || "an empty list"
              : `\`${String(params.value)}\``
          } in \`${path}\`. The other keys and the comments are kept (YAML spacing may be tidied), and the result is checked against [the schema](https://teire.vercel.app/schema.json).`,
      "Merging it is what changes the setting: Teire reads the file at the next scan.",
      `<sub>Commit ${commit.oid.slice(0, 7)}.</sub>`,
    ].join("\n\n"),
    draft: false,
    labels: ["teire"],
  });
  // Recorded so the repository's Pull requests tab lists it and its close or merge is kept.
  await upsertArtifact(ctx.db, {
    repoId: repo.id,
    kind: "config",
    changeKey: branchKey,
    number: pr.number,
    branch,
    headSha: commit.oid,
    state: "open",
    url: pr.url,
  });
  return {
    status: "done",
    result: `${pr.created ? "Opened" : "Updated"} #${pr.number}: ${title}`,
    links: [{ label: `#${pr.number}`, href: pr.url }],
  };
}
