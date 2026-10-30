import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { type DependencyInstance, dependencyInstance } from "../contract";
import { runGo, scratchHome } from "../golang/toolchain";
import type { RepoTree } from "./tree";

/**
 * Go modules (plan S05, research go.md Job 1). `go.mod` is the manifest; `go.sum` is checksums, not
 * a lockfile. The version a build uses is decided by minimal version selection, so it comes from
 * the toolchain itself: `go mod edit -json` reads each go.mod exactly as `go` does, and
 * `go list -m -json all` (on a scratch copy through `-modfile`, so the checkout is never rewritten)
 * reports every selected version. A module with a local `replace` keeps go.mod's versions and says
 * so. Workspaces (`go.work`) are read module by module.
 */
export interface GoProject {
  /** Directory of the module's go.mod ("." for the root). */
  root: string;
  manager: "go";
  /** Module path (`github.com/acme/app`). */
  module: string;
  /** The `go` line (`1.24.0`) and the `toolchain` line, when present. */
  goVersion: string | null;
  toolchain: string | null;
  lockfile: string | null;
  lockfileVersion: null;
  manifest: string;
  instances: DependencyInstance[];
  vendored: boolean;
  /**
   * The `go.work` workspace this module is used in (S18.4): its file, its folder, and whether
   * `go work vendor` vendors it there. Versions are then the workspace's selection.
   */
  work?: { file: string; root: string; vendored: boolean };
  /** `replace` directives: old path → new path (and version when a module, not a directory). */
  replaces: { old: string; new: string; version: string | null }[];
  /** `exclude` directives: versions this module refuses (main module only, go.dev/ref/mod). */
  excludes: { path: string; version: string }[];
  notes: string[];
}

interface ModEditJson {
  Module?: { Path: string };
  Go?: string;
  Toolchain?: string;
  Require?: { Path: string; Version: string; Indirect?: boolean }[];
  Replace?: { Old: { Path: string; Version?: string }; New: { Path: string; Version?: string } }[];
  Exclude?: { Path: string; Version: string }[];
}

interface ListModule {
  Path: string;
  Version?: string;
  Main?: boolean;
  Replace?: { Path: string; Version?: string };
}

const SKIP = /(?:^|\/)(?:vendor|testdata|node_modules|\.git|_examples?|examples?)\//;

/** `go list -m -json all` prints concatenated JSON objects. */
function parseStream<T>(text: string): T[] {
  const out: T[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) out.push(JSON.parse(text.slice(start, i + 1)) as T);
    }
  }
  return out;
}

interface WorkEditJson {
  Use?: { DiskPath: string }[];
}

/**
 * Each `go.work` workspace (S18.4): the modules it uses and the versions it selects for all of
 * them together (`go list -m all` in workspace mode), keyed by module folder.
 */
async function readWorkspaces(repoDir: string, tree: RepoTree, home: string, notes: string[]) {
  const out = new Map<string, { work: NonNullable<GoProject["work"]>; selected: Map<string, ListModule> }>();
  for (const file of tree
    .files()
    .filter((f) => (f === "go.work" || f.endsWith("/go.work")) && !SKIP.test(f))) {
    const root = dirname(file);
    const dir = join(repoDir, root);
    try {
      const edit = JSON.parse(
        (await runGo(["work", "edit", "-json", join(repoDir, file)], dir, home)).stdout,
      ) as WorkEditJson;
      const selected = new Map<string, ListModule>();
      const { stdout } = await runGo(["list", "-m", "-json", "all"], dir, home, undefined, {
        GOWORK: join(repoDir, file),
        GOFLAGS: "-modcacherw",
      });
      for (const m of parseStream<ListModule>(stdout)) if (!m.Main) selected.set(m.Path, m);
      const work = { file, root, vendored: tree.read(join(root, "vendor", "modules.txt")) !== null };
      for (const use of edit.Use ?? []) out.set(normalize(join(root, use.DiskPath)), { work, selected });
    } catch (error) {
      notes.push(
        `${file}: not read (${(error instanceof Error ? error.message : String(error)).slice(0, 200)})`,
      );
    }
  }
  return out;
}

