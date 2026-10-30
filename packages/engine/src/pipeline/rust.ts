import { PRIORITY, REGISTRY } from "../constants";
import type { DependencyInstance } from "../contract";
import { plannedRenames } from "../fix/renames";
import { runFix } from "../fix/run";
import { cargoTransaction } from "../fix/upgrade-rust";
import { composeFixPullRequest } from "../github/compose";
import { assess, locateTargets, summariseFindings } from "../impact";
import { type RustProject, readRustInventory } from "../inventory/rust";
import type { RepoTree } from "../inventory/tree";
import { locateRust } from "../locate/rust";
import { documentsForReading, extractNotes, migrationNotes, noteRecords } from "../notes/extract";
import { declaredPackageNotes, gatherCargoNotes } from "../notes/sources";
import { cratesIndexLines } from "../registry/cargo";
import { getPackageInfo, type RegistryOptions } from "../registry/clients";
import { deprecationChange } from "../registry/deprecation";
import { crateSignals } from "../registry/supply-chain";
import {
  beyondRange,
  chooseTarget,
  comparedInstance,
  type TargetPolicy,
  withTargetMax,
} from "../registry/target";
import { cargoScheme } from "../registry/versions";
import { surfaceChangeRecords, unreadableDiff } from "../surface/records";
import { cargoSurfaceDiff } from "../surface/rust";
import { rustDocsLookup } from "../surface/rustdoc";
import type { SurfaceDiff } from "../surface/types";
import { withVerifyOverrides } from "../verify/commands";
import { detectRustChecks } from "../verify/rust-commands";
import type { ScanCoverage } from "./coverage";
import type { Assessment, FixDependencyInput, FixDependencyResult } from "./js";
import { securityAssessments } from "./security";

/**
 * The Rust loop (plan S06): assess (Cargo.toml + Cargo.lock → target → cargo-semver-checks on
 * docs.rs rustdoc JSON plus removed features → syntactic sites → verdicts, plus advisories) and
 * fix (notes → requirement edit + cargo update --precise → agent → baseline vs after in the Rust
 * sandbox, where `cargo build` names every line the upgrade broke → PR body).
 */
export interface RustAssessOptions extends RegistryOptions {
  cooldownDays?: number;
  onlyPackage?: string;
  advisories?: boolean;
  githubToken?: string;
  surfaceDiff?: (name: string, from: string, to: string) => Promise<SurfaceDiff>;
  onProgress?: (line: string) => void;
  /** The scan's record of what it could not check (D96). */
  coverage?: ScanCoverage;
}

/**
 * A crate's target policy. A version crates.io's index marks yanked is refused even before deps.dev
 * has caught up (it folds yanks into `isDeprecated` some time after the index says so).
 */
async function rustPolicy(instance: DependencyInstance, options: RustAssessOptions): Promise<TargetPolicy> {
  const minutes = (options.cooldownDays ?? REGISTRY.cooldownDays) * 1440;
  const yanked = new Set(
    (await cratesIndexLines(instance.name).catch(() => [])).filter((l) => l.yanked).map((l) => l.vers),
  );
  return {
    now: options.now ?? new Date(),
    minAgeMinutes: () => minutes,
    pins: [],
    allowPrerelease: instance.version ? cargoScheme.isPrerelease(instance.version) : false,
    fallbackMajors: options.fallbackMajors ?? 0,
    exclude: (version) => (yanked.has(version) ? "yanked on crates.io" : null),
  };
}

