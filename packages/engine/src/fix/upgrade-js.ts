import { applyEdits, modify } from "jsonc-parser";
import semver from "semver";
import YAML from "yaml";
import type { DependencyInstance } from "../contract";
import { type JsManager, type JsProject, readJsProject } from "../inventory/js";
import { memoryTree, type RepoTree } from "../inventory/tree";
import { npmScheme } from "../registry/versions";
import type { Transaction } from "./transaction";

/**
 * The JS upgrade transaction, worker side (card C4 steps 2–3, research js-ts.md §7): edit the
 * declared range in the manifest as text (the package managers' own `add`/`install <spec>`
 * re-serialise package.json), then let the repo's own package manager regenerate the lockfile in
 * lockfile-only mode inside the sandbox. `catalog:` specifiers are edited in pnpm-workspace.yaml.
 */
export interface ManifestEdit {
  path: string;
  before: string;
  after: string;
  from: string;
  to: string;
  /** What the edit is, when it isn't a version line (an override), for the PR's Changes table. */
  note?: string;
}

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** Keeps the range's style: `^4.1.0` → `^7.37.0`, `~4.1` → `~7.37.0`, `4.104.0` → `7.37.0`. */
export function bumpRange(range: string, target: string): string {
  const trimmed = range.trim();
  if (/^\^/.test(trimmed)) return `^${target}`;
  if (/^~/.test(trimmed)) return `~${target}`;
  if (semver.valid(trimmed)) return target;
  if (semver.validRange(trimmed) && semver.satisfies(target, trimmed)) return trimmed;
  return `^${target}`;
}

