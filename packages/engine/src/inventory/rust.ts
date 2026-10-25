import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type DependencyInstance, dependencyInstance } from "../contract";
import type { RepoTree } from "./tree";

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
  notes: string[];
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
  const manifests = tree.files().filter((f) => f.endsWith("/Cargo.toml") || f === "Cargo.toml");
  const out = new Set<string>();
  for (const pattern of patterns) {
    const re = new RegExp(
      `^${(prefix + pattern.replace(/\/$/, "")).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}/Cargo\\.toml$`,
    );
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
          const source = spec.path ? "path" : spec.git ? "git" : spec.registry ? "private-index" : "registry";
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
            version: source === "registry" ? (locked?.version ?? null) : null,
            ...(typeof spec.version === "string" ? { declaredRange: spec.version } : {}),
            direct: true,
            scope: spec.optional === true && scope === "prod" ? "optional" : scope,
            workspace: dirname(manifest),
            manifestPath: manifest,
            ...(lockText !== null ? { lockfilePath: lockPath } : {}),
            source,
            ...(typeof spec.git === "string" ? { sourceRef: spec.git } : {}),
            resolvedBy: locked && source === "registry" ? "lockfile" : "unresolved",
            ...(!locked || source !== "registry"
              ? {
                  unresolvedReason:
                    source !== "registry"
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
    projects.push({
      root,
      manager: "cargo",
      lockfile: lockText !== null ? lockPath : null,
      lockfileVersion: lock?.version ?? null,
      manifest: top.path,
      instances,
      members,
      rustVersion: rustVersion as string | null,
      notes,
    });
  }
  return projects;
}
