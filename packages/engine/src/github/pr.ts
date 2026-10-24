import type { Octokit } from "octokit";
import { PULL_REQUESTS } from "../constants";
import type { CallSite } from "../contract";

/**
 * The pull request for one branch (card C6): opened once, updated in place on later runs (title,
 * body, draft state), labelled, and paired with a "Teire" check run that annotates every call site.
 */
export interface PullRequestRef {
  number: number;
  url: string;
  nodeId: string;
  draft: boolean;
}

export async function openOrUpdatePullRequest(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  labels: string[];
}): Promise<PullRequestRef & { created: boolean }> {
  const { octokit, owner, repo } = input;
  const { data: open } = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${input.branch}`,
    state: "open",
  });
  let pr = open[0];
  let created = false;
  if (pr) {
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: pr.number,
      title: input.title,
      body: input.body,
    });
    if (pr.draft !== input.draft) {
      const mutation = input.draft
        ? "mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { id } } }"
        : "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }";
      await octokit.graphql(mutation, { id: pr.node_id });
    }
  } else {
    const { data } = await octokit.rest.pulls.create({
      owner,
      repo,
      head: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft,
      maintainer_can_modify: true,
    });
    pr = data as unknown as typeof pr;
    created = true;
  }
  if (!pr) throw new Error("pull request missing after create");
  if (input.labels.length)
    await octokit.rest.issues
      .addLabels({ owner, repo, issue_number: pr.number, labels: input.labels })
      .catch(() => undefined);
  return { number: pr.number, url: pr.html_url, nodeId: pr.node_id, draft: input.draft, created };
}

/** "Teire" check run on the PR head with one annotation per located site. */
export async function publishCheckRun(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  headSha: string;
  conclusion: "success" | "neutral" | "failure";
  title: string;
  summary: string;
  detailsUrl?: string;
  sites: (CallSite & { message: string })[];
}) {
  const { octokit, owner, repo } = input;
  const annotations = input.sites.map((s) => ({
    path: s.file,
    start_line: s.line,
    end_line: s.line,
    annotation_level: "notice" as const,
    message: s.message.slice(0, 64_000),
    title: "Teire",
  }));
  const batch = (i: number) => annotations.slice(i, i + PULL_REQUESTS.annotationsPerCall);
  const { data } = await octokit.rest.checks.create({
    owner,
    repo,
    name: "Teire",
    head_sha: input.headSha,
    status: "completed",
    conclusion: input.conclusion,
    ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
    output: { title: input.title, summary: input.summary.slice(0, 65_000), annotations: batch(0) },
  });
  for (
    let i = PULL_REQUESTS.annotationsPerCall;
    i < annotations.length;
    i += PULL_REQUESTS.annotationsPerCall
  )
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: data.id,
      output: { title: input.title, summary: input.summary.slice(0, 65_000), annotations: batch(i) },
    });
  return data.id;
}
