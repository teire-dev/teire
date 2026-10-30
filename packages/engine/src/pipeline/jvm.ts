import { createHash } from "node:crypto";
import { PRIORITY, REGISTRY, VERIFY } from "../constants";
import type { DependencyInstance } from "../contract";
import { wrapperTransaction } from "../fix/gradle-wrapper";
import { plannedRenames } from "../fix/renames";
import { runFix } from "../fix/run";
import { jvmTransaction } from "../fix/upgrade-jvm";
import { composeFixPullRequest } from "../github/compose";
import { assess, locateTargets, summariseFindings } from "../impact";
import { interpolateWith, type JvmProject, readJvmInventory, VERSION } from "../inventory/jvm";
import type { RepoTree } from "../inventory/tree";
import { locateJvm } from "../locate/jvm";
import { locateBytecode, removedOverloads } from "../locate/jvm-bytecode";
import { documentsForReading, extractNotes, migrationNotes, noteRecords } from "../notes/extract";
import { declaredPackageNotes, gatherJvmNotes } from "../notes/sources";
import type { RegistryOptions } from "../registry/clients";
import { deprecationChange } from "../registry/deprecation";
import { remoteManaged } from "../registry/maven-pom";
import { mavenFlavor } from "../registry/maven-version";
import { applyPrivateClaims, comparable, lookupPackage } from "../registry/private";
import { mavenSignals } from "../registry/supply-chain";
import {
  beyondRange,
  chooseTarget,
  comparedInstance,
  type TargetDecision,
  type TargetPolicy,
  withTargetMax,
} from "../registry/target";
import { mavenScheme } from "../registry/versions";
import { javaRequirement, jvmSurfaceDiff } from "../surface/jvm";
import { jvmDocsLookup } from "../surface/jvmdoc";
import { surfaceChangeRecords, unreadableDiff } from "../surface/records";
import type { SurfaceDiff } from "../surface/types";
import type { VerifyBackend } from "../verify/backend";
import { withVerifyOverrides } from "../verify/commands";
import { detectJvmChecks } from "../verify/jvm-commands";
import { overBudget, type ScanProbeTarget, scanProbe } from "../verify/scan-probe";
import type { ScanCoverage } from "./coverage";
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
  /** The scan's record of what it could not check (D96). */
  coverage?: ScanCoverage;
  /**
   * The sandbox and the commit's tarball, for the repo's own compiled classes at scan time (S19):
   * a compile, then the exact references; without them JVM sites stay syntactic.
   */
  bytecode?: () => Promise<ScanProbeTarget>;
}

