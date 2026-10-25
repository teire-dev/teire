import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PYTHON, REGISTRY, SURFACE } from "../constants";
import { guardedFetch } from "../net/fetch";
import { runPythonHelper } from "../python/helper";
import type { RegistryOptions } from "../registry/clients";
import { getPypiIndex, pickWheel } from "../registry/pypi";
import type { SurfaceChange, SurfaceChangeKind, SurfaceDiff, SymbolKind } from "./types";

/**
 * PyPI API-surface diff (plan S03, research python.md §5): both versions' wheels downloaded by the
 * Index API's URL, checked against its sha256, unzipped by the helper (links, absolute paths and
 * `..` refused), then griffe compares them with `allow_inspection=False`, so no package code runs.
 * griffe misses return/attribute type changes and dependency swaps; release notes cover those.
 */
export interface FetchedWheel {
  name: string;
  version: string;
  dir: string;
  sha256: string;
  topLevel: string[];
  filename: string;
}

interface UnpackResult {
  ok: boolean;
  error?: string;
  sha256?: string;
  topLevel?: string[];
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function fetchPypiWheel(
  name: string,
  version: string,
  options: RegistryOptions & { cacheDir?: string },
): Promise<FetchedWheel> {
  const base = join(options.cacheDir ?? SURFACE.cacheDir, "pypi", name, version);
  const stamp = join(base, ".teire-wheel.json");
  if (await exists(stamp)) return JSON.parse(await readFile(stamp, "utf8")) as FetchedWheel;
  const index = await getPypiIndex(name, options);
  if (!index) throw new Error(`${name} is not on PyPI`);
  const file = pickWheel(index, version);
  if (!file)
    throw new Error(`${name} ${version} publishes no wheel (sdists are not read: building one runs code)`);
  const res = await guardedFetch(file.url, {
    allowHosts: ["files.pythonhosted.org"],
    maxBytes: REGISTRY.maxTarballBytes,
  });
  if (res.status !== 200) throw new Error(`wheel ${res.status} for ${file.filename}`);
  const scratch = await mkdtemp(join(tmpdir(), "teire-wheel-"));
  try {
    const wheelPath = join(scratch, file.filename);
    await writeFile(wheelPath, res.body);
    const staging = join(scratch, "unpacked");
    const result = await runPythonHelper<UnpackResult>("unpack-wheel", [wheelPath, staging, file.sha256]);
    if (!result.ok) throw new Error(`wheel ${file.filename}: ${result.error}`);
    const fetched: FetchedWheel = {
      name,
      version,
      dir: join(base, "wheel"),
      sha256: result.sha256 ?? file.sha256,
      topLevel: result.topLevel ?? [],
      filename: file.filename,
    };
    await mkdir(base, { recursive: true });
    await rm(fetched.dir, { recursive: true, force: true });
    await rename(staging, fetched.dir);
    await writeFile(stamp, JSON.stringify(fetched));
    return fetched;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface Breakage {
  kind: string;
  path: string;
  canonical: string;
  old: string | null;
  new: string | null;
  line: number | null;
  memberKind: string;
}

const KIND: Record<string, { kind: SurfaceChangeKind; severity: SurfaceChange["severity"] }> = {
  OBJECT_REMOVED: { kind: "removed", severity: "breaking" },
  MODULE_REMOVED: { kind: "entry-removed", severity: "breaking" },
  PARAMETER_REMOVED: { kind: "parameter-removed", severity: "breaking" },
  PARAMETER_ADDED_REQUIRED: { kind: "arity-changed", severity: "breaking" },
  PARAMETER_CHANGED_REQUIRED: { kind: "arity-changed", severity: "breaking" },
  PARAMETER_MOVED: { kind: "parameter-changed", severity: "breaking" },
  PARAMETER_CHANGED_KIND: { kind: "parameter-changed", severity: "breaking" },
  PARAMETER_CHANGED_DEFAULT: { kind: "signature-changed", severity: "drift" },
  OBJECT_CHANGED_KIND: { kind: "signature-changed", severity: "drift" },
  CLASS_REMOVED_BASE: { kind: "signature-changed", severity: "drift" },
};

const MEMBER: Record<string, SymbolKind> = {
  class: "class",
  function: "function",
  property: "property",
  module: "module",
  variable: "variable",
  type: "type",
};

/** `[keyword-only] temperature: float | Omit = omit` → `temperature`. */
export function parameterName(text: string | null) {
  return text
    ? (/(?:\]\s*)?\**([A-Za-z_]\w*)\s*(?::|=|$)/.exec(text.replace(/^\[[^\]]*\]\s*/, ""))?.[1] ?? null)
    : null;
}

export async function pypiSurfaceDiff(
  name: string,
  fromVersion: string,
  toVersion: string,
  options: RegistryOptions & { cacheDir?: string },
): Promise<SurfaceDiff> {
  const t0 = Date.now();
  const from = await fetchPypiWheel(name, fromVersion, options);
  const t1 = Date.now();
  const to = await fetchPypiWheel(name, toVersion, options);
  const t2 = Date.now();
  const result = await runPythonHelper<{
    breakages: Breakage[];
    notes: string[];
    counts: Record<string, { old: number; new: number }>;
  }>("surface-diff", [from.dir, to.dir]);
  const changes: SurfaceChange[] = [];
  for (const b of result.breakages) {
    const mapped = KIND[b.kind];
    if (!mapped) continue;
    const param = b.kind.startsWith("PARAMETER_")
      ? (parameterName(b.old) ?? parameterName(b.new) ?? undefined)
      : undefined;
    changes.push({
      path: b.path,
      declKey: b.canonical,
      kind: mapped.kind,
      symbolKind: MEMBER[b.memberKind] ?? "unknown",
      severity: mapped.severity,
      before: b.old,
      after: b.new,
      ...(param ? { param } : {}),
    });
  }
  const counts: SurfaceDiff["counts"] = {};
  for (const c of changes) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  const total = (side: "old" | "new") => Object.values(result.counts).reduce((n, c) => n + c[side], 0);
  const unanalyzable = Object.keys(result.counts).length === 0;
  return {
    ecosystem: "pypi",
    name,
    fromVersion,
    toVersion,
    from: {
      source: { kind: "bundled" },
      symbols: total("old"),
      truncated: false,
      ms: t1 - t0,
      integrity: `sha256-${from.sha256}`,
    },
    to: {
      source: { kind: "bundled" },
      symbols: total("new"),
      truncated: false,
      ms: t2 - t1,
      integrity: `sha256-${to.sha256}`,
    },
    changes,
    counts,
    moved: {},
    unanalyzable,
    notes: [
      ...result.notes,
      ...(unanalyzable ? ["griffe read no module from either wheel"] : []),
      "griffe does not compare return or attribute types, or dependency swaps; release notes cover those",
    ],
    tool: {
      name: "griffe",
      version: PYTHON.packages.find((p) => p.startsWith("griffe"))?.split("==")[1] ?? "",
      noiseFilterVersion: SURFACE.noiseFilterVersion,
    },
  };
}
