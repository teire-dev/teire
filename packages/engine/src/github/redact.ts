/** Longest reason Teire writes on GitHub by default; the run page keeps the whole message. */
const MAX_CHARS = 300;

/**
 * An error as GitHub readers see it (review R18): the reason without what a service sent back or
 * where the worker keeps things. Response bodies after `→ <status>:` are cut, tokens, the Token
 * Factory project id, sandbox ids and the worker's own paths are replaced, and the text is shortened.
 * The run page shows the full message to the people who can see the run.
 */
export function forGitHub(message: string, max = MAX_CHARS): string {
  const text = message
    // A service's response body: keep the call and its status, drop what it said.
    .replace(/(→ \d{3}):[\s\S]*/, "$1")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***")
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 ***")
    .replace(/(https?:\/\/)[^\s/@]+@/g, "$1***@")
    .replace(/\baiproject-[a-z0-9]+\b/g, "<project>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    // The worker's checkouts, caches and image folders; paths inside the repository stay.
    .replace(/(?:\/private)?\/(?:tmp|var\/folders|app|root|home\/[^/\s]+)\/[^\s'"`),;]*/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