function jvmPolicy(instance: DependencyInstance, options: JvmAssessOptions): TargetPolicy {
  const minutes = (options.cooldownDays ?? REGISTRY.cooldownDays) * 1440;
  const flavor = instance.version ? mavenFlavor(instance.version) : "";
  return {
    now: options.now ?? new Date(),
    minAgeMinutes: () => minutes,
    pins: [],
    allowPrerelease: instance.version ? mavenScheme.isPrerelease(instance.version) : false,
    fallbackMajors: options.fallbackMajors ?? 0,
    // A line published in flavors (`-jre`, `-android`) stays in its own; an unflavored version
    // may move to one (Guava 19.0 → 33.x-jre), never to the Android line.
    exclude: (v) => {
      const f = mavenFlavor(v);
      if (flavor && f !== flavor) return `a different flavor (${f || "none"}) than ${flavor}`;
      if (!flavor && f === "android") return "the Android flavor";
      // Maven sorts `20040616` above `3.2.2`; it's an old date-stamped release, not a newer one.
      if (DATE_STAMPED.test(v) && !(instance.version && DATE_STAMPED.test(instance.version)))
        return "a date-stamped release, not a newer version";
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

/**
 * Versions a Maven module leaves to POMs outside the repo (D-28): its remote parent chain and the
 * BOMs it imports are read, so a Spring Boot starter has its version (and its advisories) instead
 * of "unresolved". Each such instance says what manages it.
 */
async function applyRemoteManaged(project: JvmProject, options: JvmAssessOptions) {
  const budget = { left: REGISTRY.maxRemotePoms };
  for (const mod of project.modules) {
    if (!mod.remote) continue;
    const open = project.instances.filter((i) => i.workspace === mod.dir && i.version === null && i.direct);
    if (!open.length) continue;
    const remote = await remoteManaged(mod.remote, options, budget).catch((error: unknown) => {
      project.notes.push(
        `${mod.manifest}: remote parent POMs not read (${error instanceof Error ? error.message : String(error)})`,
      );
      return null;
    });
    if (!remote) continue;
    for (const note of remote.notes) if (!project.notes.includes(note)) project.notes.push(note);
    const by = mod.remote.parent ? mod.remote.parent.split(":").slice(0, 2).join(":") : null;
    for (const i of open) {
      const property = i.declaredRange?.includes("${")
        ? interpolateWith(remote.props, i.declaredRange)
        : null;
      const managed = (i.role === "plugin" ? remote.plugins : remote.dependencies).get(i.name);
      const version = property ?? (i.declaredRange ? null : (managed?.version ?? null));
      if (!version || !VERSION.test(version)) continue;
      i.version = version;
      i.resolvedBy = "toolchain";
      i.managedBy =
        property && mod.remote.parent
          ? `${by} ${mod.remote.parent.split(":")[2]} (property)`
          : property
            ? "a property this repository's POMs define"
            : managed?.by;
      delete i.unresolvedReason;
    }
  }
}

/** `20040616`: a date-stamped release Maven orders above every `x.y` (commons-collections). */
const DATE_STAMPED = /^(?:19|20)\d{6}(?:[.-]\d+)*$/;

export async function assessJvmRepo(repoDir: string, tree: RepoTree, options: JvmAssessOptions) {
  const projects = readJvmInventory(tree);
  for (const project of projects) if (project.manager === "maven") await applyRemoteManaged(project, options);
  const assessments: Assessment<JvmProject>[] = [];
  const diffOf = options.surfaceDiff ?? jvmSurfaceDiff;
  // A JVM build without a lockfile (Maven always, Gradle without gradle.lockfile) resolves its
  // transitive tree only when it runs, which is in the sandbox: until the scan reads that tree,
  // transitive dependencies and their advisories are not checked, so advisory coverage for the
  // project is "partial", never "complete" (D-31).
  for (const project of projects.filter((p) => !p.lockfile))
    options.coverage?.advisories.push({
      ecosystem: "maven",
      root: project.root,
      status: "partial",
      structural: true,
      notes: [
        `${project.manager === "maven" ? "Maven" : "Gradle without gradle.lockfile"}: only declared dependencies are checked; transitive dependencies and their advisories are not.`,
      ],
    });
  for (const project of projects) {
    // What a private registry the repo names serves is read there, or not compared (S18 review S1).
    applyPrivateClaims(project.instances, "maven", options);
    const seen = new Set<string>();
    for (const declared of project.instances) {
      if (!declared.direct || !comparable("maven", declared, options)) continue;
      if (options.onlyPackage && declared.name !== options.onlyPackage) continue;
      // One assessment per artifact and version, however many modules declare it.
      const id = `${declared.name}@${declared.version ?? declared.declaredRange}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const base: Assessment<JvmProject> = {
        purpose: "upgrade",
        project,
        instance: declared,
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
      // A locked version, or a registry range to take the floor of (D-37); otherwise unresolved.
      if (!declared.version && !(declared.declaredRange && mavenScheme.isRange(declared.declaredRange))) {
        assessments.push(base);
        continue;
      }
      const info = await lookupPackage("maven", declared, options).catch(() => {
        options.coverage?.lookupsFailed.push({ ecosystem: "maven", name: declared.name });
        return null;
      });
      if (!info) {
        assessments.push(base);
        continue;
      }
      const instance = comparedInstance(declared, info, mavenScheme);
      if (!instance?.version) {
        assessments.push(base);
        continue;
      }
      const floor = instance.resolvedBy === "range-floor";
      const chosen = chooseTarget(
        info,
        instance.version,
        withTargetMax(jvmPolicy(instance, options), instance.name, options, "maven", { project, instance }),
        mavenScheme,
      );
      const ranged = floor ? beyondRange(chosen, declared.declaredRange as string, mavenScheme) : chosen;
      // A version from a parent or BOM outside the repo moves when that does (D-28); it's reported,
      // and the parent or BOM is the upgrade.
      const decision: TargetDecision =
        instance.managedBy && ranged.kind === "upgrade"
          ? {
              kind: "blocked",
              from: ranged.from,
              reason: `its version comes from ${instance.managedBy}: upgrading that moves it`,
              skipped: ranged.skipped,
            }
          : ranged;
      const a: Assessment<JvmProject> = {
        ...base,
        info,
        decision,
        instance,
        // The floor isn't what installs get (the newest the range allows is): no deprecation from it.
        deprecation: floor ? null : deprecationChange(info, instance.version),
      };
      if (decision.kind === "upgrade" && decision.isMajor && instance.role) {
        // A parent, BOM, plugin, extension or wrapper: no API the code calls, so the build decides.
        a.summary = { verdict: "inconclusive", breaking: [], annotations: [], coverage: null };
        a.priority = 4;
      } else if (decision.kind === "upgrade" && decision.isMajor) {
        options.onProgress?.(`${instance.name} ${instance.version} → ${decision.to}: japicmp`);
        a.diff = await diffOf(instance.name, instance.version, decision.to).catch((error: unknown) =>
          unreadableDiff("maven", instance.name, instance.version as string, decision.to, error),
        );
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
        a.priority = PRIORITY.plainBump;
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
  if (options.bytecode)
    for (const project of projects) await scanTimeBytecode(tree, project, assessments, options);
  return { projects, assessments };
}

/**
 * The project's majors located from its compiled classes at scan time (S19): one sandbox compile per
 * project (the warm-up with the network, then the typecheck offline), then `teire-jvm refs` over
 * every major's packages. Lexical sites the bytecode can't show (inlined constants, Kotlin inline
 * bodies) stay; a compile that fails leaves the sites syntactic.
 */
async function scanTimeBytecode(
  tree: RepoTree,
  project: JvmProject,
  assessments: Assessment<JvmProject>[],
  options: JvmAssessOptions,
) {
  const majors = assessments.filter(
    (a) => a.project === project && a.located && a.diff && !a.instance.role && a.decision?.kind === "upgrade",
  );
  if (!options.bytecode || !majors.length) return;
  const keysOf = (a: Assessment<JvmProject>) => locateTargets(a.records).declKeys;
  const prefixes = [
    ...new Set(majors.flatMap((a) => packagesOf(keysOf(a)).map((p) => p.replace(/\./g, "/")))),
  ];
  const plan = detectJvmChecks(tree, project);
  const typecheck = plan.checks.find((c) => c.name === "typecheck")?.argv;
  if (!prefixes.length || !typecheck) return;
  // Opened only now, when a project needs it (S19 review B4).
  const probe = await options.bytecode();
  const skip = overBudget(probe, VERIFY.jvmInstallTimeoutSec + VERIFY.jvmProbeTimeoutSec);
  if (skip) {
    options.coverage?.notes.push(
      `${project.root === "." ? "JVM" : project.root}: the scan-time compile ${skip}; JVM sites stay syntactic`,
    );
    return;
  }
  options.onProgress?.(`${project.root}: compiling for exact references`);
  const out = "/tmp/teire-refs.tsv";
  const probed = await scanProbe(probe.backend, {
    id: `${probe.id}-refs-${createHash("sha256").update(project.root).digest("hex").slice(0, 8)}`,
    tarball: probe.tarball,
    plan,
    probe: ["sh", "-c", `${typecheck.join(" ")} && teire-jvm refs ${prefixes.join(",")} > ${out}`],
    output: out,
    installTimeoutSec: VERIFY.jvmInstallTimeoutSec,
    timeoutSec: VERIFY.jvmProbeTimeoutSec,
  }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ("error" in probed) {
    const note = `${project.root === "." ? "JVM" : project.root}: the scan-time compile failed (${probed.error.slice(0, 200)}); JVM sites stay syntactic`;
    options.onProgress?.(note);
    options.coverage?.notes.push(note);
    return;
  }
  const text = new TextDecoder().decode(probed.bytes);
  for (const a of majors) {
    if (!a.diff || a.decision?.kind !== "upgrade") continue;
    const declKeys = keysOf(a);
    const exact = locateBytecode({
      probe: text,
      tree,
      declKeys,
      overloads: removedOverloads(a.diff.changes),
      packages: packagesOf(declKeys),
      projectRoot: project.root,
    });
    const seen = new Set(exact.hits.map((h) => h.declKey));
    const kept = (a.located?.hits ?? []).filter((h) => !seen.has(h.declKey));
    a.located = { ...exact, hits: [...exact.hits, ...kept] };
    a.findings = assess({
      instance: a.instance,
      target: a.decision.to,
      isMajor: a.decision.isMajor,
      records: a.records,
      locate: a.located,
    });
    a.summary = summariseFindings(a.findings);
    const breaking = a.summary.breaking.map((f) => f.priority ?? 4);
    a.priority = breaking.length ? Math.min(...breaking) : 4;
  }
}

export async function fixJvmDependency(
  input: Omit<FixDependencyInput, "assessment"> & { assessment: Assessment<JvmProject> },
): Promise<FixDependencyResult> {
  const { assessment: a, options } = input;
  const decision = a.decision;
  if (decision?.kind !== "upgrade" || !a.instance.version)
    throw new Error(`${a.instance.name} has no upgrade target`);
  // The toolchain co-upgrade (S15.10): the Java the target's own metadata says it needs.
  const javaFloor = await javaRequirement(a.instance.name, decision.to).catch(() => null);
  const target = decision.to;
  const from = a.instance.version;

  input.onEvent?.({ step: "transaction", detail: `reading release notes ${from} → ${target}` });
  const { sources, notes: notesWhy } = await gatherJvmNotes(a.instance.name, from, target, options);
  // The repository's own teire.yml changelog for this package goes first (S16.1), never public (D53).
  const declared = await declaredPackageNotes(
    input.declaredSources,
    a.instance.name,
    from,
    target,
    mavenScheme,
  );
  if (declared.source) {
    const discovered = sources.filter((src) => src.kind !== "changelog");
    sources.splice(0, sources.length, declared.source, ...discovered);
    input.onEvent?.({
      step: "transaction",
      detail: `release notes from this repository's teire.yml: ${declared.source.url}`,
    });
  } else if (declared.note) input.onEvent?.({ step: "transaction", detail: declared.note });
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
  const behaviour = extraction
    ? noteRecords(extraction, { name: a.instance.name, from, to: target, ecosystem: "maven" })
    : [];
  if (extraction)
    input.onEvent?.({
      step: "transaction",
      model: extraction.receipt.model,
      detail: `${extraction.items.length} quoted item(s) from ${sources.length} source(s), ${extraction.dropped.length} dropped${extraction.error ? `; ${extraction.error}` : ""}`,
      costUsd: extraction.receipt.costUsd,
    });

  // After the baseline's checks compile the repo, its classes say exactly where the library is used.
  const { declKeys } = locateTargets(a.records);
  const prefixes = packagesOf(declKeys).map((p) => p.replace(/\./g, "/"));
  const plan = {
    ...withVerifyOverrides(detectJvmChecks(input.tree, a.project), a.project.root, input.verify),
    ...(prefixes.length ? { probe: ["teire-jvm", "refs", prefixes.join(",")] } : {}),
  };
  // Renames a quoted note names, at the located sites, proven by the target's own source (S15.4).
  const renames = await plannedRenames({
    ecosystem: "maven",
    name: a.instance.name,
    target,
    repoDir: input.repoDir,
    findings: [...(a.summary?.breaking ?? []), ...(a.summary?.annotations ?? [])],
    notes,
  });
  const run = await runFix({
    ...(renames.length ? { edits: renames } : {}),
    verify: input.verify,
    tf: input.tf,
    prices: input.prices,
    backend: input.backend,
    runId: input.runId,
    repoDir: input.repoDir,
    tree: input.tree,
    tarball: input.tarball,
    project: a.project,
    plan,
    transaction:
      input.transaction ??
      (await wrapperTransaction(input.tree, a.instance, target)) ??
      jvmTransaction(
        input.tree,
        a.project,
        a.instance,
        target,
        javaFloor
          ? {
              version: javaFloor,
              why: `${a.instance.name} ${target} needs Java ${javaFloor} (its published Gradle Module Metadata)`,
            }
          : undefined,
        advisoryReason(a.records, a.instance.name),
      ),
    instance: a.instance,
    target,
    findings: [
      ...(a.summary?.breaking ?? []),
      ...(a.summary?.annotations ?? []),
      ...(input.extraFindings ?? []),
    ],
    records: [...a.records, ...(input.extraRecords ?? [])],
    notes: [...notes, ...(input.extraNotes ?? []), ...(input.movedNotes ?? [])],
    ...(input.requestUpgrade ? { requestUpgrade: input.requestUpgrade } : {}),
    ...(input.depCache ? { depCache: input.depCache } : {}),
    targetDir: "",
    targetPaths: new Set(),
    docs: jvmDocsLookup(a.instance.name, target, a.diff?.changes ?? []),
    onEvent: input.onEvent,
  });
  // Sites from the compiled classes replace the lexical ones in the PR; lexical sites the bytecode
  // cannot show (inlined constants, Kotlin inline bodies) are kept.
  let summary = a.summary ?? {
    verdict: "not_affected" as const,
    breaking: [],
    annotations: [],
    coverage: null,
  };
  if (run.baselineProbe !== null && a.diff) {
    const exact = locateBytecode({
      probe: run.baselineProbe,
      tree: input.tree,
      declKeys,
      overloads: removedOverloads(a.diff.changes),
      packages: packagesOf(declKeys),
      projectRoot: a.project.root,
    });
    // A key the classes never reference may still be used where bytecode cannot show it (an inlined
    // constant, a Kotlin inline function's body): its lexical sites stay.
    const seen = new Set(exact.hits.map((h) => h.declKey));
    const kept = (a.located?.hits ?? []).filter((h) => !seen.has(h.declKey));
    const merged = { ...exact, hits: [...exact.hits, ...kept] };
    summary = summariseFindings(
      assess({ instance: a.instance, target, isMajor: true, records: a.records, locate: merged }),
    );
    plan.notes.push(
      `${exact.hits.length} site(s) read from the compiled classes on the baseline (javac/kotlinc-resolved)`,
    );
  }
  const groupKey = `maven/${a.instance.name}/${target}`;
  // Who published the target and what runs when it installs, against the installed version (D-14).
  const supplyChain = await mavenSignals(a.instance.name, from, target).catch(() => [] as string[]);
  const pr = composeFixPullRequest({
    ...(supplyChain.length ? { supplyChain } : {}),
    repo: input.repo,
    runId: input.runId,
    ...(input.options.targetMax ? { targetMax: input.options.targetMax } : {}),
    ...(input.fallbackFrom ? { fallbackFrom: input.fallbackFrom } : {}),
    ...(input.supersedes?.length ? { supersedes: input.supersedes } : {}),
    ...(input.runUrl ? { runUrl: input.runUrl } : {}),
    groupKey,
    instance: a.instance,
    run,
    plan,
    backendNote: input.backendNote,
    summary,
    records: a.records,
    notes: [...notes, ...(input.movedNotes ?? [])],
    behaviour,
    ...(extraction ? { notesReceipt: extraction.receipt } : {}),
  });
  return { run, pr, groupKey, behaviour, notesReceipt: extraction?.receipt ?? null };
}

/** The constraint's `because`: the advisories a transitive fix answers (S15.7). */
function advisoryReason(records: { kind: string; id: string }[], name: string) {
  const ids = records.filter((r) => r.kind === "security-advisory").map((r) => r.id.split("/").at(-1));
  return ids.length ? `Teire: fixes ${ids.join(", ")}` : `Teire: fixes a security advisory in ${name}`;
}
