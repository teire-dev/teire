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

/** The branch's head when it holds only Teire's commits over the base; throws on anyone else's. */
async function ownedHead(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  baseSha: string,
  botLogin: string,
  /** `@teire recreate`: a person with write access asked to start over, their commits included. */
  replaceOthers = false,
) {
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const head = ref.object.sha;
  if (replaceOthers) return head;
  const { data } = await octokit.rest.repos.compareCommits({ owner, repo, base: baseSha, head });
  const foreign = data.commits.filter((c) => c.author?.login !== botLogin);
  if (foreign.length) throw new HumanCommitsError(`${branch} has ${foreign.length} commit(s) by others`);
  return head;
}

/** Null when the branch was created at the base; otherwise its head, which holds only Teire's commits. */
async function startBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  baseSha: string,
  botLogin: string,
  replaceOthers = false,
) {
  try {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
    return null;
  } catch (error) {
    if (status(error) !== 422) throw error;
  }
  return ownedHead(octokit, owner, repo, branch, baseSha, botLogin, replaceOthers);
}

const UPDATE_REFS = `mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }`;

/**
 * Moves an existing branch to `sha` only if it still points at `expected` (review R4): GraphQL
 * `updateRefs` with `beforeOid` is atomic, so a person's commit pushed after Teire read the branch
 * is never erased. A moved head is read again; it is taken only if it still holds Teire's commits
 * alone, else the person's commit stops the refresh.
 */
async function swapBranch(
  octokit: Octokit,
  input: {
    owner: string;
    repo: string;
    branch: string;
    baseSha: string;
    botLogin: string;
    replaceOthers?: boolean;
  },
  expected: string,
  sha: string,
) {
  const { data: meta } = await octokit.rest.repos.get({ owner: input.owner, repo: input.repo });
  let before = expected;
  for (let attempt = 0; attempt < PULL_REQUESTS.refSwapAttempts; attempt++) {
    try {
      await octokit.graphql(UPDATE_REFS, {
        input: {
          repositoryId: meta.node_id,
          refUpdates: [{ name: `refs/heads/${input.branch}`, beforeOid: before, afterOid: sha, force: true }],
        },
      });
      return;
    } catch (error) {
      const now = await ownedHead(
        octokit,
        input.owner,
        input.repo,
        input.branch,
        input.baseSha,
        input.botLogin,
        input.replaceOthers,
      );
      if (now === before) throw error;
      before = now;
    }
  }
  throw new Error(`${input.branch} kept moving while Teire refreshed it`);
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
  /**
   * Replace commits by others on the branch: only for `@teire recreate`, which a person with write
   * access asks for to start over (PR lifecycle review: without it, recreate stopped again at them).
   */
  replaceOthers?: boolean;
}): Promise<{ oid: string; url: string }> {
  const { octokit, owner, repo, branch, baseSha } = input;
  const existingHead = await startBranch(
    octokit,
    owner,
    repo,
    branch,
    baseSha,
    input.botLogin,
    input.replaceOthers,
  );
  const created = existingHead === null;
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
  // A new branch fast-forwards from the base; an existing one swaps only from the head Teire read.
  if (created)
    await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha, force: false });
  else
    await swapBranch(
      octokit,
      {
        owner,
        repo,
        branch,
        baseSha,
        botLogin: input.botLogin,
        ...(input.replaceOthers ? { replaceOthers: true } : {}),
      },
      existingHead,
      commit.sha,
    );
  return { oid: commit.sha, url: commit.html_url };
}
