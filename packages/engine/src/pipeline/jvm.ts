import { REGISTRY } from "../constants";
import type { DependencyInstance } from "../contract";
import { runFix } from "../fix/run";
import { jvmTransaction } from "../fix/upgrade-jvm";
import { composeFixPullRequest } from "../github/compose";
import { assess, locateTargets, summariseFindings } from "../impact";
import { type JvmProject, readJvmInventory } from "../inventory/jvm";
import type { RepoTree } from "../inventory/tree";
import { locateJvm } from "../locate/jvm";
import { documentsForReading, extractNotes, migrationNotes, noteRecords } from "../notes/extract";
import { gatherJvmNotes } from "../notes/sources";
import { getPackageInfo, type RegistryOptions } from "../registry/clients";
import { deprecationChange } from "../registry/deprecation";
import { mavenFlavor } from "../registry/maven-version";
import { chooseTarget, type TargetPolicy } from "../registry/target";
import { mavenScheme } from "../registry/versions";
import { jvmSurfaceDiff } from "../surface/jvm";
import { jvmDocsLookup } from "../surface/jvmdoc";
import { surfaceChangeRecords } from "../surface/records";
import type { SurfaceDiff } from "../surface/types";
import { detectJvmChecks } from "../verify/jvm-commands";
import type { Assessment, FixDependencyInput, FixDependencyResult } from "./js";
import { securityAssessments } from "./security";

/**
 * The JVM loop (plan S08): assess (POMs / Gradle builds, catalogs and lockfiles → target in the same
 * flavor → japicmp diff of both jars, Kotlin deprecation levels included → import-resolved sites →
 * verdicts, plus advisories) and fix (notes → version edit + Gradle lock update → agent → baseline
 * vs after in the JVM sandbox: warm-up online, `test-compile`/`verify` or `testClasses`/`test`
 * offline, on the repo's JDK → PR body).
 */
export interface JvmAssessOptions extends RegistryOptions {
  cooldownDays?: number;
  onlyPackage?: string;
  advisories?: boolean;
  githubToken?: string;
  surfaceDiff?: (name: string, from: string, to: string) => Promise<SurfaceDiff>;
  onProgress?: (line: string) => void;
}

function jvmPolicy(instance: DependencyInstance, options: JvmAssessOptions): TargetPolicy {
  const minutes = (options.cooldownDays ?? REGISTRY.cooldownDays) * 1440;
  const flavor = instance.version ? mavenFlavor(instance.version) : "";
  return {
    now: options.now ?? new Date(),
    minAgeMinutes: () => minutes,
    pins: [],
    allowPrerelease: instance.version ? mavenScheme.isPrerelease(instance.version) : false,
    fallbackMajors: 0,
    // A line published in flavors (`-jre`, `-android`) stays in its own; an unflavored version
    // may move to one (Guava 19.0 → 33.x-jre), never to the Android line.
    exclude: (v) => {
      const f = mavenFlavor(v);
      if (flavor && f !== flavor) return `a different flavor (${f || "none"}) than ${flavor}`;
      if (!flavor && f === "android") return "the Android flavor";
      return null;
    },
  };
}

/** Argument counts each removed overload's key still accepts: `transform(a, b, c) | transform(d)` → [3, 1]. */
function aritiesLeft(diff: SurfaceDiff) {
  const out = new Map<string, number[]>();
  for (const c of diff.changes) {
    if (c.kind !== "arity-changed" || !c.after || !c.declKey) continue;
    const counts = c.after.split(" | ").map((sig) => {
      const inside = /\(([^)]*)\)/.exec(sig)?.[1]?.trim() ?? "";
      return inside ? inside.split(",").length : 0;
    });
    out.set(c.declKey, [...new Set([...(out.get(c.declKey) ?? []), ...counts])]);
  }
  return out;
}

/** Packages the changed classes live in (`com.google.common.base.Objects` → `com.google.common.base`). */
function packagesOf(declKeys: ReadonlySet<string>) {
  const out = new Set<string>();
  for (const k of declKeys) {
    const cls = k.replace(/^kotlin:/, "").split("#")[0] as string;
    const outer = cls.split("$")[0] as string;
    const pkg = outer.slice(0, outer.lastIndexOf("."));
    if (pkg) out.add(pkg);
  }
  return [...out];
}

