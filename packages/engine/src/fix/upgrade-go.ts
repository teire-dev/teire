import type { DependencyInstance } from "../contract";
import type { GoProject } from "../inventory/go";
import type { RepoTree } from "../inventory/tree";
import type { Transaction } from "./transaction";
import type { ManifestEdit } from "./upgrade-js";

/**
 * The Go upgrade transaction (plan S05, research go.md Jobs 6–7). Within a major: `go get
 * module@version`, which raises other modules only as far as the new version requires (minimal
 * version selection; never `-u`). Across a major the module path changes, so Teire first rewrites
 * the import specs itself, as text: only inside `import` declarations, subpackages included,
 * aliases kept, never strings or comments elsewhere. Those edits are written before the commands,
 * so `go mod tidy` sees the new path in use and drops the old one. Vendored modules re-vendor.
 */
const IMPORT_BLOCK = /^import\s*\(([\s\S]*?)^\)/gm;
const IMPORT_LINE = /^import\s+(?:[\w.]+\s+)?"[^"]+"/gm;

function rewriteSpecs(segment: string, oldPath: string, newPath: string) {
  return segment.replace(/"([^"]+)"/g, (whole, path: string) =>
    path === oldPath || path.startsWith(`${oldPath}/`) ? `"${newPath}${path.slice(oldPath.length)}"` : whole,
  );
}

/** A Go file with every import of `oldPath` (and its subpackages) moved to `newPath`; null when none. */
export function rewriteImports(text: string, oldPath: string, newPath: string): string | null {
  const out = text
    .replace(IMPORT_BLOCK, (block) => rewriteSpecs(block, oldPath, newPath))
    .replace(IMPORT_LINE, (line) => rewriteSpecs(line, oldPath, newPath));
  return out === text ? null : out;
}

/** `file` (repo-relative) as seen from the folder `from` (repo-relative). */
function relativeTo(from: string, file: string) {
  const up = from === "." ? 0 : from.split("/").length;
  return `${"../".repeat(up)}${file}`;
}

export function goTransaction(
  tree: RepoTree,
  project: GoProject,
  instance: DependencyInstance,
  targetPath: string,
  target: string,
): Transaction {
  const prefix = project.root === "." ? "" : `${project.root}/`;
  const edits: ManifestEdit[] = [];
  if (targetPath !== instance.name)
    for (const file of tree.files()) {
      if (!file.endsWith(".go") || !file.startsWith(prefix) || /(?:^|\/)(?:vendor|testdata)\//.test(file))
        continue;
      const before = tree.read(file);
      if (before === null || !before.includes(instance.name)) continue;
      const after = rewriteImports(before, instance.name, targetPath);
      if (after) edits.push({ path: file, before, after, from: instance.name, to: targetPath });
    }
  const gomod = project.manifest;
  // A workspace that vendors (`go work vendor`, S18.4) re-vendors at the workspace, never per module.
  const work = project.work;
  const workVendor = work?.vendored ? `${work.root === "." ? "" : `${work.root}/`}vendor/modules.txt` : null;
  const readBack = [
    gomod,
    project.lockfile ?? `${prefix}go.sum`,
    ...(project.vendored ? [`${prefix}vendor/modules.txt`] : []),
    ...(workVendor ? [workVendor] : []),
  ];
  // The module's own edit in module mode, whatever the sandbox's workspace setting.
  const own = (argv: string[]) =>
    work ? ["env", "GOWORK=off", "GOFLAGS=-mod=mod -modcacherw", ...argv] : argv;
  const commands = [
    own(["go", "get", `${targetPath}@${target}`]),
    own(["go", "mod", "tidy"]),
    ...(project.vendored ? [own(["go", "mod", "vendor"])] : []),
    ...(work?.vendored
      ? [
          [
            "sh",
            "-c",
            `GOWORK="$PWD/${relativeTo(project.root, work.file)}" GOFLAGS=-modcacherw go work vendor`,
          ],
        ]
      : []),
  ];
  return {
    describe:
      targetPath === instance.name
        ? `go get ${targetPath}@${target}`
        : `${instance.name} → ${targetPath}@${target}: imports rewritten in ${edits.length} file(s), go get, go mod tidy`,
    manifest: edits,
    commands,
    readBack,
    lockfilePath: readBack[1] as string,
    check: (files) => {
      const text = files[gomod] ?? "";
      const required = new RegExp(
        `(^|\\s)${targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${target.replace(/[.+]/g, "\\$&")}(\\s|$)`,
        "m",
      );
      if (!required.test(text)) return `go.mod does not require ${targetPath} ${target}`;
      // The old path may stay as `// indirect` (another module needs it); as a direct requirement it means an import was missed.
      const escaped = instance.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (
        targetPath !== instance.name &&
        new RegExp(`^\\s*(?:require\\s+)?${escaped}\\s+v\\S+\\s*$`, "m").test(text)
      )
        return `go.mod still requires ${instance.name} directly: an import was not moved`;
      return null;
    },
  };
}
