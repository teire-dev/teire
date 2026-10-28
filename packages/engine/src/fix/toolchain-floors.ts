import type { Ecosystem } from "../contract";
import type { JvmProject } from "../inventory/jvm";
import type { RepoTree } from "../inventory/tree";
import { cratesIndexLines } from "../registry/cargo";
import type { RegistryOptions } from "../registry/clients";
import { getPypiVersion } from "../registry/pypi";
import { javaRequirement } from "../surface/jvm";
import type { ManifestEdit } from "./upgrade-js";
import { withJavaFloor } from "./upgrade-jvm";

/**
 * The toolchain a target needs, raised in the same change (S15.10, review R3), whichever transaction
 * made it (dependabot-core's updater or Teire's own):
 * - Java: the target's Gradle Module Metadata (`org.gradle.jvm.version`);
 * - Python: the target's own `Requires-Python` lower bound, raised in `requires-python`;
 * - Rust: the target's `rust_version` from the crates.io index, raised in `rust-version`.
 * Go needs nothing here: `go get` raises the `go` line itself. Only plain floors are raised
 * (`>=3.9`, `"1.70"`); anything else is left as it is and said in a note.
 */
export async function withToolchainFloors(input: {
  ecosystem: Ecosystem;
  tree: RepoTree;
  project: { root: string; manager: string };
  name: string;
  target: string;
  edits: ManifestEdit[];
  options: RegistryOptions;
}): Promise<{ edits: ManifestEdit[]; notes: string[] }> {
  const { ecosystem, tree, project, name, target, edits } = input;
  const at = (file: string) => (project.root === "." ? file : `${project.root}/${file}`);
  if (ecosystem === "maven") {
    const floor = await javaRequirement(name, target).catch(() => null);
    if (!floor) return { edits, notes: [] };
    return {
      edits: withJavaFloor(
        tree,
        project as JvmProject,
        edits,
        floor,
        `${name} ${target} needs Java ${floor} (its published Gradle Module Metadata)`,
      ),
      notes: [],
    };
  }
  if (ecosystem === "pypi") {
    const needs = (await getPypiVersion(name, target, input.options).catch(() => null))?.requiresPython;
    const floor = needs ? minorFloor(needs) : null;
    if (floor === null) return { edits, notes: [] };
    return raiseIn(
      edits,
      tree,
      at("pyproject.toml"),
      PYTHON_FLOOR,
      floor,
      (v) => `3.${v}`,
      (have) => {
        const minor = Number(have.split(".")[1]);
        return Number.isFinite(minor) && minor < floor;
      },
      `${name} ${target} requires Python ${needs}`,
    );
  }
  if (ecosystem === "cargo") {
    const line = (await cratesIndexLines(name).catch(() => [])).find((l) => l.vers === target);
    const needs = line?.rust_version;
    if (!needs) return { edits, notes: [] };
    return raiseIn(
      edits,
      tree,
      at("Cargo.toml"),
      RUST_FLOOR,
      needs,
      (v) => v,
      (have) => below(have, needs),
      `${name} ${target} needs Rust ${needs} (its rust_version)`,
    );
  }
  return { edits, notes: [] };
}

const PYTHON_FLOOR = /^(\s*requires-python\s*=\s*["'][^"']*?>=\s*)(3\.\d+(?:\.\d+)?)/m;
const RUST_FLOOR = /^(\s*rust-version\s*=\s*")(\d+\.\d+(?:\.\d+)?)/m;

/** `>=3.10,<4` → 10. Null when the specifier has no plain `>=3.N` floor. */
function minorFloor(spec: string) {
  const m = />=\s*3\.(\d+)/.exec(spec);
  return m?.[1] ? Number(m[1]) : null;
}

function below(have: string, needs: string) {
  const [a, b] = [have.split(".").map(Number), needs.split(".").map(Number)];
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

function raiseIn<T>(
  edits: ManifestEdit[],
  tree: RepoTree,
  path: string,
  pattern: RegExp,
  floor: T,
  render: (floor: T) => string,
  isBelow: (have: string) => boolean,
  why: string,
): { edits: ManifestEdit[]; notes: string[] } {
  const out = edits.map((e) => ({ ...e }));
  const existing = out.find((e) => e.path === path);
  const base = existing?.after ?? tree.read(path);
  if (base === null || base === undefined) return { edits, notes: [] };
  const m = pattern.exec(base);
  if (!m?.[2]) return { edits, notes: [`${why}; ${path} declares no plain floor Teire can raise`] };
  if (!isBelow(m[2])) return { edits, notes: [] };
  const after = base.replace(pattern, `$1${render(floor)}`);
  const note = `${m[2]} → ${render(floor)}: ${why}`;
  if (existing) {
    existing.after = after;
    existing.note = existing.note ? `${existing.note}; ${note}` : note;
  } else out.push({ path, before: base, after, from: m[2], to: render(floor), note });
  return { edits: out, notes: [] };
}
