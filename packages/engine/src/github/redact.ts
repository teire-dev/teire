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
    // A service's response body: keep the call and its status, drop what it said (to the end of
    // that line, so a cause appended after it survives).
    .replace(/(→ \d{3}):[^\n]*/g, "$1")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***")
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 ***")
    .replace(/(https?:\/\/)[^\s/@]+@/g, "$1***@")
    // Credentials in a query string or written as `name=value` / `name: value`.
    .replace(
      /([?&](?:access_token|token|api_?key|key|secret|password|sig|signature|auth)=)[^&\s#]+/gi,
      "$1***",
    )
    .replace(
      /\b((?:password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi,
      "$1***",
    )
    .replace(/\b(?:sk|pk|rk|nvapi|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/g, "***")
    .replace(/\baiproject-[a-z0-9]+\b/g, "<project>")
    // Sandbox and operation ids, but not the id in a run's own link.
    .replace(/(?<!\/runs\/)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    // The worker's checkouts, caches and image folders; paths inside the repository stay, and so
    // do URLs that happen to contain /app/ or /tmp/.
    .replace(
      /(?<![\w.:/-])(?:\/private)?\/(?:tmp|var\/folders|app|root|home\/[^/\s]+)\/[^\s'"`),;]*/g,
      "<path>",
    )
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
