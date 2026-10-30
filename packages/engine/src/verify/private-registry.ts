import type { RepoTree } from "../inventory/tree";

/**
 * Whether a root installs from a registry other than its ecosystem's public one (R21.11): such a
 * root's download cache is never saved, so a private registry's packages never reach the R2 bucket.
 * Read from the files that point a package manager elsewhere, in the root, every directory above it
 * and, for build files and lockfiles, below it. Null when every source named is public; otherwise
 * the file and host, for the run's events. Go has no such file: the sandbox fetches modules through
 * the public proxy, and a private module can't be fetched without credentials the sandbox doesn't
 * have, so its install fails and nothing is saved.
 */
export function privateRegistry(tree: RepoTree, root: string, ecosystem: string): string | null {
  const dirs = rootChain(root);
  const near = (...names: string[]) => dirs.flatMap((d) => names.map((n) => (d === "." ? n : `${d}/${n}`)));
  const prefix = root === "." ? "" : `${root}/`;
  const below = (test: (name: string) => boolean) =>
    tree
      .files()
      .filter((f) => f.startsWith(prefix) && test(f.slice(f.lastIndexOf("/") + 1)))
      .slice(0, MAX_FILES);
  const check = (files: string[], read: (text: string) => string[], publicHosts: readonly string[]) => {
    for (const file of files) {
      const text = tree.read(file);
      if (!text) continue;
      for (const found of read(text)) {
        if (found === CREDENTIALS) return `${file} configures its own registry or credentials`;
        const host = hostOf(found);
        if (!host) continue;
        if (!publicHosts.some((p) => host === p || host.endsWith(`.${p}`))) return `${file} names ${host}`;
      }
    }
    return null;
  };
  switch (ecosystem) {
    case "npm":
      return (
        check(near(".npmrc"), npmrc, NPM_PUBLIC) ??
        check(near(".yarnrc.yml"), yarnrcYml, NPM_PUBLIC) ??
        check(near(".yarnrc"), (t) => matches(t, /^\s*registry\s+"?([^"\s]+)/gm), NPM_PUBLIC) ??
        check(near("bunfig.toml"), bunfig, NPM_PUBLIC) ??
        check(
          below((n) => NPM_LOCKFILES.has(n)),
          (t) =>
            matches(
              t,
              /(?:"resolved"\s*:\s*"|^\s*resolved\s+"|tarball:\s*|\[\s*"[^"]+",\s*")(https?:\/\/[^"'\s]+)/gm,
            ),
          NPM_PUBLIC,
        )
      );
    case "pypi":
      return (
        check(near("pip.conf", "pip.ini", ".pip/pip.conf"), pipConf, PYPI_PUBLIC) ??
        check(
          below((n) => /^requirements.*\.(?:txt|in)$|\.in$/.test(n)),
          (t) => matches(t, /^\s*(?:--index-url|--extra-index-url|--find-links|-i|-f)[\s=]+(\S+)/gm),
          PYPI_PUBLIC,
        ) ??
        check(
          below((n) => PYPI_FILES.has(n)),
          (t) =>
            matches(
              t,
              /\b(?:url|registry|index-url|extra-index-url|find-links)\s*=\s*["'](https?:\/\/[^"']+)/g,
            ),
          PYPI_PUBLIC,
        )
      );
    case "cargo":
      return (
        check(near(".cargo/config.toml", ".cargo/config"), cargoConfig, CARGO_PUBLIC) ??
        check(
          below((n) => n === "Cargo.lock"),
          (t) => matches(t, /^source\s*=\s*"(?:registry|sparse)\+([^"]+)"/gm),
          CARGO_PUBLIC,
        )
      );
    case "rubygems":
      return check(
        below((n) => n === "Gemfile" || n === "Gemfile.lock" || n === "gems.rb" || n === "gems.locked"),
        (t) => matches(t, /^\s*(?:source\s*\(?\s*["']|remote:\s*)(https?:\/\/[^"'\s)]+)/gm),
        RUBYGEMS_PUBLIC,
      );
    case "maven":
      return (
        check(near("settings.xml", ".mvn/settings.xml"), () => [CREDENTIALS], []) ??
        check(
          near(".mvn/maven.config"),
          (t) => (/(?:^|\s)(?:-s|--settings|-gs|--global-settings)\b/.test(t) ? [CREDENTIALS] : []),
          [],
        ) ??
        check(
          below((n) => n === "pom.xml"),
          (t) =>
            [...t.matchAll(/<(?:plugin)?[Rr]epository>([\s\S]*?)<\/(?:plugin)?[Rr]epository>/g)].flatMap(
              (m) => matches(m[1] ?? "", /<url>\s*([^<\s]+)\s*<\/url>/g),
            ),
          MAVEN_PUBLIC,
        ) ??
        check(
          below((n) => /\.gradle(?:\.kts)?$/.test(n)),
          (t) =>
            /\bcredentials\s*[({]/.test(t)
              ? [CREDENTIALS]
              : [
                  ...matches(t, /\bmaven\s*\{[^}]*?\burl\s*(?:=|\()?\s*(?:uri\s*\(\s*)?["']([^"']+)/g),
                  ...matches(t, /\bmaven\s*\(\s*(?:url\s*=\s*)?["']([^"']+)/g),
                ],
          MAVEN_PUBLIC,
        )
      );
    default:
      return null;
  }
}

const MAX_FILES = 200;
const CREDENTIALS = "\0credentials";

const NPM_PUBLIC = [
  "registry.npmjs.org",
  "registry.npmjs.com",
  "registry.yarnpkg.com",
  "codeload.github.com",
  "github.com",
];
const PYPI_PUBLIC = [
  "pypi.org",
  "files.pythonhosted.org",
  "download.pytorch.org",
  "pypi.nvidia.com",
  "github.com",
  "codeload.github.com",
];
const CARGO_PUBLIC = ["github.com/rust-lang/crates.io-index", "index.crates.io"];
const RUBYGEMS_PUBLIC = ["rubygems.org"];
const MAVEN_PUBLIC = [
  "repo.maven.apache.org",
  "repo1.maven.org",
  "maven.google.com",
  "dl.google.com",
  "plugins.gradle.org",
  "jitpack.io",
  "oss.sonatype.org",
  "s01.oss.sonatype.org",
  "central.sonatype.com",
];

const NPM_LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
]);
const PYPI_FILES = new Set([
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "pdm.lock",
]);

function rootChain(root: string) {
  const parts = root === "." ? [] : root.split("/");
  return parts.map((_, i) => parts.slice(0, parts.length - i).join("/")).concat(".");
}

function matches(text: string, re: RegExp) {
  return [...text.matchAll(re)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/** The host a URL names, with the index path kept for Cargo's GitHub-hosted crates.io index. */
function hostOf(url: string) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === "github.com" && /^\/rust-lang\/crates\.io-index\/?$/.test(u.pathname)
      ? "github.com/rust-lang/crates.io-index"
      : host;
  } catch {
    return null;
  }
}

function npmrc(text: string) {
  if (/^\s*(?:\/\/[^\s=]+:)?(?:_authToken|_auth|_password|username)\s*=/m.test(text)) return [CREDENTIALS];
  return matches(text, /^\s*(?:@[\w.-]+:)?registry\s*=\s*(\S+)/gm);
}

function yarnrcYml(text: string) {
  if (/^\s*(?:npmAuthToken|npmAuthIdent|npmScopes)\s*:/m.test(text)) return [CREDENTIALS];
  return matches(text, /^\s*npmRegistryServer\s*:\s*["']?([^"'\s]+)/gm);
}

function bunfig(text: string) {
  if (/^\s*\[install\.scopes\]/m.test(text) || /\btoken\s*=/.test(text)) return [CREDENTIALS];
  return matches(text, /^\s*registry\s*=\s*(?:\{[^}]*url\s*=\s*)?["']([^"']+)/gm);
}

function pipConf(text: string) {
  return matches(text, /^\s*(?:index-url|extra-index-url|find-links)\s*=\s*(\S+)/gm);
}

function cargoConfig(text: string) {
  if (/^\s*\[(?:registries\.|registry\]|source\.)/m.test(text)) return [CREDENTIALS];
  return [];
}