export async function assessJvmRepo(repoDir: string, tree: RepoTree, options: JvmAssessOptions) {
  const projects = readJvmInventory(tree);
  const assessments: Assessment<JvmProject>[] = [];
  const diffOf = options.surfaceDiff ?? jvmSurfaceDiff;
  for (const project of projects) {
    const seen = new Set<string>();
    for (const instance of project.instances) {
      if (!instance.direct || instance.source !== "registry") continue;
      if (options.onlyPackage && instance.name !== options.onlyPackage) continue;
      // One assessment per artifact and version, however many modules declare it.
      const id = `${instance.name}@${instance.version}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const base: Assessment<JvmProject> = {
        purpose: "upgrade",
        project,
        instance,
        info: null,
        decision: null,
        diff: null,
        records: [],
        deprecation: null,
        located: null,
        findings: [],
        summary: null,
        priority: null,
      };
      if (!instance.version) {
        assessments.push(base);
        continue;
      }
      const info = await getPackageInfo("maven", instance.name, options).catch(() => null);
      if (!info) {
        assessments.push(base);
        continue;
      }
      const decision = chooseTarget(info, instance.version, jvmPolicy(instance, options), mavenScheme);
      const a: Assessment<JvmProject> = {
        ...base,
        info,
        decision,
        deprecation: deprecationChange(info, instance.version),
      };
      if (decision.kind === "upgrade" && decision.isMajor) {
        options.onProgress?.(`${instance.name} ${instance.version} → ${decision.to}: japicmp`);
        a.diff = await diffOf(instance.name, instance.version, decision.to);
        a.records = surfaceChangeRecords(a.diff);
        const { declKeys } = locateTargets(a.records);
        a.located = locateJvm({
          repoDir,
          tree,
          projectRoot: project.root,
          packages: packagesOf(declKeys),
          declKeys,
          keptMethodNames: new Set(a.diff.keptMethodNames ?? []),
          aritiesLeft: aritiesLeft(a.diff),
        });
        a.findings = assess({
          instance,
          target: decision.to,
          isMajor: true,
          records: a.records,
          locate: a.located,
        });
        a.summary = summariseFindings(a.findings);
        const breaking = a.summary.breaking.map((f) => f.priority ?? 4);
        a.priority = breaking.length ? Math.min(...breaking) : 4;
      } else if (decision.kind === "upgrade") {
        a.summary = { verdict: "not_affected", breaking: [], annotations: [], coverage: null };
        a.priority = 4;
      }
      assessments.push(a);
    }
    if (options.advisories !== false)
      assessments.push(
        ...(await securityAssessments(project, "maven", mavenScheme, options, (instance) =>
          jvmPolicy(instance, options),
        )),
      );
  }
  return { projects, assessments };
}

export async function fixJvmDependency(
  input: Omit<FixDependencyInput, "assessment"> & { assessment: Assessment<JvmProject> },
): Promise<FixDependencyResult> {
  const { assessment: a, options } = input;
  const decision = a.decision;
  if (decision?.kind !== "upgrade" || !a.instance.version)
    throw new Error(`${a.instance.name} has no upgrade target`);
  const target = decision.to;
  const from = a.instance.version;

  input.onEvent?.({ step: "transaction", detail: `reading release notes ${from} → ${target}` });
  const { sources, notes: notesWhy } = await gatherJvmNotes(a.instance.name, from, target, options);
  if (!sources.length)
    input.onEvent?.({
      step: "transaction",
      detail: `no release notes read: ${notesWhy.join("; ") || "none found"}`,
    });
  const docs = documentsForReading(sources);
  const extraction = docs.length
    ? await extractNotes(
        input.tf,
        docs,
        {
          name: a.instance.name,
          from,
          to: target,
          removedApis: (a.summary?.breaking ?? []).flatMap((f) =>
            f.callSites.map((c) => c.snippet.trim().slice(0, 80)),
          ),
        },
        input.prices,
      )
    : null;
  const notes = extraction ? migrationNotes(extraction) : [];
  const behaviour = extraction ? noteRecords(extraction, { name: a.instance.name, from, to: target }) : [];
  if (extraction)
    input.onEvent?.({
      step: "transaction",
      model: extraction.receipt.model,
      detail: `${extraction.items.length} quoted item(s) from ${sources.length} source(s), ${extraction.dropped.length} dropped${extraction.error ? `; ${extraction.error}` : ""}`,
      costUsd: extraction.receipt.costUsd,
    });

  const plan = detectJvmChecks(input.tree, a.project);
  const run = await runFix({
    tf: input.tf,
    prices: input.prices,
    backend: input.backend,
    runId: input.runId,
    repoDir: input.repoDir,
    tree: input.tree,
    tarball: input.tarball,
    project: a.project,
    plan,
    transaction: jvmTransaction(input.tree, a.project, a.instance, target),
    instance: a.instance,
    target,
    findings: [...(a.summary?.breaking ?? []), ...(a.summary?.annotations ?? [])],
    records: a.records,
    notes,
    targetDir: "",
    targetPaths: new Set(),
    docs: jvmDocsLookup(a.instance.name, target, a.diff?.changes ?? []),
    onEvent: input.onEvent,
  });
  const groupKey = `maven/${a.instance.name}/${target}`;
  const pr = composeFixPullRequest({
    repo: input.repo,
    runId: input.runId,
    ...(input.runUrl ? { runUrl: input.runUrl } : {}),
    groupKey,
    instance: a.instance,
    run,
    plan,
    backendNote: input.backendNote,
    summary: a.summary ?? { verdict: "not_affected", breaking: [], annotations: [], coverage: null },
    records: a.records,
    notes,
    behaviour,
    ...(extraction ? { notesReceipt: extraction.receipt } : {}),
  });
  return { run, pr, groupKey, behaviour, notesReceipt: extraction?.receipt ?? null };
}
