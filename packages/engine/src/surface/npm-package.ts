import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REGISTRY, SURFACE } from "../constants";
import { extractTarGz } from "../inventory/archive";
import { guardedFetch } from "../net/fetch";
import { getNpmVersion, type RegistryOptions } from "../registry/clients";

/**
 * Downloads one npm package version, checks the bytes against the registry's `dist.integrity`
 * (sha512 SRI, shasum as the last resort) and unpacks it with Teire's own extractor into
 * `<cacheDir>/<name>/<version>/package`. Registry tarballs run no scripts and nothing here
 * executes package code (plan D58, D75).
 */
export class IntegrityError extends Error {}

const STAMP = ".teire-verified";

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Checks `bytes` against an SRI string (`sha512-<base64> sha1-…`), strongest algorithm first. */
export function verifyIntegrity(bytes: Uint8Array, integrity: string | null, shasum: string | null) {
  const entries = (integrity ?? "")
    .split(/\s+/)
    .map((e) => /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(e))
    .filter((m): m is RegExpExecArray => m !== null);
  const order = ["sha512", "sha384", "sha256", "sha1"];
  entries.sort((a, b) => order.indexOf(a[1] ?? "") - order.indexOf(b[1] ?? ""));
  const best = entries[0];
  if (best?.[1] && best[2]) {
    const actual = createHash(best[1]).update(bytes).digest("base64");
    if (actual !== best[2]) throw new IntegrityError(`${best[1]} mismatch`);
    return `${best[1]}-${actual}`;
  }
  if (shasum) {
    const actual = createHash("sha1").update(bytes).digest("hex");
    if (actual !== shasum) throw new IntegrityError("shasum mismatch");
    return `sha1-hex-${actual}`;
  }
  throw new IntegrityError("the registry gives no integrity for this tarball");
}

export interface FetchedPackage {
  name: string;
  version: string;
  /** Unpacked package root (holds package.json). */
  dir: string;
  integrity: string;
}

export async function fetchNpmPackage(
  name: string,
  version: string,
  options: RegistryOptions & { cacheDir?: string },
): Promise<FetchedPackage> {
  const base = join(options.cacheDir ?? SURFACE.cacheDir, name, version);
  const dir = join(base, "package");
  const stamp = join(base, STAMP);
  if (await exists(stamp)) return { name, version, dir, integrity: (await readFile(stamp, "utf8")).trim() };

  const detail = await getNpmVersion(name, version, options);
  if (!detail) throw new Error(`${name}@${version} is not on the npm registry`);
  const res = await guardedFetch(detail.dist.tarball, {
    allowHosts: [REGISTRY.hosts.npm],
    maxBytes: REGISTRY.maxTarballBytes,
  });
  if (res.status !== 200) throw new Error(`tarball ${res.status} for ${name}@${version}`);
  const integrity = verifyIntegrity(res.body, detail.dist.integrity, detail.dist.shasum);

  // Unpack beside the final place and rename, so two jobs on the same package never see half a tree.
  const staging = join(options.cacheDir ?? SURFACE.cacheDir, name, `.${version}.${randomUUID()}`);
  await mkdir(join(staging, "package"), { recursive: true });
  try {
    await extractTarGz(res.body, join(staging, "package"), { stripComponents: 1 });
    await writeFile(join(staging, STAMP), integrity);
    await mkdir(join(base, ".."), { recursive: true });
    // A directory without the stamp is a leftover from an interrupted run.
    if ((await exists(base)) && !(await exists(stamp))) await rm(base, { recursive: true, force: true });
    try {
      await rename(staging, base);
    } catch (error) {
      if (!(await exists(stamp))) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { name, version, dir, integrity };
}