export async function readGoInventory(repoDir: string, tree: RepoTree): Promise<GoProject[]> {
  const mods = tree.files().filter((f) => (f === "go.mod" || f.endsWith("/go.mod")) && !SKIP.test(f));
  const projects: GoProject[] = [];
  const home = await scratchHome();
  const workNotes: string[] = [];
  try {
    const workspaces = await readWorkspaces(repoDir, tree, home, workNotes);
    for (const manifest of mods) {
      const root = dirname(manifest);
      const dir = join(repoDir, root);
      const notes: string[] = [];
      const edit = JSON.parse((await runGo(["mod", "edit", "-json"], dir, home)).stdout) as ModEditJson;
      const module = edit.Module?.Path;
      if (!module) continue;
      const replaces = (edit.Replace ?? []).map((r) => ({
        old: r.Old.Path,
        new: r.New.Path,
        version: r.New.Version ?? null,
      }));
      const local = replaces.filter((r) => r.version === null);
      // A module path with no dot in its first element can't come from a proxy (D-33): it is a local
      // or private module, so it is left out of `go list` and marked as such, and the rest still
      // gets the toolchain's versions.
      const undotted = (edit.Require ?? [])
        .map((r) => r.Path)
        .filter((path) => !(path.split("/")[0] ?? "").includes(".") && !local.some((r) => r.old === path));
      const sum = tree.read(join(root, "go.sum")) !== null ? join(root, "go.sum") : null;

      // Selected versions from the toolchain, on a scratch copy of go.mod and go.sum; in a workspace,
      // the workspace's selection, which is what its builds use.
      const workspace = workspaces.get(root);
      const selected = new Map<string, ListModule>(workspace?.selected ?? []);
      if (workspace)
        notes.push(`used in ${workspace.work.file}: versions are the workspace's selection`, ...workNotes);
      else if (!local.length) {
        const scratch = await mkdtemp(join(tmpdir(), "teire-gomod-"));
        try {
          await copyFile(join(dir, "go.mod"), join(scratch, "go.mod"));
          if (sum) await copyFile(join(repoDir, sum), join(scratch, "go.sum"));
          if (undotted.length)
            await runGo(
              ["mod", "edit", ...undotted.map((path) => `-droprequire=${path}`), join(scratch, "go.mod")],
              dir,
              home,
            );
          const { stdout } = await runGo(
            ["list", "-m", "-json", `-modfile=${join(scratch, "go.mod")}`, "all"],
            dir,
            home,
          );
          for (const m of parseStream<ListModule>(stdout)) if (!m.Main) selected.set(m.Path, m);
        } catch (error) {
          notes.push(
            `go list -m all failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
          );
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      } else
        notes.push(`local replace of ${local.map((r) => r.old).join(", ")}: versions as written in go.mod`);
      if (undotted.length)
        notes.push(`${undotted.join(", ")}: no dot in the module path, so local or private, not compared`);

      const instances: DependencyInstance[] = [];
      for (const req of edit.Require ?? []) {
        const replaced = replaces.find((r) => r.old === req.Path);
        const chosen = selected.get(req.Path);
        const isUndotted = undotted.includes(req.Path);
        const version = isUndotted
          ? null
          : replaced
            ? (replaced.version ?? null)
            : (chosen?.Version ?? req.Version);
        const parsed = dependencyInstance.safeParse({
          ecosystem: "go",
          name: replaced?.version ? replaced.new : req.Path,
          ...(replaced?.version ? { aliasName: req.Path } : {}),
          version,
          declaredRange: req.Version,
          direct: !req.Indirect,
          // Go has no dev dependencies: test-only requirements are in the same list.
          scope: "prod",
          workspace: root,
          manifestPath: manifest,
          ...(sum ? { lockfilePath: sum } : {}),
          source: isUndotted ? "unknown" : replaced && !replaced.version ? "path" : "registry",
          ...(replaced && !replaced.version ? { sourceRef: replaced.new } : {}),
          resolvedBy: version === null ? "unresolved" : chosen || replaced ? "toolchain" : "lockfile",
          ...(version === null
            ? {
                unresolvedReason: isUndotted
                  ? "a module path with no dot in its first element: a local or private module, not on a proxy"
                  : `replaced by the local directory ${replaced?.new}`,
              }
            : {}),
        });
        if (parsed.success) instances.push(parsed.data);
      }
      projects.push({
        root,
        manager: "go",
        module,
        goVersion: edit.Go ?? null,
        toolchain: edit.Toolchain ?? null,
        lockfile: sum,
        lockfileVersion: null,
        manifest,
        instances,
        vendored: tree.read(join(root, "vendor", "modules.txt")) !== null,
        ...(workspace ? { work: workspace.work } : {}),
        replaces,
        excludes: (edit.Exclude ?? []).map((e) => ({ path: e.Path, version: e.Version })),
        notes,
      });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  return projects;
}
