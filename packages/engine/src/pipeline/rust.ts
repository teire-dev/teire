import { REGISTRY } from "../constants";
import type { DependencyInstance } from "../contract";
import { runFix } from "../fix/run";
import { cargoTransaction } from "../fix/upgrade-rust";
import { composeFixPullRequest } from "../github/compose";
import { assess, locateTargets, summariseFindings } from "../impact";
import { type RustProject, readRustInventory } from "../inventory/rust";
import type { RepoTree } from "../inventory/tree";
import { locateRust } from "../locate/rust";
import { documentsForReading, extractNotes, migrationNotes, noteRecords } from "../notes/extract";
import { gatherCargoNotes } from "../notes/sources";
import { getPackageInfo, type RegistryOptions } from "../registry/clients";
import { deprecationChange } from "../registry/deprecation";
import { chooseTarget, type TargetPolicy } from "../registry/target";
import { cargoScheme } from "../registry/versions";
import { surfaceChangeRecords } from "../surface/records";
import { cargoSurfaceDiff } from "../surface/rust";
import { rustDocsLookup } from "../surface/rustdoc";
import type { SurfaceDiff } from "../surface/types";
import { withVerifyOverrides } from "../verify/commands";
import { detectRustChecks } from "../verify/rust-commands";
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
}

function rustPolicy(instance: DependencyInstance, options: RustAssessOptions): TargetPolicy {
  const minutes = (options.cooldownDays ?? REGISTRY.cooldownDays) * 1440;
  return {
    now: options.now ?? new Date(),
    minAgeMinutes: () => minutes,
    pins: [],
    allowPrerelease: instance.version ? cargoScheme.isPrerelease(instance.version) : false,
    fallbackMajors: 0,
  };
}

export async function assessRustRepo(repoDir: string, tree: RepoTree, options: RustAssessOptions) {
  const projects = readRustInventory(tree);
  const assessments: Assessment<RustProject>[] = [];
  const diffOf = options.surfaceDiff ?? cargoSurfaceDiff;
  for (const project of projects) {
    for (const instance of project.instances) {
      if (!instance.direct || instance.source !== "registry") continue;
      if (options.onlyPackage && instance.name !== options.onlyPackage) continue;
      const base: Assessment<RustProject> = {
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
      const info = await getPackageInfo("cargo", instance.name, options).catch(() => null);
      if (!info) {
        assessments.push(base);
        continue;
      }
      const decision = chooseTarget(info, instance.version, rustPolicy(instance, options), cargoScheme);
      const a: Assessment<RustProject> = {
        ...base,
        info,
        decision,
        deprecation: deprecationChange(info, instance.version),
      };
      if (decision.kind === "upgrade" && decision.isMajor) {
        options.onProgress?.(`${instance.name} ${instance.version} → ${decision.to}: cargo-semver-checks`);
        a.diff = await diffOf(instance.name, instance.version, decision.to);
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
        a.priority = 4;
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

  const removedFeatures = (a.diff?.changes ?? [])
    .filter((c) => c.kind === "removed" && c.path.startsWith("feature:"))
    .map((c) => c.path.slice("feature:".length));
  const plan = withVerifyOverrides(detectRustChecks(input.tree, a.project), a.project.root, input.verify);
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
    transaction: cargoTransaction(input.tree, a.project, a.instance, target, removedFeatures),
    instance: a.instance,
    target,
    findings: [...(a.summary?.breaking ?? []), ...(a.summary?.annotations ?? [])],
    records: a.records,
    notes: [...notes, ...(input.extraNotes ?? [])],
    targetDir: "",
    targetPaths: new Set(),
    docs: rustDocsLookup(a.instance.name, from, target),
    onEvent: input.onEvent,
  });
  const groupKey = `cargo/${a.instance.name}/${target}`;
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
