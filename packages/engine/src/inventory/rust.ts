import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type DependencyInstance, dependencyInstance } from "../contract";
import { allFiles, type RepoTree } from "./tree";

/**
 * Cargo inventory (plan S06, research rust.md Job 1): parsed as TOML in the worker, never by
 * running cargo (a repo's `.cargo/config.toml` can make cargo run its own programs). Every workspace
 * member's `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]` and target-specific tables;
 * `workspace = true` inherits the root's `[workspace.dependencies]`; `package = "…"` renames. The
 * exact version comes from Cargo.lock (formats v1–v4); a crate locked at two versions resolves by
 * the member's own dependency list. No lockfile: "unresolved", with the declared requirement.
 */
export interface RustProject {
  /** Directory of the workspace root (or the lone package). */
  root: string;
  manager: "cargo";
  lockfile: string | null;
  lockfileVersion: string | null;
  manifest: string;
  instances: DependencyInstance[];
  /** Member package names → manifest path. */
  members: { name: string; manifest: string }[];
  /** `rust-version` (MSRV) of the root package or workspace, when declared. */
  rustVersion: string | null;
  /**
   * Cargo's `incompatible-rust-versions` (S18.4): `fallback` (resolver 3, edition 2024, or set in
   * `.cargo/config.toml`) keeps dependencies within the MSRV; `allow` lets a target raise it.
   */
  msrvPolicy: "fallback" | "allow";
  notes: string[];
}

/**
 * `[patch.<registry>]` and `[replace]` entries of a workspace root (S18.4): crate → what replaces it
 * (`path ../serde`, `git https://…`). The replacement is what builds, so the crate isn't compared.
 */
export function cargoPatches(doc: Record<string, unknown>) {
  const out = new Map<string, string>();
  const describe = (spec: unknown) => {
    const t = (spec ?? {}) as Record<string, unknown>;
    if (typeof t.path === "string") return `path ${t.path}`;
    if (typeof t.git === "string")
      return `git ${t.git}${typeof t.rev === "string" ? `@${t.rev}` : typeof t.branch === "string" ? `#${t.branch}` : ""}`;
    if (typeof t.version === "string") return `version ${t.version}`;
    return null;
  };
  for (const table of Object.values((doc.patch ?? {}) as Record<string, Record<string, unknown>>))
    for (const [key, spec] of Object.entries(table ?? {})) {
      const crate =
        typeof (spec as Record<string, unknown>)?.package === "string"
          ? (spec as { package: string }).package
          : key;
      const what = describe(spec);
      if (what) out.set(crate, `[patch] ${what}`);
    }
  for (const [key, spec] of Object.entries((doc.replace ?? {}) as Record<string, unknown>)) {
    const what = describe(spec);
    if (what) out.set(key.split(":")[0] as string, `[replace] ${what}`);
  }
  return out;
}

type Table = Record<string, unknown>;

interface LockPackage {
  name: string;
  version: string;
  source?: string;
  dependencies?: string[];
}

const KINDS = [
  ["dependencies", "prod"],
  ["dev-dependencies", "dev"],
  ["build-dependencies", "build"],
] as const;

function readToml(tree: RepoTree, path: string): Table | null {
  const text = tree.read(path);
  if (text === null) return null;
  try {
    return parseToml(text) as Table;
  } catch {
    return null;
  }
}

/** Expands `crates/*` style member globs against the repo's files. */
function expandMembers(tree: RepoTree, root: string, patterns: string[], exclude: string[]) {
  const prefix = root === "." ? "" : `${root}/`;
  // Member globs see build-output folders too (D-21): a member may live in `build/` or `vendor/`.
  const manifests = allFiles(tree).filter((f) => f.endsWith("/Cargo.toml") || f === "Cargo.toml");
  const out = new Set<string>();
  for (const pattern of patterns) {
    // `*` is one folder, `**` any depth (D-24).
    const body = (prefix + pattern.replace(/\/$/, ""))
      .split("**")
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+"))
      .join(".+");
    const re = new RegExp(`^${body}/Cargo\\.toml$`);
    for (const m of manifests) if (re.test(m)) out.add(m);
  }
  return [...out].filter((m) => !exclude.some((e) => dirname(m) === join(root, e)));
}

/** Lockfile dependency entry: `name`, `name version` or `name version (source)`. */
function parseLockRef(ref: string) {
  const m = /^(\S+)(?:\s+(\S+))?(?:\s+\((.+)\))?$/.exec(ref.trim());
  return m ? { name: m[1] as string, version: m[2] ?? null, source: m[3] ?? null } : null;
}

