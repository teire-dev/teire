import { dirname, join, normalize } from "node:path";
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
  /** The Ruby the project runs on: `.ruby-version`, the Gemfile's `ruby`, then the lockfile's. */
  rubyVersion: string | null;
  /**
   * A gem's lowest supported Ruby, from its gemspec's `required_ruby_version` (D-39): its runtime
   * dependencies must still install there, whatever Ruby its own development uses.
   */
  rubyFloor: string | null;
  /** Gemspecs whose runtime requirements widen (S18.5: a published gem), set by the scan. */
  widen?: string[];
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
  /** The file that declares it, for a gem from an `eval_gemfile`d file (S18.4). */
  file?: string;
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
/** The lowest version a Ruby requirement allows: `~> 3.2` and `>= 3.2` → `3.2`; `< 4` alone → null. */
function requirementFloor(requirement: string) {
  return /^\s*(?:~>|>=|=|>)?\s*(\d+(?:\.\d+)*)\s*$/.exec(requirement)?.[1] ?? null;
}

/**
 * The Gemfile's `ruby` (D-39): `ruby "3.2.2"`, `ruby "~> 3.2"` (its floor), or `ruby file:
 * ".ruby-version"` read through `read`.
 */
export function gemfileRuby(text: string, read: (path: string) => string | null) {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const file = /^ruby\s*\(?\s*file:\s*["']([^"']+)["']/.exec(line)?.[1];
    if (file)
      return (
        read(file)
          ?.trim()
          .replace(/^ruby-/, "") || null
      );
    const requirement = /^ruby\s*\(?\s*["']([^"']+)["']/.exec(line)?.[1];
    if (requirement) return requirementFloor(requirement);
  }
  return null;
}

/** A gemspec's `required_ruby_version` floor: `">= 3.0"`, `Gem::Requirement.new(">= 2.7")`, `[">= 2.7", "< 4"]`. */
export function gemspecRubyFloor(text: string) {
  const value = /required_ruby_version\s*=\s*([^\n]+)/.exec(text)?.[1] ?? "";
  const floors = [...value.matchAll(/["']([^"']+)["']/g)]
    .map((m) => requirementFloor(m[1] as string))
    .filter((v): v is string => Boolean(v));
  return floors[0] ?? null;
}

/**
 * Files a Gemfile evaluates (S18.4): `eval_gemfile "x"`, `eval_gemfile File.expand_path("x", __dir__)`
 * and `File.join(__dir__, "x")`, relative to the Gemfile. A computed path is left out.
 */
export function evalGemfiles(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    const m =
      /^\s*eval_gemfile\s*\(?\s*["']([^"'#{}]+)["']/.exec(line) ??
      /^\s*eval_gemfile\s*\(?\s*File\.(?:expand_path|join)\(\s*(?:__dir__\s*,\s*)?["']([^"'#{}]+)["']/.exec(
        line,
      );
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** A Gemfile's gems with the files it evaluates followed inside the repo; the first declaration wins. */
export function gemfileGemsIn(tree: RepoTree, manifest: string, seen = new Set<string>()) {
  const out = new Map<string, GemfileGem>();
  const text = tree.read(manifest);
  if (text === null || seen.has(manifest) || seen.size > 10) return out;
  seen.add(manifest);
  for (const [name, gem] of gemfileGems(text)) out.set(name, { ...gem, file: manifest });
  for (const rel of evalGemfiles(text)) {
    const path = normalize(join(dirname(manifest), rel));
    if (path.startsWith("..")) continue;
    for (const [name, gem] of gemfileGemsIn(tree, path, seen)) if (!out.has(name)) out.set(name, gem);
  }
  return out;
}

/** A gemspec's `add_dependency`, `add_runtime_dependency` and `add_development_dependency` lines. */
export function gemspecDependencies(text: string) {
  const out: { name: string; requirement?: string; development: boolean }[] = [];
  for (const m of text.matchAll(
    /\.add_(runtime_|development_)?dependency\s*\(?\s*["']([\w.-]+)["']((?:\s*,\s*["'][^"']+["'])*)/g,
  )) {
    const requirements = [...(m[3] ?? "").matchAll(/["']([^"']+)["']/g)].map((r) => r[1] as string);
    out.push({
      name: m[2] as string,
      ...(requirements.length ? { requirement: requirements.join(", ") } : {}),
      development: m[1] === "development_",
    });
  }
  return out;
}

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
    const declared = gemfileGemsIn(tree, manifest);
    const groups = new Map([...declared].map(([name, g]) => [name, g.groups]));
    // `gemspec` in the Gemfile: the gem's own dependencies are direct ones, declared in its gemspec.
    const gemspecs = /^\s*gemspec\b/m.test(tree.read(manifest) ?? "")
      ? tree.files().filter((f) => dirname(f) === root && f.endsWith(".gemspec"))
      : [];
    const specDeps = new Map(
      gemspecs.flatMap((path) =>
        gemspecDependencies(tree.read(path) ?? "").map((d) => [d.name, { ...d, path }] as const),
      ),
    );
    const notes: string[] = [];
    const instances: DependencyInstance[] = [];
    const lock = lockText !== null ? parseGemfileLock(lockText) : null;
    if (!lock) notes.push("no Gemfile.lock: direct gems are unresolved ranges");
    const directNames = new Set([
      ...(lock ? lock.dependencies.map((d) => d.name) : [...groups.keys()]),
      ...specDeps.keys(),
    ]);
    const specOf = (name: string) =>
      lock?.specs.find((s) => s.name === name && s.platform === "ruby") ??
      lock?.specs.find((s) => s.name === name);
    for (const name of directNames) {
      const dep = lock?.dependencies.find((d) => d.name === name);
      const spec = specOf(name);
      const type = spec?.source.type;
      // Without a lock, where the gem comes from and its range are the Gemfile's own (D-18).
      const own = declared.get(name);
      const fromSpec = specDeps.get(name);
      const source =
        type === "GIT"
          ? "git"
          : type === "PATH"
            ? // The repo's own gem (`gemspec`, `remote: .`) is the project, not a dependency.
              spec?.source.remote === "."
              ? "workspace"
              : "path"
            : spec?.source.remote && !/rubygems\.org/.test(spec.source.remote)
              ? "private-index"
              : !lock && own?.source
                ? own.source
                : "registry";
      const requirement = dep?.requirement ?? (!lock ? own?.requirement : undefined) ?? fromSpec?.requirement;
      const parsed = dependencyInstance.safeParse({
        ecosystem: "rubygems",
        name,
        version: spec && source === "registry" ? spec.version : null,
        ...(requirement && requirement !== ">= 0" ? { declaredRange: requirement } : {}),
        direct: true,
        scope:
          fromSpec && !groups.has(name) ? (fromSpec.development ? "dev" : "prod") : scopeOf(groups.get(name)),
        workspace: root,
        manifestPath: own?.file ?? (fromSpec && !own ? fromSpec.path : manifest),
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
        .replace(/^ruby-/, "") || null;
    const gemfileRubyVersion = gemfileRuby(tree.read(manifest) ?? "", (p) => tree.read(join(root, p)));
    const gemspec = tree.files().find((f) => f.endsWith(".gemspec") && dirname(f) === root);
    const rubyFloor = gemspec ? gemspecRubyFloor(tree.read(gemspec) ?? "") : null;
    projects.push({
      root,
      manager: "bundler",
      lockfile: lockText !== null ? lockPath : null,
      lockfileVersion: lock?.bundledWith ?? null,
      manifest,
      instances,
      rubyVersion: dotRuby ?? gemfileRubyVersion ?? lock?.rubyVersion?.replace(/p\d+$/, "") ?? null,
      rubyFloor,
      platforms: lock?.platforms ?? [],
      notes,
    });
  }
  return projects;
}
