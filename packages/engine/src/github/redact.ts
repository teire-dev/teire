/** Longest reason Teire writes on GitHub by default; the run page keeps the whole message. */
const MAX_CHARS = 300;

/**
 * An error as GitHub readers see it (review R18): the reason without what a service sent back or
 * where the worker keeps things. Response bodies after `→ <status>:` are cut, tokens, the Token
 * Factory project id, sandbox ids and the worker's own paths are replaced, and the text is shortened.
 * The run page shows the full message to the people who can see the run.
 */
export function forGitHub(message: string, max = MAX_CHARS): string {
  const text = maskSecrets(
    message
      // A service's response body: keep the call and its status, drop what it said (to the end of
      // that line, so a cause appended after it survives).
      .replace(/(→ \d{3}):[^\n]*/g, "$1"),
  )
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

/**
 * Credentials taken out of any text, its lines and spacing kept (U2 review): command output, events
 * and errors on a run page anyone may read for a public repository. Tokens, `Bearer …`, a URL's
 * user part, credentials in a query string or written as `name=value` / `name: value`, provider
 * keys, cloud access keys, private key blocks and the Token Factory project id.
 */
/** A source file's name right before `:` (`token.go:`, `auth_test.py:`), and a line or range after it. */
const FILE_LINE =
  /\.(?:go|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|rb|rs|java|kt|kts|scala|groovy|gradle|php|cs|swift|c|h|cc|cpp|hpp|ex|exs|dart|lua|sh|vue|svelte|json|ya?ml|toml|md|mdx|xml)[ \t]*:[ \t]*$/i;
// The line (or range) may run into markdown around it: `token.go:22`](https://…).
const LINE = /^\d+(?:[:-]\d+)*(?![\w])/;

export function maskSecrets(text: string): string {
  return (
    text
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "***")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{30,})\b/g, "***")
      .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 ***")
      .replace(/(https?:\/\/)[^\s/@]+@/g, "$1***@")
      .replace(
        /([?&](?:access_token|token|api_?key|key|secret|password|sig|signature|auth)=)[^&\s#]+/gi,
        "$1***",
      )
      // Any name that says it holds a credential (`GITHUB_TOKEN=…`, `authorization: …`, `x-api-key=…`),
      // whatever else the name says. A word like "token: expired" in prose loses its value too; for a
      // page anyone can read that is the safer mistake. A source file and its line (`auth/token.go:12`)
      // is a place, not a credential, and stays: it is the proof a run page and a PR body point at.
      .replace(
        /\b([\w.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth(?:orization)?|credential|cookie|session[_-]?id|signature)[\w.-]*["']?[ \t]*[=:][ \t]*["']?)(?!\*\*\*)([^\s"',;&]+)/gi,
        (match, name: string, value: string) =>
          // A file and its line, or a file label in markdown (`**auth/token.go:**`), hides nothing.
          FILE_LINE.test(name) && (LINE.test(value) || !/[A-Za-z0-9]/.test(value)) ? match : `${name}***`,
      )
      .replace(/\b(?:sk|pk|rk|nvapi|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/g, "***")
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "***")
      .replace(/\baiproject-[a-z0-9]+\b/g, "<project>")
  );
}
