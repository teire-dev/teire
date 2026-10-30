import { dirname, join } from "node:path";
import { type DependencyInstance, dependencyInstance } from "../contract";
import type { RepoTree } from "./tree";

/**
 * Bundler inventory (plan S07, research ruby.md Job 1). Gemfile.lock is parsed by Teire's own port
 * of Bundler's lockfile grammar (MIT `lockfile_parser.rb`), which matched `Bundler::LockfileParser`
 * exactly on six real lockfiles; no Ruby runs in the worker. DEPENDENCIES are the direct gems with
 * their declared requirements; every other spec is transitive. The Gemfile is Ruby code and is never
 * evaluated here: its `group :development, :test do` blocks are read as text for scopes, and the
 * lockfile decides versions. No lockfile: the direct gems are "unresolved".
 */
export interface RubyProject {
  root: string;
  manager: "bundler";
  lockfile: string | null;
  lockfileVersion: string | null;
  manifest: string;
  instances: DependencyInstance[];
  rubyVersion: string | null;
  platforms: string[];
  notes: string[];
}

interface LockSpec {
  name: string;
  version: string;
  platform: string;
  source: { type: string; remote: string | null; [k: string]: string | null };
  deps: { name: string; requirement: string }[];
}

export function parseGemfileLock(text: string) {
  const out = {
    sources: [] as { type: string; remote: string | null; options: Record<string, string> }[],
    specs: [] as LockSpec[],
    platforms: [] as string[],
    dependencies: [] as { name: string; requirement: string; pinnedSource: boolean }[],
    checksums: {} as Record<string, Record<string, string>>,
    rubyVersion: null as string | null,
    bundledWith: null as string | null,
  };
  const SOURCES = ["GEM", "GIT", "PATH", "PLUGIN SOURCE"];
  let section: string | null = null;
  let source: (typeof out.sources)[number] | null = null;
  let current: LockSpec | null = null;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw === "") continue;
    if (!raw.startsWith(" ")) {
      section = raw.trim();
      if (SOURCES.includes(section)) {
        source = { type: section, remote: null, options: {} };
        out.sources.push(source);
      }
      continue;
    }
    if (source && section && SOURCES.includes(section)) {
      const opt = /^ {2}([a-z_]+): (.*)$/.exec(raw);
      if (opt) {
        if (opt[1] === "remote") source.remote = opt[2] ?? null;
        else source.options[opt[1] as string] = opt[2] ?? "";
        continue;
      }
      if (raw === "  specs:") continue;
      const m = /^ {4}(\S+) \(([^)]+)\)$/.exec(raw);
      if (m) {
        let version = m[2] as string;
        let platform = "ruby";
        // Bundler splits at the first "-": `1.19.4-aarch64-linux-gnu`.
        const p = /^([^-]*)-(.+)$/.exec(version);
        if (p) {
          version = p[1] as string;
          platform = p[2] as string;
        }
        current = {
          name: m[1] as string,
          version,
          platform,
          source: { type: source.type, remote: source.remote, ...source.options },
          deps: [],
        };
        out.specs.push(current);
        continue;
      }
      const d = /^ {6}(\S+)(?: \((.*)\))?$/.exec(raw);
      if (d && current) {
        current.deps.push({ name: d[1] as string, requirement: d[2] ?? ">= 0" });
        continue;
      }
    }
    if (section === "PLATFORMS") {
      out.platforms.push(raw.trim());
      continue;
    }
    if (section === "DEPENDENCIES") {
      const m = /^ {2}(\S+?)(!)?(?: \((.*)\))?(!)?$/.exec(raw);
      if (m)
        out.dependencies.push({
          name: m[1] as string,
          requirement: m[3] ?? ">= 0",
          pinnedSource: !!(m[2] || m[4]),
        });
      continue;
    }
    if (section === "CHECKSUMS") {
      const m = /^ {2}(\S+) \(([^)]+)\)(?: (.*))?$/.exec(raw);
      if (m)
        out.checksums[`${m[1]}@${m[2]}`] = m[3]
          ? Object.fromEntries(m[3].split(",").map((c) => c.split("=") as [string, string]))
          : {};
      continue;
    }
    if (section === "RUBY VERSION") {
      out.rubyVersion = raw.trim().replace(/^ruby /, "");
      continue;
    }
    if (section === "BUNDLED WITH") out.bundledWith = raw.trim();
  }
  return out;
}

