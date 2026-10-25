import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  /** `replace` directives: old path → new path (and version when a module, not a directory). */
  replaces: { old: string; new: string; version: string | null }[];
  notes: string[];
}

interface ModEditJson {
  Module?: { Path: string };
  Go?: string;
  Toolchain?: string;
  Require?: { Path: string; Version: string; Indirect?: boolean }[];
  Replace?: { Old: { Path: string; Version?: string }; New: { Path: string; Version?: string } }[];
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

export async function readGoInventory(repoDir: string, tree: RepoTree): Promise<GoProject[]> {
  const mods = tree.files().filter((f) => (f === "go.mod" || f.endsWith("/go.mod")) && !SKIP.test(f));
  const projects: GoProject[] = [];
  const home = await scratchHome();
  try {
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
      const sum = tree.read(join(root, "go.sum")) !== null ? join(root, "go.sum") : null;

      // Selected versions from the toolchain, on a scratch copy of go.mod and go.sum.
      const selected = new Map<string, ListModule>();
      if (!local.length) {
        const scratch = await mkdtemp(join(tmpdir(), "teire-gomod-"));
        try {
          await copyFile(join(dir, "go.mod"), join(scratch, "go.mod"));
          if (sum) await copyFile(join(repoDir, sum), join(scratch, "go.sum"));
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

      const instances: DependencyInstance[] = [];
      for (const req of edit.Require ?? []) {
        const replaced = replaces.find((r) => r.old === req.Path);
        const chosen = selected.get(req.Path);
        const version = replaced ? (replaced.version ?? null) : (chosen?.Version ?? req.Version);
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
          source: replaced && !replaced.version ? "path" : "registry",
          ...(replaced && !replaced.version ? { sourceRef: replaced.new } : {}),
          resolvedBy: version === null ? "unresolved" : chosen || replaced ? "toolchain" : "lockfile",
          ...(version === null
            ? { unresolvedReason: `replaced by the local directory ${replaced?.new}` }
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
        replaces,
        notes,
      });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  return projects;
}
