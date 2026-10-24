import type { Octokit } from "octokit";
import { PULL_REQUESTS } from "../constants";

/**
 * One commit on Teire's branch (card C6): the branch is (re)set to the base commit, then the files
 * land in a single commit through GraphQL `createCommitOnBranch`, which GitHub signs for the App
 * (a "Verified" commit by `teire-bot[bot]`). Very large changes go through the Git Data API
 * instead. A branch that carries someone else's commits is never reset.
 */
export interface FileWrite {
  path: string;
  /** New content; null deletes the file. */
  content: string | null;
}

export class HumanCommitsError extends Error {}

const MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid url } }
}`;

function status(error: unknown) {
  return (error as { status?: number }).status;
}

async function resetBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  baseSha: string,
  botLogin: string,
) {
  try {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
    return;
  } catch (error) {
    if (status(error) !== 422) throw error;
  }
  // The branch exists: only reset it when every commit on it is Teire's own.
  const { data } = await octokit.rest.repos.compareCommits({ owner, repo, base: baseSha, head: branch });
  const foreign = data.commits.filter((c) => c.author?.login !== botLogin);
  if (foreign.length) throw new HumanCommitsError(`${branch} has ${foreign.length} commit(s) by others`);
  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: baseSha, force: true });
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
  await resetBranch(octokit, owner, repo, branch, baseSha, input.botLogin);
  const additions = input.files
    .filter((f) => f.content !== null)
    .map((f) => ({ path: f.path, contents: Buffer.from(f.content ?? "", "utf8").toString("base64") }));
  const deletions = input.files.filter((f) => f.content === null).map((f) => ({ path: f.path }));
  const bytes = additions.reduce((n, a) => n + a.contents.length, 0);

  if (bytes <= PULL_REQUESTS.maxGraphqlCommitBytes) {
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
            mode: "100644" as const,
            type: "blob" as const,
            sha: (
              await octokit.rest.git.createBlob({
                owner,
                repo,
                content: Buffer.from(f.content, "utf8").toString("base64"),
                encoding: "base64",
              })
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
  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha, force: false });
  return { oid: commit.sha, url: commit.html_url };
}
