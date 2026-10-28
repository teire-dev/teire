import { advisoriesWithCoverage } from "../advisories";
import type { DependencyInstance, Ecosystem } from "../contract";
import { assess, summariseFindings } from "../impact";
import { getPackageInfo, type RegistryOptions } from "../registry/clients";
import { chooseFixedTarget, type TargetDecision, type TargetPolicy } from "../registry/target";
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
  policyFor: (instance: DependencyInstance) => TargetPolicy,
): Promise<Assessment<P>[]> {
  const instances = [
    ...new Map(
      project.instances
        .filter((i) => i.version && i.source === "registry")
        .filter((i) => !options.onlyPackage || i.name === options.onlyPackage)
        .map((i) => [`${i.name}@${i.version}@${i.direct ? i.workspace : "."}`, i] as const),
    ).values(),
  ];
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
    const policy = policyFor(instance);
    // Each advisory's smallest fix on the installed line; the highest of those clears them all.
    const fixes = records
      .map((r) => chooseFixedTarget(info, instance.version ?? "", r.applicability.fixedIn, policy, scheme))
      .flatMap((d) => (d.kind === "upgrade" ? [d.to] : []));
    const required = fixes.sort((x, y) => scheme.compare(y, x))[0];
    const decision: TargetDecision = required
      ? chooseFixedTarget(info, instance.version, [required], policy, scheme)
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
