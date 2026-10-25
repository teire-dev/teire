/**
 * Links every surface shares. The App's slug is public (it is in its install URL); the GitHub
 * repository is Teire's own source.
 */
export const APP_SLUG = process.env.GITHUB_APP_SLUG ?? "teire-bot";
export const INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;
export const SOURCE_URL = "https://github.com/teire-dev/teire";
export const NPM_URL = "https://www.npmjs.com/package/teire";

export const NAV = [
  { href: "/changes", label: "Changes" },
  { href: "/scan", label: "Scan a repo" },
  { href: "/docs", label: "Docs" },
  { href: "/trust", label: "Trust" },
] as const;
