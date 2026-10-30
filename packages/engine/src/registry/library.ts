import type { Ecosystem } from "../contract";
import { getPackageInfo, type RegistryOptions } from "./clients";

/**
 * Which of a project's manifests are published libraries (S18.5), the way Dependabot's `auto`
 * strategy decides: a package that isn't private and whose own name is on its registry. Their
 * runtime ranges widen; an app's bump. `upgrades.versioning` can say `widen` or `increase` for all.
 */
export async function widenedManifests(
  ecosystem: Ecosystem,
  manifests: { path: string; name: string | null; private?: boolean }[],
  options: RegistryOptions,
): Promise<string[]> {
  if (options.versioning === "increase") return [];
  if (options.versioning === "widen") return manifests.map((m) => m.path);
  const out: string[] = [];
  for (const m of manifests) {
    if (!m.name || m.private) continue;
    const info = await getPackageInfo(ecosystem, m.name, options).catch(() => null);
    if (info?.versions.length) out.push(m.path);
  }
  return out;
}
