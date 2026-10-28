import type { Octokit } from "octokit";
import { PULL_REQUESTS } from "../constants";

/**
 * One commit on Teire's branch (card C6), always with the base commit as its parent. A new branch
 * starts at the base and the files land through GraphQL `createCommitOnBranch`. An existing branch
 * (a rebase, recreate or refresh) is never moved back to the base first: for that moment its PR
 * would have no commits and GitHub would close it. The commit is built on the base through the
 * Git Data API instead and the branch jumps to it in one force-push, as Dependabot's rebases do.
 * Both ways GitHub signs the commit for the App (a "Verified" commit by `teire-bot[bot]`), since
 * the requests carry no custom author or committer. A branch with someone else's commits is never
 * rewritten.
 */
export interface FileWrite {
  path: string;
  /** New content; null deletes the file. */
  content: string | null;
  /** How `content` is encoded: text (default) or base64 for binary files such as `bun.lockb`. */
  encoding?: "utf-8" | "base64";
  /** Git file mode when it isn't a plain file: executable, or a symlink (content = its target). */
  mode?: "100644" | "100755" | "120000";
}

const base64Of = (f: FileWrite) =>
  f.encoding === "base64" ? (f.content ?? "") : Buffer.from(f.content ?? "", "utf8").toString("base64");

export class HumanCommitsError extends Error {}

/**
 * The branch for a PR group (rule 9: `teire/<ecosystem>/<package>/<target>`, `teire/<source>/<id>`),
 * made a valid git ref. Maven's `group:artifact` and npm's `@scope/name` would otherwise produce refs
 * git refuses. The cleanup follows Dependabot's `sanitize_ref` (dependabot-core, MIT,
 * `common/lib/dependabot/pull_request_creator/branch_namer/base.rb`), with two differences:
 * Maven's `:` becomes `/`, which no coordinate contains, so `a:b-c` and `a-b:c` stay two branches
 * (Dependabot's `-` merges them); and no component may end in `.lock`, which git refuses.
 */
export function branchFor(groupKey: string) {
  return `${PULL_REQUESTS.branchPrefix}/${groupKey}`
    .replace(/:/g, "/")
    .replace(/@/g, "")
    .replace(/[^A-Za-z0-9/\-_.(){}]/g, "")
    .replace(/\/\./g, "/dot-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/\.lock(?=\/|$)/g, "-lock")
    .replace(/\.$/, "");
}

const MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid url } }
}`;

function status(error: unknown) {
  return (error as { status?: number }).status;
}

/** True when the branch was created at the base; false when it exists and only Teire committed to it. */
async function startBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  baseSha: string,
  botLogin: string,
) {
  try {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
    return true;
  } catch (error) {
    if (status(error) !== 422) throw error;
  }
  const { data } = await octokit.rest.repos.compareCommits({ owner, repo, base: baseSha, head: branch });
  const foreign = data.commits.filter((c) => c.author?.login !== botLogin);
  if (foreign.length) throw new HumanCommitsError(`${branch} has ${foreign.length} commit(s) by others`);
  return false;
}

export async function commitToBranch(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  branch: string;
  baseSha: string;
  botLogin: string;
  headline: string;
  body: string;
  files: FileWrite[];
}): Promise<{ oid: string; url: string }> {
  const { octokit, owner, repo, branch, baseSha } = input;
  const created = await startBranch(octokit, owner, repo, branch, baseSha, input.botLogin);
  const additions = input.files
    .filter((f) => f.content !== null)
    .map((f) => ({ path: f.path, contents: base64Of(f) }));
  const deletions = input.files.filter((f) => f.content === null).map((f) => ({ path: f.path }));
  const bytes = additions.reduce((n, a) => n + a.contents.length, 0);
  // GraphQL commits can't set a file mode, so executables and symlinks take the Git Data API.
  const plain = input.files.every((f) => !f.mode || f.mode === "100644");

  if (created && plain && bytes <= PULL_REQUESTS.maxGraphqlCommitBytes) {
    const result = await octokit.graphql<{ createCommitOnBranch: { commit: { oid: string; url: string } } }>(
      MUTATION,
      {
        input: {
          branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
          message: { headline: input.headline, body: input.body },
          expectedHeadOid: baseSha,
          fileChanges: { additions, deletions },
        },
      },
    );
    return result.createCommitOnBranch.commit;
  }

  // Git Data API: blobs, a tree on the base tree, a commit, the ref.
  const { data: base } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: baseSha });
  const tree = await Promise.all(
    input.files.map(async (f) =>
      f.content === null
        ? { path: f.path, mode: "100644" as const, type: "blob" as const, sha: null }
        : {
            path: f.path,
            mode: f.mode ?? ("100644" as const),
            type: "blob" as const,
            sha: (
              await octokit.rest.git.createBlob({ owner, repo, content: base64Of(f), encoding: "base64" })
            ).data.sha,
          },
    ),
  );
  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: base.tree.sha,
    tree,
  });
  const { data: commit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: `${input.headline}\n\n${input.body}`,
    tree: newTree.sha,
    parents: [baseSha],
  });
  // A new branch fast-forwards from the base; an existing one jumps to the rebuilt commit.
  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha, force: !created });
  return { oid: commit.sha, url: commit.html_url };
}
