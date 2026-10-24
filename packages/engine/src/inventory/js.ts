import { posix } from "node:path";
import { parseSyml } from "@yarnpkg/parsers";
import { parse as parseJsonc } from "jsonc-parser";
import YAML from "yaml";
import type { DependencyInstance } from "../contract";
import type { RepoTree } from "./tree";

/**
 * JavaScript/TypeScript inventory: exact versions per importer (workspace) from the repo's own
 * lockfile, never guessed (rule 12). Formats and normalisation rules were verified on npm v1/v2/v3,
 * pnpm 5.4/6.0/9.0 (incl. the two-document file), yarn v1 and berry, and bun.lock
 * (context/09-build-research/generic/js-ts.md §1).
 */
export type JsManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export interface JsProject {
  /** Directory holding the root package.json and lockfile ("." for the repo root). */
  root: string;
  manager: JsManager;
  /** From `packageManager` / `devEngines.packageManager`, used to run the exact same tool later. */
  managerVersion?: string;
  lockfile?: string;
  lockfileVersion?: string;
  importers: string[];
  instances: DependencyInstance[];
  notes: string[];
}

type Scope = DependencyInstance["scope"];

interface Declared {
  name: string;
  range: string;
  scope: Scope;
}

interface Resolved {
  version: string | null;
  registryName?: string;
  /** Workspace path for `link:` / `workspace:` dependencies. */
  workspace?: string;
}

