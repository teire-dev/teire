import type { Octokit } from "octokit";
import { PR_MODE_BY_EVIDENCE, PULL_REQUESTS } from "../constants";
import type { CallSite } from "../contract";

/** The label on a Teire PR whose base moved while fixes were Off: its evidence is from an older base (D125). */
export const STALE_EVIDENCE_LABEL = "stale-evidence";
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
  // An updated PR's evidence may have changed (a draft that now verifies): Teire's own evidence
  // labels that no longer apply come off; labels people added stay.
  if (!created) await dropStaleLabels(octokit, owner, repo, pr, input.labels);
  if (input.labels.length)
    await octokit.rest.issues
      .addLabels({ owner, repo, issue_number: pr.number, labels: input.labels })
      .catch(() => undefined);
  return { number: pr.number, url: pr.html_url, nodeId: pr.node_id, draft: input.draft, created };
}

/** Teire's evidence labels that no longer apply, and `stale-evidence` once the evidence is current again. */
async function dropStaleLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: { number: number; labels?: { name?: string }[] },
  keep: string[],
) {
  const stale = [
    ...Object.keys(PR_MODE_BY_EVIDENCE).map((kind) => kind.replace(/_/g, "-")),
    STALE_EVIDENCE_LABEL,
  ].filter((label) => !keep.includes(label));
  const current = new Set((pr.labels ?? []).map((l) => l.name));
  for (const label of stale.filter((l) => current.has(l)))
    await octokit.rest.issues
      .removeLabel({ owner, repo, issue_number: pr.number, name: label })
      .catch(() => undefined);
}

/**
 * An open PR set to new evidence without touching its code (Re-verify, U2): a draft that now
 * verifies is marked ready, a ready PR its checks no longer prove becomes a draft, and Teire's
 * evidence label follows. Labels people added stay.
 */
export async function setPullRequestEvidence(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  number: number;
  evidence: keyof typeof PR_MODE_BY_EVIDENCE;
  /** The base as it is now wasn't checked (a conflicting PR): `stale-evidence` stays. */
  keepStale?: boolean;
}): Promise<{ draft: boolean; was: boolean }> {
  const { octokit, owner, repo } = input;
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: input.number });
  const draft = PR_MODE_BY_EVIDENCE[input.evidence] !== "ready";
  if (!!pr.draft !== draft)
    await octokit.graphql(
      draft
        ? "mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { id } } }"
        : "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }",
      { id: pr.node_id },
    );
  const labels = draft ? [input.evidence.replace(/_/g, "-")] : [];
  await dropStaleLabels(
    octokit,
    owner,
    repo,
    pr,
    input.keepStale ? [...labels, STALE_EVIDENCE_LABEL] : labels,
  );
  if (labels.length)
    await octokit.rest.issues
      .addLabels({ owner, repo, issue_number: pr.number, labels })
      .catch(() => undefined);
  return { draft, was: !!pr.draft };
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

/** "Teire config" check run (C8): fails with one annotation per problem, at its line. */
export async function publishConfigCheckRun(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  headSha: string;
  issues: { file: string; line: number; path: string; message: string }[];
}) {
  const { octokit, owner, repo } = input;
  const failing = input.issues.length > 0;
  await octokit.rest.checks.create({
    owner,
    repo,
    name: "Teire config",
    head_sha: input.headSha,
    status: "completed",
    conclusion: failing ? "failure" : "success",
    output: {
      title: failing
        ? `${input.issues.length} problem(s) in the Teire config; defaults used for those keys`
        : "Teire config is valid",
      summary: failing
        ? input.issues
            .map((i) => `- \`${i.file}\` line ${i.line}: ${i.path ? `\`${i.path}\` ` : ""}${i.message}`)
            .join("\n")
        : "Every key matched the schema (https://teire.vercel.app/schema.json).",
      annotations: input.issues
        .filter((i) => !i.file.includes("teire-config/"))
        .slice(0, 50)
        .map((i) => ({
          path: i.file,
          start_line: i.line,
          end_line: i.line,
          annotation_level: "failure" as const,
          message: `${i.path ? `${i.path}: ` : ""}${i.message}`,
        })),
    },
  });
}
