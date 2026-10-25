import * as pep440 from "@renovatebot/pep440";
import type { DependencyInstance } from "../contract";
import type { PyProject } from "../inventory/python";
import type { RepoTree } from "../inventory/tree";
import { pypiScheme } from "../registry/versions";
import type { Transaction } from "./transaction";
import type { ManifestEdit } from "./upgrade-js";

/**
 * The Python transaction (research python.md §8): one package, the repo's own tool, minimal diffs.
 *   uv        `uv lock --upgrade-package name==X` (the pyproject line edited first when its range
 *             excludes X)
 *   Poetry    `poetry add name==X --lock` when the range excludes X, else `poetry update name --lock`
 *   Pipenv    `pipenv upgrade name==X`
 *   pip-tools `pip-compile --upgrade-package name==X <in> -o <txt>` (the .in line edited when needed)
 *   pip       the pinned requirements line edited in place
 * Tools that rewrite manifests (Poetry, Pipenv) have them read back, and every transaction checks
 * the read-back lock (or pinned line) really holds the target. Hash-pinned requirement lines get
 * the target's hashes. Never `uv lock --upgrade` or `poetry lock --regenerate`.
 */
const normalise = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/**
 * A requirement name in any spelling PEP 503 treats as the same (`Foo_Bar` = `foo-bar`), never a
 * prefix of a longer name (`numpy` does not match `numpy-financial`).
 */
function namePattern(name: string) {
  const parts = normalise(name)
    .split("-")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[-_.]+");
  return `${parts}(?![A-Za-z0-9._-])`;
}

/** The new specifier for `target`, keeping the old one's style. */
export function bumpSpecifier(spec: string, target: string): string {
  const s = spec.trim();
  if (!s) return `>=${target}`;
  if (/^===?\s*[^,]+$/.test(s)) return `==${target}`;
  if (/^~=/.test(s)) return `~=${target}`;
  if (pep440.validRange(s) && pypiScheme.satisfies(target, s)) return s;
  const major = pep440.major(target);
  return /</.test(s) && Number.isFinite(major) ? `>=${target},<${major + 1}` : `>=${target}`;
}

/** Edits the quoted requirement string for `name` in a pyproject (PEP 621 / dependency groups). */
function editPyproject(text: string, path: string, name: string, target: string): ManifestEdit | null {
  const re = new RegExp(
    `(["'])(\\s*${namePattern(name)}\\s*(?:\\[[^\\]]*\\])?\\s*)([^"';]*?)(\\s*;[^"']*)?\\1`,
    "gi",
  );
  let from = "";
  let to = "";
  const after = text.replace(
    re,
    (whole, quote: string, head: string, spec: string, marker: string | undefined) => {
      if (from) return whole;
      from = spec.trim();
      to = bumpSpecifier(from, target);
      return `${quote}${head.trimEnd()}${to}${marker ?? ""}${quote}`;
    },
  );
  return from && after !== text ? { path, before: text, after, from, to } : null;
}

/**
 * Edits `name==old` (or any specifier) in a requirements file, with its `\` continuation lines.
 * A hash-pinned requirement gets `hashes` in place of the old ones; without them the edit is
 * refused, because pip rejects a pin whose hashes do not match.
 */
export function editRequirements(
  text: string,
  path: string,
  name: string,
  target: string,
  hashes: string[] = [],
): ManifestEdit | null {
  const lines = text.split("\n");
  const head = new RegExp(`^(\\s*${namePattern(name)}\\s*(?:\\[[^\\]]*\\])?)\\s*([^;#\\s\\\\]*)(.*)$`, "i");
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = start;
  while (end < lines.length - 1 && /\\\s*$/.test(lines[end] ?? "")) end++;
  const m = head.exec(lines[start] ?? "");
  if (!m?.[1]) return null;
  const from = (m[2] ?? "").trim();
  const to = bumpSpecifier(from, target);
  const block = lines.slice(start, end + 1);
  let replacement: string[];
  if (block.some((l) => /--hash=/.test(l))) {
    if (!hashes.length) return null;
    // The marker or comment before the first `\` stays; every old hash goes.
    const rest = (m[3] ?? "").replace(/\s*--hash=\S+/g, "").replace(/\s*\\\s*$/, "");
    const indent = /^\s*/.exec(block[1] ?? "    ")?.[0] || "    ";
    replacement = [
      `${m[1]}${to}${rest} \\`,
      ...hashes.map((h, i) => `${indent}--hash=sha256:${h}${i < hashes.length - 1 ? " \\" : ""}`),
    ];
  } else replacement = [`${m[1]}${to}${m[3] ?? ""}`, ...block.slice(1)];
  const after = [...lines.slice(0, start), ...replacement, ...lines.slice(end + 1)].join("\n");
  return after === text ? null : { path, before: text, after, from, to };
}

