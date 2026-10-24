import { type ChangeV2, changeV2 } from "../contract";
import type { PackageInfo } from "./types";

/** deps.dev folds PyPI and Cargo yanks into `isDeprecated` (cross-cutting.md §3). */
const YANK_ECOSYSTEMS = new Set(["pypi", "cargo"]);
const SECURITY_WORDS = /security|vulnerab|CVE-\d|GHSA-|malicious|compromised/i;

/**
 * A change record for one deprecated or yanked version a repo has locked (rule 12: the registry's
 * own flag, quoted). Deprecations annotate unless they name a vulnerability; a yank means a fresh
 * resolution can no longer pick the version, so it counts as already broken.
 */
export function deprecationChange(info: PackageInfo, version: string): ChangeV2 | null {
  const v = info.versions.find((x) => x.version === version);
  if (!v || v.deprecated === null) return null;
  const yanked = YANK_ECOSYSTEMS.has(info.ecosystem);
  const message = v.deprecated.trim();
  const security = SECURITY_WORDS.test(message);
  return changeV2.parse({
    schemaVersion: 2,
    id: `${info.ecosystem}/${info.name}/${yanked ? "yanked" : "deprecated"}/${version}`,
    subject: { kind: "package", ecosystem: info.ecosystem, name: info.name },
    kind: yanked ? "package-yanked" : "package-deprecated",
    title: `${info.name}@${version} is ${yanked ? "yanked" : "deprecated"}`,
    summary:
      message ||
      `The registry marks ${info.name}@${version} as ${yanked ? "yanked" : "deprecated"} without a message.`,
    applicability: {
      class: security ? "security" : yanked ? "already-broken" : "notice",
      affectedRange: version,
    },
    sources: [
      {
        url: info.source.url,
        kind: "registry",
        trustBasis: "registry",
        ...(message ? { quote: message } : {}),
        contentHash: info.source.contentHash,
        checkedAt: info.source.checkedAt,
      },
    ],
    provenance: { method: "feed", confidence: { overall: 1 } },
    visibility: "public",
    status: "confirmed",
  });
}