/** One `gem` line of a Gemfile: its groups, its own requirements, and where it comes from. */
export interface GemfileGem {
  groups: string[];
  /** The version requirements written on the line (`"~> 7.0", ">= 7.0.4"`), joined; none for any. */
  requirement?: string;
  /** `git:`/`github:`/`path:`, or a `source "…" do` block that isn't rubygems.org. */
  source?: "git" | "path" | "private-index";
}

/**
 * The gems a Gemfile declares, read as text (D-18, D-25): every block is tracked, so an `if`,
 * `platforms … do` or `source … do` inside a group ends at its own `end`, not the group's; both
 * `group :a, :b do` and `group(:a) do` open a group; and each gem keeps its own requirement strings,
 * the range a lockless Gemfile is compared from (D-37).
 */
export function gemfileGems(text: string): Map<string, GemfileGem> {
  const gems = new Map<string, GemfileGem>();
  // Each open block: the groups it adds, or a source it sets, or nothing.
  const stack: { groups: string[]; source?: GemfileGem["source"] }[] = [];
  const names = (args: string) => [...args.matchAll(/:(\w+)|["'](\w+)["']/g)].map((m) => m[1] ?? m[2] ?? "");
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "");
    const group = /^\s*group\s*\(?\s*(.+?)\s*\)?\s+do\b/.exec(line);
    if (group?.[1]) {
      stack.push({ groups: names(group[1]) });
      continue;
    }
    const sourceBlock = /^\s*source\s*\(?\s*["']([^"']+)["']\s*\)?\s+do\b/.exec(line);
    if (sourceBlock?.[1]) {
      stack.push({
        groups: [],
        ...(/rubygems\.org/.test(sourceBlock[1]) ? {} : { source: "private-index" as const }),
      });
      continue;
    }
    if (/^\s*end\b/.test(line)) {
      stack.pop();
      continue;
    }
    const gem = /^\s*gem\s*\(?\s*["']([^"']+)["'](.*)$/.exec(line);
    if (gem?.[1]) {
      const rest = gem[2] ?? "";
      // Positional strings before the first keyword argument are requirements.
      const positional = rest.split(/,\s*\w+:/)[0] ?? "";
      const requirements = [...positional.matchAll(/["']([^"']+)["']/g)]
        .map((m) => (m[1] ?? "").trim())
        .filter((r) => /^(?:[~><=!]+\s*)?\d/.test(r));
      const inline = /\bgroups?:\s*(\[[^\]]*\]|:\w+)/.exec(rest)?.[1];
      const own: GemfileGem["source"] = /\b(?:git|github|gist|bitbucket):/.test(rest)
        ? "git"
        : /\bpath:/.test(rest)
          ? "path"
          : /\bsource:\s*["'](?![^"']*rubygems\.org)/.test(rest)
            ? "private-index"
            : undefined;
      const source = own ?? stack.findLast((b) => b.source)?.source;
      gems.set(gem[1], {
        groups: [...stack.flatMap((b) => b.groups), ...(inline ? names(inline) : [])],
        ...(requirements.length ? { requirement: requirements.join(", ") } : {}),
        ...(source ? { source } : {}),
      });
    }
    // Any other block opener (`do`, or `if`/`unless`/`case`/`begin`/`while`/`until` starting a line)
    // is closed by its own `end`; a trailing `if` modifier opens nothing.
    if (/\bdo(\s*\|[^|]*\|)?\s*$/.test(line) || /^\s*(?:if|unless|case|begin|while|until)\b/.test(line))
      stack.push({ groups: [] });
  }
  return gems;
}

/** Gems declared inside `group … do … end` blocks of a Gemfile, by name. */
export function gemfileGroups(text: string) {
  return new Map([...gemfileGems(text)].map(([name, g]) => [name, g.groups]));
}

function scopeOf(groups: string[] | undefined): DependencyInstance["scope"] {
  if (!groups?.length || groups.includes("default") || groups.includes("production")) return "prod";
  return groups.every((g) => g === "test") ? "test" : "dev";
}

export function readRubyInventory(tree: RepoTree): RubyProject[] {
  const projects: RubyProject[] = [];
  const gemfiles = tree
    .files()
    .filter(
      (f) =>
        /(?:^|\/)(?:Gemfile|gems\.rb)$/.test(f) &&
        !/(?:^|\/)(?:vendor|node_modules|spec\/fixtures|test\/fixtures)\//.test(f),
    );
  for (const manifest of gemfiles) {
    const root = dirname(manifest);
    const lockPath = manifest.endsWith("gems.rb") ? join(root, "gems.locked") : `${manifest}.lock`;
    const lockText = tree.read(lockPath);
    const declared = gemfileGems(tree.read(manifest) ?? "");
    const groups = new Map([...declared].map(([name, g]) => [name, g.groups]));
    const notes: string[] = [];
    const instances: DependencyInstance[] = [];
    const lock = lockText !== null ? parseGemfileLock(lockText) : null;
    if (!lock) notes.push("no Gemfile.lock: direct gems are unresolved ranges");
    const directNames = new Set(lock ? lock.dependencies.map((d) => d.name) : [...groups.keys()]);
    const specOf = (name: string) =>
      lock?.specs.find((s) => s.name === name && s.platform === "ruby") ??
      lock?.specs.find((s) => s.name === name);
    for (const name of directNames) {
      const dep = lock?.dependencies.find((d) => d.name === name);
      const spec = specOf(name);
      const type = spec?.source.type;
      // Without a lock, where the gem comes from and its range are the Gemfile's own (D-18).
      const own = declared.get(name);
      const source =
        type === "GIT"
          ? "git"
          : type === "PATH"
            ? "path"
            : spec?.source.remote && !/rubygems\.org/.test(spec.source.remote)
              ? "private-index"
              : !lock && own?.source
                ? own.source
                : "registry";
      const requirement = dep?.requirement ?? (!lock ? own?.requirement : undefined);
      const parsed = dependencyInstance.safeParse({
        ecosystem: "rubygems",
        name,
        version: spec && source === "registry" ? spec.version : null,
        ...(requirement && requirement !== ">= 0" ? { declaredRange: requirement } : {}),
        direct: true,
        scope: scopeOf(groups.get(name)),
        workspace: root,
        manifestPath: manifest,
        ...(lockText !== null ? { lockfilePath: lockPath } : {}),
        source,
        ...(type === "GIT" && spec?.source.remote ? { sourceRef: spec.source.remote } : {}),
        resolvedBy: spec && source === "registry" ? "lockfile" : "unresolved",
        ...(!spec
          ? { unresolvedReason: lock ? "not in Gemfile.lock" : "no Gemfile.lock" }
          : source !== "registry"
            ? { unresolvedReason: `a ${type} source, not rubygems.org` }
            : {}),
      });
      if (parsed.success) instances.push(parsed.data);
    }
    const seen = new Set(instances.map((i) => i.name));
    for (const spec of lock?.specs ?? []) {
      if (seen.has(spec.name) || spec.source.type !== "GEM") continue;
      seen.add(spec.name);
      const parsed = dependencyInstance.safeParse({
        ecosystem: "rubygems",
        name: spec.name,
        version: spec.version,
        direct: false,
        scope: "prod",
        workspace: root,
        manifestPath: manifest,
        lockfilePath: lockPath,
        source: "registry",
        resolvedBy: "lockfile",
        ...(spec.platform !== "ruby" ? { environment: { platform: spec.platform } } : {}),
      });
      if (parsed.success) instances.push(parsed.data);
    }
    const dotRuby =
      tree
        .read(join(root, ".ruby-version"))
        ?.trim()
        .replace(/^ruby-/, "") ?? null;
    projects.push({
      root,
      manager: "bundler",
      lockfile: lockText !== null ? lockPath : null,
      lockfileVersion: lock?.bundledWith ?? null,
      manifest,
      instances,
      rubyVersion: dotRuby ?? lock?.rubyVersion?.replace(/p\d+$/, "") ?? null,
      platforms: lock?.platforms ?? [],
      notes,
    });
  }
  return projects;
}
