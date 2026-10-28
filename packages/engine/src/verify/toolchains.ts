import { join } from "node:path";
import semver from "semver";
import type { RepoTree } from "../inventory/tree";
import { ciJobsFor } from "./ci";

/**
 * The toolchain versions a repo asks for, read from its own files (D-46, D-47; Dependabot detects the
 * same way), so a 2019 repo's baseline doesn't fail only because the sandbox runs today's runtime.
 * Each picker returns the version the sandbox image provides that best matches, the file that asked,
 * and a note when the match isn't exact. `null` means the repo names nothing: the image default.
 */
export interface ToolchainPick {
  version: string;
  source: string;
  note?: string;
}

/** Node majors in the node image (`/opt/node/<major>`, 24 is the image's own). */
export const NODE_MAJORS = [18, 20, 22, 24] as const;
/** CPython versions in the python image (`/opt/python/<version>`, 3.12 is the image's own). */
export const PYTHON_VERSIONS = ["3.10", "3.11", "3.12", "3.13"] as const;

const NODE_CODENAMES: Record<string, number> = {
  argon: 4,
  boron: 6,
  carbon: 8,
  dubnium: 10,
  erbium: 12,
  fermium: 14,
  gallium: 16,
  hydrogen: 18,
  iron: 20,
  jod: 22,
  krypton: 24,
};

const read = (tree: RepoTree, root: string, file: string) =>
  tree.read(root === "." ? file : join(root, file));

/** The lowest provided major at or above `wanted`, else the highest provided. */
function nearestNode(wanted: number) {
  return NODE_MAJORS.find((m) => m >= wanted) ?? NODE_MAJORS[NODE_MAJORS.length - 1];
}

export function nodeFor(tree: RepoTree, root: string): ToolchainPick | null {
  for (const file of [".nvmrc", ".node-version"]) {
    const text = read(tree, root, file)?.trim();
    if (!text) continue;
    const code = /^lts\/(\w+)/i.exec(text)?.[1]?.toLowerCase();
    const major = code ? NODE_CODENAMES[code] : Number(/^v?(\d+)/.exec(text)?.[1]);
    if (!major) continue;
    const got = nearestNode(major) as number;
    return {
      version: String(got),
      source: file,
      ...(got !== major
        ? {
            note: `${file} asks for Node ${major}; the sandbox has ${NODE_MAJORS.join(", ")}, so Node ${got} runs`,
          }
        : {}),
    };
  }
  const pkg = (() => {
    try {
      return JSON.parse(read(tree, root, "package.json") ?? "{}") as {
        volta?: { node?: string };
        engines?: { node?: string };
      };
    } catch {
      return {};
    }
  })();
  const volta = pkg.volta?.node ? Number(/^v?(\d+)/.exec(pkg.volta.node)?.[1]) : 0;
  if (volta) {
    const got = nearestNode(volta) as number;
    return { version: String(got), source: "package.json volta.node" };
  }
  const range = pkg.engines?.node;
  if (range && semver.validRange(range)) {
    // The newest provided major the range accepts; a range none accepts gets the nearest above its floor.
    const ok = [...NODE_MAJORS].reverse().find((m) => semver.satisfies(`${m}.0.0`, range));
    if (ok) return { version: String(ok), source: "package.json engines.node" };
    const floor = semver.minVersion(range)?.major ?? 24;
    return {
      version: String(nearestNode(floor)),
      source: "package.json engines.node",
      note: `engines.node "${range}" accepts no Node the sandbox has (${NODE_MAJORS.join(", ")})`,
    };
  }
  return null;
}

