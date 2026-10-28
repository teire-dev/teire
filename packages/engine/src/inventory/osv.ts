import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { Ecosystem } from "../contract";

const run = promisify(execFile);

/**
 * osv-scanner as the universal lockfile reader (plan D56): one binary, one JSON shape, every
 * lockfile format of the six ecosystems. Extraction only, in the worker's safe mode (plan D75):
 *   --offline --no-resolve        no network, no remote POM resolution named by the repo
 *   --experimental-disable-plugins vulnmatch/osvlocal   no vulnerability matching (advisories are
 *                                 separate); v2.6.0 spells it this way, v2.7.0 adds `--x-disable-plugins`
 *   --config <empty file>         a repo's osv-scanner.toml cannot hide packages
 * Verified flags and output: context/09-build-research/generic/cross-cutting.md §1.
 */
export interface OsvPackage {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** Repo-relative lockfile or manifest the package came from. */
  sourcePath: string;
  groups: string[];
}

/** A package in an ecosystem Teire can't upgrade (Packagist, NuGet, Pub, Hex…): detect only (rule 8). */
export interface OtherPackage {
  /** OSV's ecosystem name, as advisories are queried. */
  ecosystem: string;
  name: string;
  version: string;
  sourcePath: string;
}

const ECOSYSTEM: Record<string, Ecosystem> = {
  npm: "npm",
  PyPI: "pypi",
  Maven: "maven",
  Go: "go",
  "crates.io": "cargo",
  RubyGems: "rubygems",
};

interface OsvOutput {
  results?: {
    source?: { path?: string };
    packages?: {
      package?: { name?: string; version?: string; ecosystem?: string };
      dependency_groups?: string[];
    }[];
  }[];
}

export async function osvExtract(dir: string, options: { bin?: string; timeoutMs?: number } = {}) {
  const bin = options.bin ?? process.env.OSV_SCANNER_BIN ?? "osv-scanner";
  const scratch = await mkdtemp(join(tmpdir(), "teire-osv-"));
  const emptyConfig = join(scratch, "empty.toml");
  await writeFile(emptyConfig, "");
  try {
    const { stdout } = await run(
      bin,
      [
        "scan",
        "source",
        "-r",
        "--offline",
        "--no-resolve",
        "--format",
        "json",
        "--all-packages",
        "--experimental-disable-plugins",
        "vulnmatch/osvlocal",
        "--config",
        emptyConfig,
        dir,
      ],
      {
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 128 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "" },
      },
    );
    const output = JSON.parse(stdout) as OsvOutput;
    const packages: OsvPackage[] = [];
    const others: OtherPackage[] = [];
    const unknownEcosystems = new Set<string>();
    for (const result of output.results ?? []) {
      const sourcePath = result.source?.path ? relative(dir, result.source.path) : "";
      for (const entry of result.packages ?? []) {
        const ecosystem = ECOSYSTEM[entry.package?.ecosystem ?? ""];
        if (!ecosystem) {
          if (entry.package?.ecosystem) {
            unknownEcosystems.add(entry.package.ecosystem);
            if (entry.package.name && entry.package.version)
              others.push({
                ecosystem: entry.package.ecosystem,
                name: entry.package.name,
                version: entry.package.version,
                sourcePath,
              });
          }
          continue;
        }
        if (!entry.package?.name || !entry.package.version) continue;
        packages.push({
          ecosystem,
          name: entry.package.name,
          version: entry.package.version,
          sourcePath,
          groups: entry.dependency_groups ?? [],
        });
      }
    }
    return { packages, others, unknownEcosystems: [...unknownEcosystems] };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