/**
 * The read-back lock (or pinned requirements line) holds this package at `target` or above (a
 * Poetry `update` may lock a newer allowed release than an advisory's smallest fix).
 */
function lockedCheck(manager: PyProject["manager"], lock: string | undefined, name: string, target: string) {
  const n = namePattern(name);
  const version = `([A-Za-z0-9_.!+-]+)`;
  const patterns: Record<string, RegExp> = {
    uv: new RegExp(`name = "${n}"\\s*\\nversion = "${version}"`, "i"),
    poetry: new RegExp(`name = "${n}"\\s*\\nversion = "${version}"`, "i"),
    pipenv: new RegExp(`"${n}":\\s*\\{[^}]*"version":\\s*"==${version}"`, "is"),
  };
  const re = patterns[manager] ?? new RegExp(`^\\s*${n}\\s*(?:\\[[^\\]]*\\])?\\s*==\\s*${version}`, "im");
  return (files: Record<string, string>) => {
    const text = lock ? files[lock] : Object.values(files).join("\n");
    if (text === undefined) return `${lock} was not read back`;
    const locked = re.exec(text)?.[1];
    if (!locked) return `${lock ?? "the requirements"} no longer lists ${name}`;
    return pypiScheme.valid(locked) && pypiScheme.compare(locked, target) >= 0
      ? null
      : `${lock ?? "the requirements"} still pins ${name} ${locked}, below ${target}, after the update`;
  };
}

export function pyTransaction(
  tree: RepoTree,
  project: PyProject,
  instance: DependencyInstance,
  target: string,
  hashes: string[] = [],
): Transaction {
  const pin = `${instance.name}==${target}`;
  const lock = project.lockfile ?? undefined;
  const manifest = instance.manifestPath;
  const allows =
    !instance.declaredRange ||
    (pep440.validRange(instance.declaredRange) && pypiScheme.satisfies(target, instance.declaredRange));
  const inProject = (path: string) => (project.root === "." ? path : path.slice(project.root.length + 1));
  const readBack = [lock, manifest].filter((p): p is string => !!p);
  const base = {
    readBack,
    check: lockedCheck(project.manager, lock, instance.name, target),
    ...(lock ? { lockfilePath: lock } : {}),
  };
  const edit = (): ManifestEdit[] => {
    if (!instance.direct || allows) return [];
    const text = tree.read(manifest);
    if (text === null) return [];
    const e = manifest.endsWith(".toml")
      ? editPyproject(text, manifest, instance.name, target)
      : editRequirements(text, manifest, instance.name, target, hashes);
    return e ? [e] : [];
  };
  switch (project.manager) {
    case "uv": {
      const edits = edit();
      return {
        ...base,
        describe:
          edits.map((e) => `${e.path}: ${e.from} → ${e.to}`).join(", ") ||
          `uv lock: ${instance.name} → ${target}`,
        manifest: edits,
        commands: [["uv", "lock", "--upgrade-package", edits.length ? instance.name : pin]],
      };
    }
    case "poetry":
      return {
        ...base,
        describe: `poetry: ${instance.name} → ${target}`,
        manifest: [],
        commands: [
          instance.direct && !allows
            ? ["poetry", "add", pin, "--lock"]
            : ["poetry", "update", instance.name, "--lock"],
        ],
      };
    case "pipenv":
      return {
        ...base,
        readBack: [...new Set([...readBack, project.root === "." ? "Pipfile" : `${project.root}/Pipfile`])],
        describe: `pipenv: ${instance.name} → ${target}`,
        manifest: [],
        commands: [["pipenv", "upgrade", pin]],
      };
    case "pip-tools":
    case "uv-pip": {
      const inFile = lock?.replace(/\.txt$/, ".in");
      const edits = edit();
      const compile = project.manager === "uv-pip" ? ["uv", "pip", "compile"] : ["pip-compile"];
      return {
        ...base,
        describe:
          edits.map((e) => `${e.path}: ${e.from} → ${e.to}`).join(", ") ||
          `${compile.join(" ")}: ${instance.name} → ${target}`,
        manifest: edits,
        commands:
          lock && inFile
            ? [[...compile, "--upgrade-package", pin, inProject(inFile), "-o", inProject(lock)]]
            : [],
      };
    }
    default: {
      // Plain pinned requirements: the line is the lock.
      const text = tree.read(manifest);
      const e = text === null ? null : editRequirements(text, manifest, instance.name, target, hashes);
      return {
        describe: e ? `${e.path}: ${e.from} → ${e.to}` : `${instance.name} → ${target}`,
        manifest: e ? [e] : [],
        commands: [],
        readBack: [manifest],
        check: lockedCheck(project.manager, manifest, instance.name, target),
      };
    }
  }
}