const SECTIONS: [string, Scope][] = [
  ["dependencies", "prod"],
  ["devDependencies", "dev"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"],
];

const LOCKFILES: [string, JsManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const join = (dir: string, file: string) => (dir === "." || dir === "" ? file : `${dir}/${file}`);

function readJson<T>(tree: RepoTree, path: string): T | null {
  const text = tree.read(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface PackageJson {
  name?: string;
  packageManager?: string;
  devEngines?: { packageManager?: { name?: string; version?: string } };
  workspaces?: string[] | { packages?: string[] };
  [section: string]: unknown;
}

function declaredDeps(manifest: PackageJson | null): Declared[] {
  if (!manifest) return [];
  const out: Declared[] = [];
  for (const [section, scope] of SECTIONS) {
    const deps = manifest[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range === "string") out.push({ name, range, scope });
    }
  }
  return out;
}

/** `pnpm@9.15.0+sha512...` → { name, version }. */
function packageManagerOf(manifest: PackageJson | null) {
  const field = manifest?.packageManager;
  if (typeof field === "string") {
    const match = /^(npm|pnpm|yarn|bun)@([^+\s]+)/.exec(field);
    if (match) return { name: match[1] as JsManager, version: match[2] };
  }
  const dev = manifest?.devEngines?.packageManager;
  if (dev?.name) return { name: dev.name as JsManager, version: dev.version };
  return null;
}

function sourceOf(range: string): DependencyInstance["source"] {
  if (/^(workspace:|link:)/.test(range)) return "workspace";
  if (/^(file:|\.\.?\/|portal:)/.test(range)) return "path";
  if (
    /^(git\+|git:|github:|gitlab:|bitbucket:|https?:\/\/.*\.git)/.test(range) ||
    /^[\w-]+\/[\w.-]+(#.*)?$/.test(range)
  )
    return "git";
  return "registry";
}

/** `npm:strip-ansi@^6.0.1` → `strip-ansi`. */
function aliasTarget(range: string) {
  const match = /^npm:((?:@[^/]+\/)?[^@]+)@/.exec(range);
  return match?.[1];
}

/** Splits `name@version` where the name may be scoped (`@scope/pkg@1.0.0`). */
function splitNameVersion(spec: string): { name: string; version: string } | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function globToRegExp(glob: string) {
  const escaped = glob
    .replace(/\/+$/, "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]+")
    .replace(/\u0000/g, "(?:.+/)?");
  return new RegExp(`^${escaped}$`);
}

/** Workspace directories matched by package.json `workspaces` globs (yarn v1 has none in its lockfile). */
function workspaceDirs(tree: RepoTree, root: string, manifest: PackageJson | null) {
  const globs = Array.isArray(manifest?.workspaces)
    ? manifest.workspaces
    : (manifest?.workspaces?.packages ?? []);
  if (globs.length === 0) return [];
  const prefix = root === "." ? "" : `${root}/`;
  const include = globs.filter((g) => !g.startsWith("!")).map(globToRegExp);
  const exclude = globs.filter((g) => g.startsWith("!")).map((g) => globToRegExp(g.slice(1)));
  return tree
    .files()
    .filter((f) => f.endsWith("/package.json") && f.startsWith(prefix) && !f.includes("node_modules/"))
    .map((f) => f.slice(prefix.length, -"/package.json".length))
    .filter((dir) => include.some((r) => r.test(dir)) && !exclude.some((r) => r.test(dir)))
    .sort();
}

// --- npm -----------------------------------------------------------------------------------

interface NpmLock {
  lockfileVersion?: number;
  packages?: Record<
    string,
    { version?: string; name?: string; link?: boolean; resolved?: string; dev?: boolean; optional?: boolean }
  >;
  dependencies?: Record<string, { version?: string; dev?: boolean }>;
}

function npmResolver(lock: NpmLock) {
  const packages = lock.packages;
  if (packages) {
    const importers = Object.keys(packages).filter((key) => !key.split("/").includes("node_modules"));
    const resolve = (importer: string, name: string): Resolved => {
      // Node's module resolution: <importer>/node_modules/<name>, then each parent, then the root.
      const parts = importer === "" ? [] : importer.split("/");
      for (let i = parts.length; i >= 0; i--) {
        const base = parts.slice(0, i).join("/");
        const entry = packages[base ? `${base}/node_modules/${name}` : `node_modules/${name}`];
        if (!entry) continue;
        if (entry.link) return { version: null, workspace: entry.resolved ?? "" };
        return {
          version: entry.version ?? null,
          registryName: entry.name && entry.name !== name ? entry.name : undefined,
        };
      }
      return { version: null };
    };
    const transitive = Object.entries(packages)
      .filter(([key, entry]) => key.includes("node_modules/") && !entry.link && entry.version)
      .map(([key, entry]) => ({
        name: entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length),
        version: entry.version as string,
        scope: (entry.dev ? "dev" : entry.optional ? "optional" : "prod") as Scope,
      }));
    return { importers: importers.map((k) => k || "."), resolve, transitive };
  }
  // lockfileVersion 1: one flat `dependencies` tree for the root importer only.
  const deps = lock.dependencies ?? {};
  const resolve = (_importer: string, name: string): Resolved => {
    const version = deps[name]?.version;
    if (!version) return { version: null };
    const alias = /^npm:(.+)$/.exec(version);
    if (alias) {
      const target = splitNameVersion(alias[1] ?? "");
      return { version: target?.version ?? null, registryName: target?.name };
    }
    return { version };
  };
  const transitive = Object.entries(deps)
    .filter(([, d]) => d.version && !d.version.startsWith("npm:"))
    .map(([name, d]) => ({ name, version: d.version as string, scope: (d.dev ? "dev" : "prod") as Scope }));
  return { importers: ["."], resolve, transitive };
}

// --- pnpm ----------------------------------------------------------------------------------

type PnpmDep = string | { specifier?: string; version?: string };
interface PnpmImporter {
  specifiers?: Record<string, string>;
  dependencies?: Record<string, PnpmDep>;
  devDependencies?: Record<string, PnpmDep>;
  optionalDependencies?: Record<string, PnpmDep>;
}
interface PnpmLock extends PnpmImporter {
  lockfileVersion?: string | number;
  importers?: Record<string, PnpmImporter>;
  packages?: Record<string, unknown>;
}

/** pnpm version strings: `4.104.0(zod@3.25.76)`, `4.104.0_zod@3.25.76`, aliases and `link:`. */
function parsePnpmVersion(raw: string): Resolved {
  if (raw.startsWith("link:")) return { version: null, workspace: raw.slice(5) };
  let value = raw.replace(/\(.*$/, "");
  const leadingSlash = value.startsWith("/");
  if (leadingSlash) value = value.slice(1);
  // A plain version, possibly with a pnpm 5.x peer suffix: `4.104.0_zod@3.25.76`.
  if (!leadingSlash && /^\d/.test(value)) return { version: value.split("_")[0] ?? null };
  // pnpm 5.x alias form `/name/1.2.3`, possibly scoped `/@s/name/1.2.3`.
  if (leadingSlash && !value.slice(1).includes("@")) {
    const cut = value.lastIndexOf("/");
    return { version: value.slice(cut + 1).split("_")[0] ?? null, registryName: value.slice(0, cut) };
  }
  if (value.lastIndexOf("@") > 0) {
    const spec = splitNameVersion(value);
    if (spec) return { version: spec.version.split("_")[0] ?? null, registryName: spec.name };
  }
  return { version: value.split("_")[0] ?? null };
}

/** pnpm packages keys: `name@1.0.0` (9.0), `/name@1.0.0(peer)` (6.0), `/name/1.0.0_peer` (5.x). */
function parsePnpmPackageKey(key: string) {
  const value = key.replace(/\(.*$/, "").replace(/^\//, "");
  const at = value.lastIndexOf("@");
  if (at > 0) return { name: value.slice(0, at), version: value.slice(at + 1).split("_")[0] ?? "" };
  const cut = value.lastIndexOf("/");
  return cut > 0 ? { name: value.slice(0, cut), version: value.slice(cut + 1).split("_")[0] ?? "" } : null;
}

function pnpmResolver(text: string) {
  // pnpm 11 can write two YAML documents (an env document, then the lockfile).
  const docs = YAML.parseAllDocuments(text).map((d) => d.toJS() as PnpmLock | null);
  const lock = docs.find((d) => d?.importers || d?.dependencies || d?.packages) ?? docs.at(-1) ?? {};
  const importers: Record<string, PnpmImporter> = lock.importers ?? { ".": lock };
  const resolve = (importer: string, name: string): Resolved => {
    const entry = importers[importer];
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      const dep = entry?.[section]?.[name];
      if (dep === undefined) continue;
      const resolved = parsePnpmVersion(typeof dep === "string" ? dep : (dep.version ?? ""));
      // `link:` paths are relative to the importer.
      if (resolved.workspace !== undefined)
        resolved.workspace = posix.normalize(posix.join(importer, resolved.workspace));
      return resolved;
    }
    return { version: null };
  };
  const transitive = Object.keys(lock.packages ?? {})
    .map(parsePnpmPackageKey)
    .filter((p): p is { name: string; version: string } => Boolean(p?.version))
    .map((p) => ({ ...p, scope: "prod" as Scope }));
  return {
    importers: Object.keys(importers),
    resolve,
    transitive,
    lockfileVersion: String(lock.lockfileVersion ?? ""),
  };
}

/** pnpm importers declare their own ranges; use them instead of reading each package.json. */
function pnpmDeclared(text: string, importer: string): Declared[] {
  const docs = YAML.parseAllDocuments(text).map((d) => d.toJS() as PnpmLock | null);
  const lock = docs.find((d) => d?.importers || d?.dependencies || d?.packages) ?? {};
  const entry: PnpmImporter = (lock.importers ?? { ".": lock })[importer] ?? {};
  const out: Declared[] = [];
  for (const [section, scope] of SECTIONS) {
    const deps = entry[section as keyof PnpmImporter] as Record<string, PnpmDep> | undefined;
    for (const [name, dep] of Object.entries(deps ?? {})) {
      const range =
        typeof dep === "string" ? (entry.specifiers?.[name] ?? dep) : (dep.specifier ?? dep.version ?? "");
      out.push({ name, range, scope });
    }
  }
  return out;
}

// --- yarn ----------------------------------------------------------------------------------

interface YarnEntry {
  version?: string;
  resolution?: string;
}

function yarnResolver(text: string) {
  const parsed = parseSyml(text) as Record<string, YarnEntry>;
  const berry = "__metadata" in parsed;
  const byDescriptor = new Map<string, YarnEntry>();
  for (const [key, entry] of Object.entries(parsed)) {
    if (key === "__metadata") continue;
    for (const descriptor of key.split(/,\s*/)) byDescriptor.set(descriptor.trim(), entry);
  }
  const workspacePaths = berry
    ? [
        ...new Set(
          [...byDescriptor.values()]
            .map((e) => /@workspace:(.+)$/.exec(e.resolution ?? "")?.[1])
            .filter((p): p is string => Boolean(p)),
        ),
      ]
    : [];
  const resolve = (_importer: string, name: string, range: string): Resolved => {
    const protocol = /^[a-z]+:/.test(range) ? range : berry ? `npm:${range}` : range;
    const entry = byDescriptor.get(`${name}@${protocol}`) ?? byDescriptor.get(`${name}@${range}`);
    if (entry?.resolution?.includes("@workspace:"))
      return { version: null, workspace: entry.resolution.split("@workspace:")[1] };
    if (range.startsWith("workspace:")) return { version: null, workspace: range.slice("workspace:".length) };
    if (!entry?.version) return { version: null };
    const target =
      aliasTarget(range) ??
      (entry.resolution ? /^((?:@[^/]+\/)?[^@]+)@/.exec(entry.resolution)?.[1] : undefined);
    return { version: entry.version, registryName: target && target !== name ? target : undefined };
  };
  const seen = new Set<string>();
  const transitive: { name: string; version: string; scope: Scope }[] = [];
  for (const [key, entry] of Object.entries(parsed)) {
    if (key === "__metadata" || !entry.version || entry.resolution?.includes("@workspace:")) continue;
    const first = key.split(/,\s*/)[0] ?? "";
    const local = /^((?:@[^/]+\/)?[^@]+)@/.exec(first)?.[1];
    const target = aliasTarget(first.slice((local?.length ?? 0) + 1)) ?? local;
    const name = entry.resolution ? (/^((?:@[^/]+\/)?[^@]+)@/.exec(entry.resolution)?.[1] ?? target) : target;
    if (!name || seen.has(`${name}@${entry.version}`)) continue;
    seen.add(`${name}@${entry.version}`);
    transitive.push({ name, version: entry.version, scope: "prod" });
  }
  const metadata = parsed.__metadata as { version?: string | number } | undefined;
  return {
    berry,
    workspacePaths,
    resolve,
    transitive,
    lockfileVersion: berry ? String(metadata?.version ?? "") : "1",
  };
}

// --- bun -----------------------------------------------------------------------------------

interface BunLock {
  lockfileVersion?: number;
  workspaces?: Record<string, { name?: string } & Record<string, unknown>>;
  packages?: Record<string, unknown[]>;
}

function bunResolver(text: string) {
  const lock = (parseJsonc(text, [], { allowTrailingComma: true }) ?? {}) as BunLock;
  const workspaces = lock.workspaces ?? {};
  const packages = lock.packages ?? {};
  const resolve = (importer: string, name: string): Resolved => {
    const wsName = workspaces[importer === "." ? "" : importer]?.name;
    const entry = (wsName ? packages[`${wsName}/${name}`] : undefined) ?? packages[name];
    const spec = typeof entry?.[0] === "string" ? (entry[0] as string) : null;
    if (!spec) return { version: null };
    const workspace = /@workspace:(.+)$/.exec(spec)?.[1];
    if (workspace) return { version: null, workspace };
    const parsed = splitNameVersion(spec);
    return {
      version: parsed?.version ?? null,
      registryName: parsed && parsed.name !== name ? parsed.name : undefined,
    };
  };
  const seen = new Set<string>();
  const transitive: { name: string; version: string; scope: Scope }[] = [];
  for (const entry of Object.values(packages)) {
    const spec = typeof entry?.[0] === "string" ? (entry[0] as string) : "";
    if (spec.includes("@workspace:")) continue;
    const parsed = splitNameVersion(spec);
    if (!parsed || seen.has(spec)) continue;
    seen.add(spec);
    transitive.push({ ...parsed, scope: "prod" });
  }
  const importers = Object.keys(workspaces).map((k) => k || ".");
  return { importers, resolve, transitive, lockfileVersion: String(lock.lockfileVersion ?? "") };
}

// --- projects ------------------------------------------------------------------------------

/** Every directory with a package.json and a lockfile is its own project; the repo root always is. */
export function findJsProjectRoots(tree: RepoTree) {
  const roots = new Set<string>();
  for (const file of tree.files()) {
    if (file.includes("node_modules/") || file.includes("/vendor/")) continue;
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (!LOCKFILES.some(([lock]) => lock === name) && name !== "bun.lockb") continue;
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    if (tree.read(join(dir, "package.json")) !== null) roots.add(dir);
  }
  if (tree.read("package.json") !== null) roots.add(".");
  return [...roots].sort();
}

export function readJsProject(tree: RepoTree, root: string): JsProject {
  const notes: string[] = [];
  const manifest = readJson<PackageJson>(tree, join(root, "package.json"));
  const declaredPm = packageManagerOf(manifest);
  const lock = LOCKFILES.find(([file]) => tree.read(join(root, file)) !== null);
  const lockfile = lock ? join(root, lock[0]) : undefined;
  const manager: JsManager = lock?.[1] ?? declaredPm?.name ?? "unknown";
  const project: JsProject = {
    root,
    manager,
    managerVersion: declaredPm?.name === manager ? declaredPm.version : undefined,
    lockfile,
    importers: [],
    instances: [],
    notes,
  };

  const unresolved = (reason: string) => {
    notes.push(reason);
    const importers = [".", ...workspaceDirs(tree, root, manifest)];
    project.importers = importers;
    for (const importer of importers) {
      const dir = importer === "." ? root : join(root, importer);
      for (const dep of declaredDeps(readJson<PackageJson>(tree, join(dir, "package.json")))) {
        project.instances.push(
          instance(dep, { version: null }, importer, join(dir, "package.json"), undefined, reason),
        );
      }
    }
    return project;
  };

  if (!lock || !lockfile) {
    return unresolved(
      tree.read(join(root, "bun.lockb")) !== null ? "binary bun.lockb (not readable)" : "no lockfile",
    );
  }

  const text = tree.read(lockfile) ?? "";
  let resolver: {
    importers: string[];
    resolve: (importer: string, name: string, range: string) => Resolved;
    transitive: { name: string; version: string; scope: Scope }[];
  };
  let declaredFor: (importer: string) => Declared[];
  try {
    if (manager === "pnpm") {
      const r = pnpmResolver(text);
      resolver = r;
      project.lockfileVersion = r.lockfileVersion;
      declaredFor = (importer) => pnpmDeclared(text, importer);
    } else if (manager === "yarn") {
      const r = yarnResolver(text);
      const importers = r.berry ? r.workspacePaths : [".", ...workspaceDirs(tree, root, manifest)];
      resolver = { ...r, importers: importers.length ? importers : ["."] };
      project.lockfileVersion = r.lockfileVersion;
      declaredFor = (importer) =>
        declaredDeps(
          readJson<PackageJson>(tree, join(root === "." ? importer : join(root, importer), "package.json")),
        );
    } else if (manager === "bun") {
      const r = bunResolver(text);
      resolver = r;
      project.lockfileVersion = r.lockfileVersion;
      declaredFor = (importer) =>
        declaredDeps(
          readJson<PackageJson>(tree, join(root === "." ? importer : join(root, importer), "package.json")),
        );
    } else {
      const parsed = JSON.parse(text) as NpmLock;
      const r = npmResolver(parsed);
      resolver = { ...r, resolve: (importer, name) => r.resolve(importer === "." ? "" : importer, name) };
      project.lockfileVersion = String(parsed.lockfileVersion ?? "");
      declaredFor = (importer) =>
        declaredDeps(
          readJson<PackageJson>(tree, join(root === "." ? importer : join(root, importer), "package.json")),
        );
    }
  } catch (error) {
    return unresolved(`unreadable ${lock[0]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  project.importers = resolver.importers;
  // Workspace packages by name: yarn v1 records no workspace entries, so a dependency on one is
  // recognised by its package name.
  const workspaceByName = new Map<string, string>();
  for (const importer of resolver.importers) {
    const name = readJson<PackageJson>(
      tree,
      join(importer === "." ? root : join(root, importer), "package.json"),
    )?.name;
    if (name) workspaceByName.set(name, importer);
  }
  for (const importer of resolver.importers) {
    const manifestPath = join(importer === "." ? root : join(root, importer), "package.json");
    for (const dep of declaredFor(importer)) {
      let resolved = resolver.resolve(importer, dep.name, dep.range);
      const ws = workspaceByName.get(dep.name);
      if (resolved.version === null && resolved.workspace === undefined && ws)
        resolved = { version: null, workspace: ws };
      const reason = resolved.version === null && !resolved.workspace ? `not in ${lock[0]}` : undefined;
      project.instances.push(instance(dep, resolved, importer, manifestPath, lockfile, reason));
    }
  }
  for (const t of resolver.transitive) {
    project.instances.push({
      ecosystem: "npm",
      name: t.name,
      version: t.version,
      direct: false,
      scope: t.scope,
      workspace: ".",
      manifestPath: lockfile,
      lockfilePath: lockfile,
      source: "registry",
      resolvedBy: "lockfile",
    });
  }
  return project;
}

function instance(
  dep: Declared,
  resolved: Resolved,
  importer: string,
  manifestPath: string,
  lockfile: string | undefined,
  unresolvedReason: string | undefined,
): DependencyInstance {
  const registryName = resolved.registryName ?? aliasTarget(dep.range);
  const source = resolved.workspace !== undefined ? "workspace" : sourceOf(dep.range);
  const out: DependencyInstance = {
    ecosystem: "npm",
    name: registryName ?? dep.name,
    version: resolved.version,
    declaredRange: dep.range,
    direct: true,
    scope: dep.scope,
    workspace: importer,
    manifestPath,
    source,
    resolvedBy: resolved.version !== null ? "lockfile" : source === "workspace" ? "lockfile" : "unresolved",
  };
  if (registryName && registryName !== dep.name) out.aliasName = dep.name;
  if (lockfile) out.lockfilePath = lockfile;
  if (resolved.workspace !== undefined) out.sourceRef = resolved.workspace;
  if (unresolvedReason && out.resolvedBy === "unresolved") out.unresolvedReason = unresolvedReason;
  return out;
}

export function readJsInventory(tree: RepoTree) {
  return findJsProjectRoots(tree).map((root) => readJsProject(tree, root));
}