function editPackageJson(
  text: string,
  name: string,
  target: string,
  alias?: string,
): { text: string; from: string; to: string } | null {
  let doc: Record<string, Record<string, string> | undefined>;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const key = alias ?? name;
  for (const section of SECTIONS) {
    const current = doc[section]?.[key];
    if (typeof current !== "string") continue;
    // `npm:real-name@^1` aliases keep their prefix.
    const aliasPrefix = /^npm:((?:@[^/]+\/)?[^@]+)@/.exec(current)?.[0] ?? "";
    const range = current.slice(aliasPrefix.length);
    if (/^(workspace:|catalog:|file:|link:|git|https?:)/.test(range)) return null;
    const next = `${aliasPrefix}${bumpRange(range, target)}`;
    if (next === current) return { text, from: current, to: current };
    const edits = modify(text, [section, key], next, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    return { text: applyEdits(text, edits), from: current, to: next };
  }
  return null;
}

/** The manifest edits for upgrading one direct dependency to `target`. */
export function planManifestEdits(
  tree: RepoTree,
  instance: DependencyInstance,
  target: string,
): ManifestEdit[] {
  const path = instance.manifestPath;
  const text = tree.read(path);
  if (text === null) return [];
  const declared = instance.declaredRange ?? "";
  if (declared.startsWith("catalog:")) {
    // pnpm catalogs: `catalog:` is the default catalog, `catalog:<name>` a named one.
    const root = path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";
    const workspacePath = ["pnpm-workspace.yaml", `${root}/pnpm-workspace.yaml`].find(
      (p) => tree.read(p) !== null,
    );
    const workspaceText = workspacePath ? tree.read(workspacePath) : null;
    if (!workspacePath || workspaceText === null) return [];
    const doc = YAML.parseDocument(workspaceText);
    const catalog = declared.slice("catalog:".length);
    const keyPath =
      catalog && catalog !== "default"
        ? ["catalogs", catalog, instance.aliasName ?? instance.name]
        : ["catalog", instance.aliasName ?? instance.name];
    const current = doc.getIn(keyPath);
    if (typeof current !== "string") return [];
    const next = bumpRange(current, target);
    doc.setIn(keyPath, next);
    return [{ path: workspacePath, before: workspaceText, after: doc.toString(), from: current, to: next }];
  }
  const edited = editPackageJson(text, instance.name, target, instance.aliasName);
  if (!edited || edited.from === edited.to) return [];
  return [{ path, before: text, after: edited.text, from: edited.from, to: edited.to }];
}

/** Lockfile regeneration with the repo's own tool, lockfile only, no lifecycle scripts. */
export function lockfileCommand(manager: JsManager, lockfileVersion?: string): string[] {
  switch (manager) {
    case "pnpm":
      return [
        "pnpm",
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        "--config.verify-deps-before-run=false",
      ];
    case "yarn":
      return lockfileVersion && lockfileVersion !== "1"
        ? ["yarn", "install", "--mode=update-lockfile"]
        : ["yarn", "install", "--ignore-scripts", "--non-interactive"];
    case "bun":
      return ["bun", "install", "--lockfile-only", "--ignore-scripts"];
    default:
      return ["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
  }
}

/**
 * Lockfile-only bump of a transitive dependency (advisories with a fixed version, D71): first
 * within its parents' ranges with the package manager's own update; when a parent's range forbids
 * the fix, an override pins it (npm `overrides`, pnpm `pnpm.overrides`, yarn and bun
 * `resolutions`) and the PR says so. Whether the fix landed is read back from the new lockfile.
 */
export function transitiveUpdateCommand(
  manager: JsManager,
  name: string,
  lockfileVersion?: string,
): string[] | null {
  switch (manager) {
    case "pnpm":
      return [
        "pnpm",
        "update",
        name,
        "--recursive",
        "--depth",
        "Infinity",
        "--lockfile-only",
        "--ignore-scripts",
      ];
    case "yarn":
      return lockfileVersion && lockfileVersion !== "1"
        ? ["yarn", "up", "-R", name, "--mode=update-lockfile"]
        : null;
    case "bun":
      return null;
    default:
      return ["npm", "update", name, "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
  }
}

/** The override that pins `name` to at least `version` in the root manifest, format-preserving. */
export function overrideEdit(
  tree: RepoTree,
  manager: JsManager,
  manifestPath: string,
  name: string,
  version: string,
): ManifestEdit | null {
  const text = tree.read(manifestPath);
  if (text === null) return null;
  const path =
    manager === "pnpm"
      ? ["pnpm", "overrides", name]
      : manager === "npm"
        ? ["overrides", name]
        : ["resolutions", name];
  const range = `^${version}`;
  let current: string | undefined;
  try {
    let node: unknown = JSON.parse(text);
    for (const key of path) node = (node as Record<string, unknown> | undefined)?.[key];
    current = typeof node === "string" ? node : undefined;
  } catch {
    return null;
  }
  if (current === range) return null;
  const after = applyEdits(
    text,
    modify(text, path, range, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
  );
  const field = path.slice(0, -1).join(".");
  return {
    path: manifestPath,
    before: text,
    after,
    from: current ?? "",
    to: range,
    note: `\`${field}\` pins \`${name}\` to \`${range}\`: the packages that depend on it don't allow the fixed version`,
  };
}

/** Versions of `name` a JS lockfile pins, read with Teire's own readers. */
function lockedJsVersions(tree: RepoTree, project: JsProject, name: string, lockText: string) {
  const root = project.root === "." ? "" : `${project.root}/`;
  const files: Record<string, string> = {};
  for (const f of tree.files())
    if (f.startsWith(root) && f.endsWith("package.json")) files[f] = tree.read(f) ?? "";
  if (project.lockfile) files[project.lockfile] = lockText;
  return readJsProject(memoryTree(files), project.root)
    .instances.filter((i) => i.name === name && i.version)
    .map((i) => i.version as string);
}

/**
 * The JS transaction (D71): a direct dependency gets its manifest line and a lockfile-only
 * regeneration; a transitive one first the package manager's in-range update, confirmed from the
 * new lock, then an override if the parents' ranges forbid the fix.
 */
export function jsTransaction(
  tree: RepoTree,
  project: JsProject,
  instance: DependencyInstance,
  target: string,
): Transaction {
  const manager = project.manager === "unknown" ? "npm" : project.manager;
  const lockfile = project.lockfile;
  const readBack = lockfile ? [lockfile] : [];
  const regenerate = lockfileCommand(manager, project.lockfileVersion);
  if (instance.direct) {
    const manifest = planManifestEdits(tree, instance, target);
    return {
      describe:
        manifest.map((e) => `${e.path}: ${e.from} → ${e.to}`).join(", ") || `${instance.name} → ${target}`,
      manifest,
      commands: [regenerate],
      readBack,
      ...(lockfile ? { lockfilePath: lockfile } : {}),
    };
  }
  const check = (files: Record<string, string>) => {
    const text = lockfile ? files[lockfile] : undefined;
    if (!text) return "the lockfile was not regenerated";
    const versions = lockedJsVersions(tree, project, instance.name, text);
    if (versions.includes(instance.version ?? ""))
      return `${instance.name} ${instance.version} is still locked`;
    if (!versions.some((v) => npmScheme.compare(v, target) >= 0))
      return `${instance.name} ${target} is not locked`;
    return null;
  };
  const manifestPath = project.root === "." ? "package.json" : `${project.root}/package.json`;
  const override = overrideEdit(tree, manager, manifestPath, instance.name, target);
  const fallback: Transaction | undefined = override
    ? {
        describe: `pin ${instance.name} to ^${target} in ${manifestPath}`,
        manifest: [override],
        commands: [regenerate],
        readBack,
        ...(lockfile ? { lockfilePath: lockfile } : {}),
        check,
      }
    : undefined;
  const update = transitiveUpdateCommand(manager, instance.name, project.lockfileVersion);
  return {
    describe: `update ${instance.name} ${instance.version} → ${target} within its parents' ranges`,
    manifest: [],
    commands: update ? [update] : [],
    readBack,
    ...(lockfile ? { lockfilePath: lockfile } : {}),
    check: update ? check : () => "no in-range update command for this package manager",
    ...(fallback ? { fallback } : {}),
  };
}
