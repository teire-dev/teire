import { dirname, join } from "node:path";
import type { DependencyInstance } from "../contract";
import type { RustProject } from "../inventory/rust";
import type { RepoTree } from "../inventory/tree";
import type { Transaction } from "./transaction";
import type { ManifestEdit } from "./upgrade-js";

/**
 * The Cargo upgrade transaction (plan S06, research rust.md Job 7): Teire edits the requirement as
 * text, keeping the file's formatting and the requirement's style, and drops features the new
 * version no longer has; then `cargo update -p name@old --precise new` regenerates only that entry
 * of Cargo.lock in the sandbox (the research's lockfile diff was 4 lines). A dependency declared
 * with `workspace = true` is bumped where it is defined, in the root `[workspace.dependencies]`.
 */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `"0.8"` → `"0.10"`, `"0.8.5"` → `"0.10.3"`, `"=1.2.3"` → `"=2.0.1"`, `"1"` → `"2"`. */
export function cargoRequirementFor(declared: string | undefined, target: string) {
  const req = (declared ?? "").trim();
  const op = /^(?:[=^~]|>=)/.exec(req)?.[0] ?? "";
  const parts = req.slice(op.length).split(".").filter(Boolean).length || 3;
  const t = target.split(".");
  // A 0.x requirement needs its minor (`"0"` would mean `^0`, every 0.x release).
  const keep = Math.max(parts, t[0] === "0" ? 2 : 1);
  return op + t.slice(0, keep).join(".");
}

function dropFeatures(segment: string, features: string[]) {
  if (!features.length) return segment;
  return segment.replace(
    /(features\s*=\s*\[)([^\]]*)(\])/,
    (_, open: string, list: string, close: string) => {
      const kept = list
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x && !features.includes(x.replace(/^["']|["']$/g, "")));
      return `${open}${kept.join(", ")}${close}`;
    },
  );
}

/** The manifest with the dependency's requirement moved to `requirement`; null when the entry is not found. */
export function editCargoDependency(
  text: string,
  key: string,
  requirement: string,
  removedFeatures: string[] = [],
  section = "",
): string | null {
  const lines = text.split("\n");
  let current = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      current = header[1]?.trim() ?? "";
      // `[dependencies.rand]`: the version is a key of this table.
      if (current.endsWith(`dependencies.${key}`) && (!section || current.startsWith(section))) {
        for (let j = i + 1; j < lines.length && !/^\s*\[/.test(lines[j] as string); j++) {
          const v = /^(\s*version\s*=\s*)(["'])([^"']*)\2/.exec(lines[j] as string);
          if (v) lines[j] = (lines[j] as string).replace(v[0], `${v[1]}${v[2]}${requirement}${v[2]}`);
          if (/^\s*features\s*=/.test(lines[j] as string))
            lines[j] = dropFeatures(lines[j] as string, removedFeatures);
        }
        return lines.join("\n");
      }
      continue;
    }
    if (!/dependencies$/.test(current) || (section && !current.startsWith(section))) continue;
    const simple = new RegExp(`^(\\s*${esc(key)}\\s*=\\s*)(["'])([^"']*)\\2`).exec(line);
    if (simple) {
      lines[i] = line.replace(simple[0], `${simple[1]}${simple[2]}${requirement}${simple[2]}`);
      return lines.join("\n");
    }
    const inline = new RegExp(`^(\\s*${esc(key)}\\s*=\\s*\\{)(.*)(\\}.*)$`).exec(line);
    if (inline && /version\s*=/.test(inline[2] ?? "")) {
      const body = dropFeatures(
        (inline[2] ?? "").replace(/(version\s*=\s*)(["'])[^"']*\2/, `$1$2${requirement}$2`),
        removedFeatures,
      );
      lines[i] = `${inline[1]}${body}${inline[3]}`;
      return lines.join("\n");
    }
  }
  return null;
}

/**
 * The Cargo pre-step (D104): the manifest with only the features `removedFeatures` names dropped
 * from the dependency's entry, the requirement unchanged. dependabot-core's updater can't drop a
 * feature a new version removed, so it would stop below that version; given this manifest as its
 * input, it resolves the target and its returned manifest carries the drop.
 */
export function cargoFeatureOverlay(
  tree: RepoTree,
  project: RustProject,
  instance: DependencyInstance,
  removedFeatures: string[],
): { path: string; content: string }[] {
  if (!removedFeatures.length || !instance.direct || !instance.declaredRange) return [];
  const key = instance.aliasName ?? instance.name;
  const inherits = new RegExp(`^\\s*${esc(key)}\\s*=\\s*\\{[^}]*workspace\\s*=\\s*true`, "m").test(
    tree.read(instance.manifestPath) ?? "",
  );
  const manifest = inherits ? project.manifest : instance.manifestPath;
  const before = tree.read(manifest);
  if (before === null) return [];
  const after = editCargoDependency(
    before,
    key,
    instance.declaredRange,
    removedFeatures,
    inherits ? "workspace" : "",
  );
  return after && after !== before ? [{ path: manifest, content: after }] : [];
}

export function cargoTransaction(
  tree: RepoTree,
  project: RustProject,
  instance: DependencyInstance,
  target: string,
  removedFeatures: string[] = [],
): Transaction {
  const key = instance.aliasName ?? instance.name;
  const requirement = cargoRequirementFor(instance.declaredRange, target);
  const edits: ManifestEdit[] = [];
  const member = instance.manifestPath;
  const memberText = tree.read(member) ?? "";
  // `rand = { workspace = true }`: the version lives in the workspace root.
  const inherits = new RegExp(`^\\s*${esc(key)}\\s*=\\s*\\{[^}]*workspace\\s*=\\s*true`, "m").test(
    memberText,
  );
  const manifest = inherits ? project.manifest : member;
  const before = tree.read(manifest);
  if (before !== null && instance.direct) {
    const after = editCargoDependency(before, key, requirement, removedFeatures, inherits ? "workspace" : "");
    if (after && after !== before)
      edits.push({
        path: manifest,
        before,
        after,
        from: instance.declaredRange ?? instance.version ?? "",
        to: requirement,
      });
  }
  const lock = project.lockfile ?? join(dirname(project.manifest), "Cargo.lock");
  return {
    describe: `${manifest}: ${instance.name} ${instance.declaredRange ?? instance.version} → ${requirement}${removedFeatures.length ? ` (removed features dropped: ${removedFeatures.join(", ")})` : ""}; cargo update --precise ${target}`,
    manifest: edits,
    commands: [["cargo", "update", "-p", `${instance.name}@${instance.version}`, "--precise", target]],
    readBack: [...new Set([manifest, lock])],
    lockfilePath: lock,
    check: (files) =>
      new RegExp(`name = "${esc(instance.name)}"\\nversion = "${esc(target)}"`).test(files[lock] ?? "")
        ? null
        : `Cargo.lock does not lock ${instance.name} ${target}`,
    fallback: {
      describe: `cargo update -p ${instance.name} --precise ${target}`,
      manifest: [],
      commands: [["cargo", "update", "-p", instance.name, "--precise", target]],
      readBack: [...new Set([manifest, lock])],
      lockfilePath: lock,
      check: (files) =>
        new RegExp(`name = "${esc(instance.name)}"\\nversion = "${esc(target)}"`).test(files[lock] ?? "")
          ? null
          : `Cargo.lock does not lock ${instance.name} ${target}`,
    },
  };
}