export async function assessRustRepo(repoDir: string, tree: RepoTree, options: RustAssessOptions) {
  const projects = readRustInventory(tree);
  const assessments: Assessment<RustProject>[] = [];
  const diffOf = options.surfaceDiff ?? cargoSurfaceDiff;
  for (const project of projects) {
    for (const declared of project.instances) {
      if (!declared.direct || declared.source !== "registry") continue;
      if (options.onlyPackage && declared.name !== options.onlyPackage) continue;
      const base: Assessment<RustProject> = {
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
      if (!declared.version && !(declared.declaredRange && cargoScheme.isRange(declared.declaredRange))) {
        assessments.push(base);
        continue;
      }
      const info = await getPackageInfo("cargo", declared.name, options).catch(() => {
        options.coverage?.lookupsFailed.push({ ecosystem: "cargo", name: declared.name });
        return null;
      });
      if (!info) {
        assessments.push(base);
        continue;
      }
      const instance = comparedInstance(declared, info, cargoScheme);
      if (!instance?.version) {
        assessments.push(base);
        continue;
      }
      const floor = instance.resolvedBy === "range-floor";
      const chosen = chooseTarget(
        info,
        instance.version,
        withTargetMax(await rustPolicy(instance, options), instance.name, options),
        cargoScheme,
      );
      const decision = floor ? beyondRange(chosen, declared.declaredRange as string, cargoScheme) : chosen;
      const a: Assessment<RustProject> = {
        ...base,
        info,
        decision,
        instance,
        // The floor isn't what installs get (the newest the range allows is): no deprecation from it.
        deprecation: floor ? null : deprecationChange(info, instance.version),
      };
      if (decision.kind === "upgrade" && decision.isMajor) {
        options.onProgress?.(`${instance.name} ${instance.version} → ${decision.to}: cargo-semver-checks`);
        a.diff = await diffOf(instance.name, instance.version, decision.to).catch((error: unknown) =>
          unreadableDiff("cargo", instance.name, instance.version as string, decision.to, error),
        );
        a.records = surfaceChangeRecords(a.diff);
        a.located = locateRust({
          repoDir,
          tree,
          projectRoot: project.root,
          crate: instance.name,
          ...(instance.aliasName ? { alias: instance.aliasName } : {}),
          declKeys: locateTargets(a.records).declKeys,
          manifests: project.members.map((m) => m.manifest),
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
        ...(await securityAssessments(project, "cargo", cargoScheme, options, (instance) =>
          rustPolicy(instance, options),
        )),
      );
  }
  return { projects, assessments };
}

export async function fixRustDependency(
  input: Omit<FixDependencyInput, "assessment"> & { assessment: Assessment<RustProject> },
): Promise<FixDependencyResult> {
  const { assessment: a, options } = input;
  const decision = a.decision;
  if (decision?.kind !== "upgrade" || !a.instance.version)
    throw new Error(`${a.instance.name} has no upgrade target`);
  const target = decision.to;
  const from = a.instance.version;

  input.onEvent?.({ step: "transaction", detail: `reading release notes ${from} → ${target}` });
  const { sources } = await gatherCargoNotes(a.instance.name, from, target, options);
  // The repository's own teire.yml changelog for this package goes first (S16.1), never public (D53).
  const declared = await declaredPackageNotes(
    input.declaredSources,
    a.instance.name,
    from,
    target,
    cargoScheme,
  );
  if (declared.source) {
    const discovered = sources.filter((src) => src.kind !== "changelog");
    sources.splice(0, sources.length, declared.source, ...discovered);
    input.onEvent?.({
      step: "transaction",
      detail: `release notes from this repository's teire.yml: ${declared.source.url}`,
    });
  } else if (declared.note) input.onEvent?.({ step: "transaction", detail: declared.note });
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
    ? noteRecords(extraction, { name: a.instance.name, from, to: target, ecosystem: "cargo" })
    : [];
  if (extraction)
    input.onEvent?.({
      step: "transaction",
      model: extraction.receipt.model,
      detail: `${extraction.items.length} quoted item(s) from ${sources.length} source(s), ${extraction.dropped.length} dropped${extraction.error ? `; ${extraction.error}` : ""}`,
      costUsd: extraction.receipt.costUsd,
    });

  const removedFeatures = (a.diff?.changes ?? [])
    .filter((c) => c.kind === "removed" && c.path.startsWith("feature:"))
    .map((c) => c.path.slice("feature:".length));
  const plan = withVerifyOverrides(detectRustChecks(input.tree, a.project), a.project.root, input.verify);
  // Renames a quoted note names, at the located sites, proven by the target's own source (S15.4).
  const renames = await plannedRenames({
    ecosystem: "cargo",
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
      input.transaction ?? cargoTransaction(input.tree, a.project, a.instance, target, removedFeatures),
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
    docs: rustDocsLookup(a.instance.name, from, target),
    onEvent: input.onEvent,
  });
  const groupKey = `cargo/${a.instance.name}/${target}`;
  // Who published the target and what runs when it installs, against the installed version (D-14).
  const supplyChain = await crateSignals(a.instance.name, from, target).catch(() => [] as string[]);
  const pr = composeFixPullRequest({
    ...(supplyChain.length ? { supplyChain } : {}),
    repo: input.repo,
    runId: input.runId,
    ...(input.options.targetMax ? { targetMax: input.options.targetMax } : {}),
    ...(input.fallbackFrom ? { fallbackFrom: input.fallbackFrom } : {}),
    ...(input.runUrl ? { runUrl: input.runUrl } : {}),
    groupKey,
    instance: a.instance,
    run,
    plan,
    backendNote: input.backendNote,
    summary: a.summary ?? { verdict: "not_affected", breaking: [], annotations: [], coverage: null },
    records: a.records,
    notes: [...notes, ...(input.movedNotes ?? [])],
    behaviour,
    ...(extraction ? { notesReceipt: extraction.receipt } : {}),
  });
  return { run, pr, groupKey, behaviour, notesReceipt: extraction?.receipt ?? null };
}