export function pythonFor(tree: RepoTree, root: string): ToolchainPick | null {
  const pinned = read(tree, root, ".python-version")?.trim().split(/\s+/)[0];
  const exact = pinned ? /^(\d+\.\d+)/.exec(pinned)?.[1] : undefined;
  if (exact) {
    const got = (PYTHON_VERSIONS as readonly string[]).includes(exact)
      ? exact
      : (PYTHON_VERSIONS.find((v) => semver.gte(`${v}.0`, `${exact}.0`)) ?? "3.13");
    return {
      version: got,
      source: ".python-version",
      ...(got !== exact ? { note: `.python-version asks for ${exact}; the sandbox runs ${got}` } : {}),
    };
  }
  // The Python the repo's CI tests this project on: lockfiles are resolved for it, and a newer
  // Python can lack wheels for the locked versions (devchat: CI 3.8, uvloop 0.20.0 has no 3.13 wheel).
  const ci = ciPython(tree, root);
  if (ci) {
    const got =
      PYTHON_VERSIONS.find((v) => semver.gte(`${v}.0`, `${ci}.0`)) ??
      (PYTHON_VERSIONS[PYTHON_VERSIONS.length - 1] as string);
    return {
      version: got,
      source: "CI setup-python",
      ...(got !== ci
        ? { note: `CI runs Python ${ci}; the sandbox has ${PYTHON_VERSIONS.join(", ")}, so ${got} runs` }
        : {}),
    };
  }
  const pyproject = read(tree, root, "pyproject.toml") ?? "";
  const spec =
    /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] ??
    /^\s*python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1];
  if (!spec) return null;
  const range = pep440ToSemver(spec);
  if (!range) return null;
  const ok = [...PYTHON_VERSIONS].reverse().find((v) => semver.satisfies(`${v}.0`, range));
  return ok
    ? { version: ok, source: "pyproject.toml" }
    : {
        version: "3.12",
        source: "pyproject.toml",
        note: `Python "${spec}" accepts no Python the sandbox has (${PYTHON_VERSIONS.join(", ")})`,
      };
}

/** The newest `X.Y` that `actions/setup-python` installs in this project's CI jobs (a matrix's newest). */
function ciPython(tree: RepoTree, root: string): string | null {
  const found: string[] = [];
  for (const job of ciJobsFor(tree, root))
    for (const step of job.steps) {
      if (!step.uses?.startsWith("actions/setup-python")) continue;
      const raw = step.with?.["python-version"];
      const ref = typeof raw === "string" ? /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(raw)?.[1] : undefined;
      const values = ref ? job.strategy?.matrix?.[ref] : raw;
      for (const v of Array.isArray(values) ? values : [values]) {
        const m = /^(\d+)\.(\d+)/.exec(String(v ?? ""));
        if (m) found.push(`${m[1]}.${m[2]}`);
      }
    }
  return found.sort((a, b) => (semver.gt(`${a}.0`, `${b}.0`) ? -1 : 1))[0] ?? null;
}

/** `>=3.8,<3.12`, Poetry's `^3.9` and `~3.10` as a semver range over `X.Y.0`. */
function pep440ToSemver(spec: string) {
  const parts = spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) =>
      p
        .replace(/^==\s*(\d+\.\d+)\.\*$/, "~$1.0")
        .replace(/^~=\s*/, "~")
        .replace(/^==\s*/, "")
        .replace(/(\d+)\.(\d+)(?!\.)/g, "$1.$2.0"),
    );
  const range = parts.join(" ");
  return semver.validRange(range);
}

/** A `rust-toolchain(.toml)` channel the install step must fetch with rustup, or null. */
export function rustFor(tree: RepoTree, root: string): ToolchainPick | null {
  const toml = read(tree, root, "rust-toolchain.toml");
  const plain = read(tree, root, "rust-toolchain");
  const channel = toml
    ? /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1]
    : plain?.trim().split(/\s+/)[0];
  if (!channel || !/^[\w.-]+$/.test(channel)) return null;
  return { version: channel, source: toml ? "rust-toolchain.toml" : "rust-toolchain" };
}

/** Plan environment and extra install steps for a pick (PATH first, so the picked runtime wins). */
export const SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export function nodeEnv(pick: ToolchainPick | null): Record<string, string> {
  return pick && pick.version !== "24" ? { PATH: `/opt/node/${pick.version}/bin:${SANDBOX_PATH}` } : {};
}

export function pythonEnv(pick: ToolchainPick | null): Record<string, string> {
  return pick && pick.version !== "3.12"
    ? { PATH: `/opt/python/${pick.version}/bin:${SANDBOX_PATH}`, UV_PYTHON: pick.version }
    : {};
}

export function rustToolchainBin(channel: string) {
  return `/usr/local/rustup/toolchains/${channel}-x86_64-unknown-linux-gnu/bin`;
}
