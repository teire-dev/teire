/**
 * What dependabot-core's updater found upstream, read from the PR body it wrote (D-13): the commits
 * between the two versions and the compare link. Parsed into data, never passed through as HTML, so
 * Teire's PR renders it with its own sanitiser.
 */
export interface UpstreamCommits {
  commits: { sha: string; url: string; message: string }[];
  /** Commits the updater listed beyond those kept here ("Additional commits viewable…"). */
  more: number;
  compare: string | null;
}

const GITHUB_URL = /^https:\/\/(?:redirect\.)?github\.com\//;

/** Dependabot links through redirect.github.com so its PRs don't ping upstream; the target is github.com. */
function githubUrl(url: string) {
  return GITHUB_URL.test(url) ? url.replace("://redirect.github.com/", "://github.com/") : null;
}

function text(html: string) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export function upstreamFromPrBody(body: string | null, keep = 10): UpstreamCommits | null {
  if (!body) return null;
  const block = /<summary>Commits<\/summary>([\s\S]*?)<\/details>/i.exec(body)?.[1];
  if (!block) return null;
  const commits: UpstreamCommits["commits"] = [];
  let more = 0;
  let compare: string | null = null;
  for (const item of block.match(/<li>[\s\S]*?<\/li>/gi) ?? []) {
    const link = /<a href="([^"]+)"><code>([0-9a-f]{7,40})<\/code><\/a>([\s\S]*)<\/li>/i.exec(item);
    const href = /href="([^"]+)"/i.exec(item)?.[1];
    if (link) {
      const url = githubUrl(link[1] ?? "");
      if (url) commits.push({ sha: link[2] ?? "", url, message: text(link[3] ?? "").slice(0, 160) });
    } else if (/compare view/i.test(item) && href) compare = githubUrl(href);
    else if (/Additional commits viewable/i.test(item)) more += Number(/(\d+)/.exec(text(item))?.[1] ?? 0);
  }
  if (!commits.length && !compare) return null;
  return { commits: commits.slice(0, keep), more: more + Math.max(0, commits.length - keep), compare };
}