export function readRustInventory(tree: RepoTree): RustProject[] {
  const roots = tree
    .files()
    .filter(
      (f) =>
        (f === "Cargo.toml" || f.endsWith("/Cargo.toml")) &&
        !/(?:^|\/)(?:target|vendor|tests?|examples?|fuzz)\//.test(f),
    )
    .map((f) => ({ path: f, doc: readToml(tree, f) }))
    .filter((m): m is { path: string; doc: Table } => m.doc !== null);
  // A manifest that is some workspace's member is read under that workspace, not on its own.
  const workspaces = roots.filter((m) => m.doc.workspace);
  const claimed = new Set<string>();
  const projects: RustProject[] = [];
  const order = [...workspaces, ...roots.filter((m) => !m.doc.workspace)];
  for (const top of order) {
    if (claimed.has(top.path)) continue;
    const root = dirname(top.path);
    const ws = (top.doc.workspace ?? {}) as Table;
    const memberPaths = top.doc.workspace
      ? expandMembers(tree, root, (ws.members as string[]) ?? [], (ws.exclude as string[]) ?? [])
      : [];
    const manifests = [...new Set([...(top.doc.package ? [top.path] : []), ...memberPaths])];
    // Cargo makes every path dependency inside the workspace a member too, transitively (D-24).
    if (top.doc.workspace) {
      const excluded = ((ws.exclude as string[]) ?? []).map((e) => join(root, e));
      const inside = (dir: string) => root === "." || dir === root || dir.startsWith(`${root}/`);
      const queue = [top.path, ...manifests];
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const doc = next === top.path ? top.doc : readToml(tree, next);
        if (!doc) continue;
        const tables = [
          doc.dependencies,
          doc["dev-dependencies"],
          doc["build-dependencies"],
          ...(next === top.path ? [ws.dependencies] : []),
          ...Object.values((doc.target ?? {}) as Table).flatMap((t) => {
            const target = t as Table;
            return [target.dependencies, target["dev-dependencies"], target["build-dependencies"]];
          }),
        ];
        for (const table of tables)
          for (const spec of Object.values((table ?? {}) as Table)) {
            const path = (spec as Table | null)?.path;
            if (typeof path !== "string") continue;
            const dir = join(dirname(next), path);
            const manifest = join(dir, "Cargo.toml");
            if (!inside(dir) || excluded.includes(dir) || manifests.includes(manifest)) continue;
            if (tree.read(manifest) === null) continue;
            manifests.push(manifest);
            queue.push(manifest);
          }
      }
    }
    for (const m of manifests) claimed.add(m);
    const inherited = (ws.dependencies ?? {}) as Table;
    const lockPath = join(root, "Cargo.lock");
    const lockText = tree.read(lockPath);
    let lock: { version: string | null; packages: LockPackage[] } | null = null;
    const notes: string[] = [];
    if (lockText !== null) {
      try {
        const doc = parseToml(lockText) as { version?: number; package?: LockPackage[]; metadata?: Table };
        lock = {
          version: doc.version ? String(doc.version) : doc.metadata ? "1" : "2",
          packages: doc.package ?? [],
        };
      } catch {
        notes.push("Cargo.lock did not parse");
      }
    } else notes.push("no Cargo.lock: versions are the declared requirements, unresolved");

    const members: RustProject["members"] = [];
    const instances: DependencyInstance[] = [];
    const patches = cargoPatches(top.doc);
    for (const manifest of manifests) {
      const doc = manifest === top.path ? top.doc : readToml(tree, manifest);
      if (!doc) continue;
      const pkg = (doc.package ?? {}) as Table;
      const memberName = typeof pkg.name === "string" ? pkg.name : dirname(manifest);
      members.push({ name: memberName, manifest });
      const lockedMember = lock?.packages.find((p) => p.name === memberName && !p.source);
      const tables: [string, Table][] = [];
      for (const [key, scope] of KINDS) tables.push([scope, (doc[key] ?? {}) as Table]);
      for (const target of Object.values((doc.target ?? {}) as Record<string, Table>))
        for (const [key, scope] of KINDS) tables.push([scope, (target[key] ?? {}) as Table]);
      for (const [scope, table] of tables)
        for (const [key, raw] of Object.entries(table)) {
          let spec: Table = typeof raw === "string" ? { version: raw } : ((raw ?? {}) as Table);
          if (spec.workspace === true) {
            const base = inherited[key];
            spec = { ...(typeof base === "string" ? { version: base } : ((base ?? {}) as Table)), ...spec };
          }
          const crate = typeof spec.package === "string" ? spec.package : key;
          const patch = !spec.path && !spec.git ? patches.get(crate) : undefined;
          const source = spec.path
            ? "path"
            : spec.git
              ? "git"
              : spec.registry
                ? "private-index"
                : patch && !patch.includes("] version ")
                  ? patch.includes("] path ")
                    ? "path"
                    : "git"
                  : "registry";
          // The member's own lock entry names exactly which locked version it uses.
          const ref = lockedMember?.dependencies?.map(parseLockRef).find((r) => r?.name === crate) ?? null;
          const candidates = lock?.packages.filter((p) => p.name === crate) ?? [];
          const locked = ref?.version
            ? candidates.find((p) => p.version === ref.version)
            : candidates.length === 1
              ? candidates[0]
              : undefined;
          const parsed = dependencyInstance.safeParse({
            ecosystem: "cargo",
            name: crate,
            ...(crate !== key ? { aliasName: key } : {}),
            version: source === "registry" || source === "private-index" ? (locked?.version ?? null) : null,
            ...(typeof spec.version === "string" ? { declaredRange: spec.version } : {}),
            direct: true,
            scope: spec.optional === true && scope === "prod" ? "optional" : scope,
            workspace: dirname(manifest),
            manifestPath: manifest,
            ...(lockText !== null ? { lockfilePath: lockPath } : {}),
            source,
            ...(typeof spec.git === "string"
              ? { sourceRef: spec.git }
              : typeof spec.registry === "string"
                ? { sourceRef: spec.registry }
                : patch
                  ? { sourceRef: patch }
                  : {}),
            resolvedBy:
              locked && (source === "registry" || source === "private-index") ? "lockfile" : "unresolved",
            ...(!locked || (source !== "registry" && source !== "private-index")
              ? {
                  unresolvedReason:
                    patch && source !== "registry"
                      ? `replaced by ${patch}: the replacement is what builds`
                      : source !== "registry"
                        ? `a ${source} dependency, not from crates.io`
                        : lock
                          ? "not found in Cargo.lock"
                          : "no Cargo.lock",
                }
              : {}),
          });
          if (
            parsed.success &&
            !instances.some(
              (i) => i.name === crate && i.workspace === dirname(manifest) && i.scope === parsed.data.scope,
            )
          )
            instances.push(parsed.data);
        }
    }
    // Transitive crates: every locked registry package no member declares.
    for (const p of lock?.packages ?? []) {
      if (
        !p.source?.startsWith("registry+") ||
        instances.some((i) => i.name === p.name && i.version === p.version)
      )
        continue;
      const parsed = dependencyInstance.safeParse({
        ecosystem: "cargo",
        name: p.name,
        version: p.version,
        direct: false,
        scope: "prod",
        workspace: root,
        manifestPath: top.path,
        lockfilePath: lockPath,
        source: "registry",
        resolvedBy: "lockfile",
      });
      if (parsed.success) instances.push(parsed.data);
    }
    const pkg = (top.doc.package ?? {}) as Table;
    const wsPkg = (ws.package ?? {}) as Table;
    const rustVersion =
      typeof pkg["rust-version"] === "string"
        ? pkg["rust-version"]
        : typeof wsPkg["rust-version"] === "string"
          ? wsPkg["rust-version"]
          : null;
    // Cargo's MSRV-aware resolution: resolver 3 (edition 2024's default) falls back to versions the
    // rust-version supports; `.cargo/config.toml` can say either way.
    const configured = /^\s*incompatible-rust-versions\s*=\s*"(fallback|allow)"/m.exec(
      tree.read(join(root, ".cargo/config.toml")) ?? tree.read(join(root, ".cargo/config")) ?? "",
    )?.[1] as "fallback" | "allow" | undefined;
    const resolver = String(ws.resolver ?? pkg.resolver ?? (pkg.edition === "2024" ? "3" : ""));
    const msrvPolicy = configured ?? (resolver === "3" ? "fallback" : "allow");
    if (patches.size) notes.push(`patched: ${[...patches].map(([c, w]) => `${c} (${w})`).join(", ")}`);
    projects.push({
      root,
      manager: "cargo",
      lockfile: lockText !== null ? lockPath : null,
      lockfileVersion: lock?.version ?? null,
      manifest: top.path,
      instances,
      members,
      rustVersion: rustVersion as string | null,
      msrvPolicy,
      notes,
    });
  }
  return projects;
}
