import { type ChangeV2, changeV2 } from "../contract";
import type { Retraction, Retractions } from "./go";
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

/**
 * A change record for a Go version its own authors retracted (go.dev/ref/mod#go-mod-file-retract):
 * the module's go.mod says so, with their reason quoted. Go still builds it but `go get` and
 * `go list -m -u` steer away from it; a reason naming a vulnerability makes it security.
 */
export function retractedChange(
  name: string,
  version: string,
  r: Retraction,
  source: NonNullable<Retractions["source"]>,
): ChangeV2 {
  const message = r.rationale ?? "";
  return changeV2.parse({
    schemaVersion: 2,
    id: `go/${name}/retracted/${version}`,
    subject: { kind: "package", ecosystem: "go", name },
    kind: "package-yanked",
    title: `${name}@${version} is retracted`,
    summary: message
      ? `The module's authors retracted ${version}: ${message}`
      : `The module's authors retracted ${version} without saying why.`,
    applicability: {
      class: SECURITY_WORDS.test(message) ? "security" : "notice",
      affectedRange: r.low === r.high ? r.low : `>=${r.low}, <=${r.high}`,
    },
    sources: [
      {
        url: source.url,
        kind: "registry",
        trustBasis: "registry",
        ...(message ? { quote: message } : {}),
        contentHash: source.contentHash,
        checkedAt: source.checkedAt,
      },
    ],
    provenance: { method: "feed", confidence: { overall: 1 } },
    visibility: "public",
    status: "confirmed",
  });
}
