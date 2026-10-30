import { advisoriesWithCoverage } from "../advisories";
import type { DependencyInstance, Ecosystem } from "../contract";
import { assess, summariseFindings } from "../impact";
import { getPackageInfo, type RegistryOptions } from "../registry/clients";
import { chooseFixedTarget, patchedHold, type TargetDecision, type TargetPolicy } from "../registry/target";
import type { VersionScheme } from "../registry/versions";
import type { ScanCoverage } from "./coverage";
import type { AssessedProject, Assessment } from "./js";

/**
 * Advisories for every locked version in a project, direct and transitive (D51), any ecosystem:
 * one assessment per affected instance, targeting the smallest version that clears every advisory
 * it has, inside the repo's pins.
 */
export async function securityAssessments<P extends AssessedProject>(
  project: P,
  ecosystem: Ecosystem,
  scheme: VersionScheme,
  options: RegistryOptions & {
    onlyPackage?: string;
    githubToken?: string;
    onProgress?: (line: string) => void;
    coverage?: ScanCoverage;
  },
  policyFor: (instance: DependencyInstance) => TargetPolicy | Promise<TargetPolicy>,
): Promise<Assessment<P>[]> {
  // One per locked version and workspace. A root project's direct dependency and its lockfile entry
  // share a key: the direct one is kept, so the advisory says "a direct dependency" where it is.
  const byKey = new Map<string, DependencyInstance>();
  for (const i of project.instances) {
    if (!i.version || i.source !== "registry" || (options.onlyPackage && i.name !== options.onlyPackage))
      continue;
    const key = `${i.name}@${i.version}@${i.direct ? i.workspace : "."}`;
    if (!byKey.get(key)?.direct) byKey.set(key, i);
  }
  const instances = [...byKey.values()];
  if (!instances.length) return [];
  options.onProgress?.(`advisories for ${instances.length} locked versions`);
  // How complete the lookup was is recorded, never assumed: a failure is "unavailable", not "none" (D96).
  const { matches, coverage } = await advisoriesWithCoverage(
    instances.map((i) => ({ ecosystem, name: i.name, version: i.version ?? "" })),
    { githubToken: options.githubToken },
  );
  options.coverage?.advisories.push({ ecosystem, root: project.root, ...coverage });
  if (coverage.status !== "complete")
    options.onProgress?.(`advisories ${coverage.status}: ${coverage.notes.join("; ")}`);
  const out: Assessment<P>[] = [];
  for (const instance of instances) {
    const records = matches
      .filter((m) => m.query.name === instance.name && m.query.version === instance.version)
      .map((m) => m.record);
    if (!records.length || !instance.version) continue;
    const info = await getPackageInfo(ecosystem, instance.name, options).catch(() => {
      options.coverage?.lookupsFailed.push({ ecosystem, name: instance.name });
      return null;
    });
    if (!info) continue;
    const policy = await policyFor(instance);
    // Each advisory's smallest fix on the installed line; the highest of those clears them all.
    const fixes = records
      .map((r) => chooseFixedTarget(info, instance.version ?? "", r.applicability.fixedIn, policy, scheme))
      .flatMap((d) => (d.kind === "upgrade" ? [d.to] : []));
    const highest = fixes.sort((x, y) => scheme.compare(y, x))[0];
    // The updater's lowest resolvable fix, when it is above the lowest published one, is the floor.
    const floor = options.targetFloor?.name === instance.name ? options.targetFloor.version : undefined;
    const required = floor && (!highest || scheme.compare(floor, highest) > 0) ? floor : highest;
    const decision: TargetDecision = required
      ? patchedHold(chooseFixedTarget(info, instance.version, [required], policy, scheme), instance)
      : { kind: "blocked", from: instance.version, reason: "no fixed version is published", skipped: [] };
    const target = decision.kind === "upgrade" ? decision.to : null;
    const findings = assess({
      instance,
      target,
      isMajor: decision.kind === "upgrade" && decision.isMajor,
      records,
      locate: null,
    });
    out.push({
      purpose: "security",
      project,
      instance,
      info,
      decision,
      diff: null,
      records,
      deprecation: null,
      located: null,
      findings,
      summary: summariseFindings(findings),
      priority: target ? Math.min(...findings.map((f) => f.priority ?? 4)) : null,
    });
  }
  return out;
}
