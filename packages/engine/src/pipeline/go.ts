import { existsSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY } from "../constants";
import type { DependencyInstance } from "../contract";
import { runFix } from "../fix/run";
import { goTransaction } from "../fix/upgrade-go";
import { composeFixPullRequest } from "../github/compose";
import { goEnv } from "../golang/toolchain";
import { assess, locateTargets, summariseFindings } from "../impact";
import { type GoProject, readGoInventory } from "../inventory/go";
import type { RepoTree } from "../inventory/tree";
import { locateGo } from "../locate/go";
import { documentsForReading, extractNotes, migrationNotes, noteRecords } from "../notes/extract";
import { gatherGoNotes } from "../notes/sources";
import type { RegistryOptions } from "../registry/clients";
import { deprecationChange } from "../registry/deprecation";
import { escapeModulePath, goModuleFamily } from "../registry/go";
import { chooseTarget, type TargetPolicy } from "../registry/target";
import { goScheme } from "../registry/versions";
import { goSurfaceDiff } from "../surface/go";
import { surfaceChangeRecords } from "../surface/records";
import type { SurfaceDiff } from "../surface/types";
import { detectGoChecks } from "../verify/go-commands";
import type { Assessment, FixDependencyInput, FixDependencyResult } from "./js";
import { securityAssessments } from "./security";

/**
 * The Go loop (plan S05), the same two calls as JS and Python: assess (inventory from the
 * toolchain → target across major paths → apidiff → type-resolved sites → verdicts, plus
 * advisories) and fix (notes → import rewrite + go get + go mod tidy → agent → baseline vs after in
 * the Go sandbox → PR body). A new major is a new module path; the assessment carries it.
 */
export interface GoAssessment extends Assessment<GoProject> {
  /** The module path the target version is published under (`…/v5` across a major). */
  targetPath: string | null;
}

export interface GoAssessOptions extends RegistryOptions {
  cooldownDays?: number;
  onlyPackage?: string;
  advisories?: boolean;
  githubToken?: string;
  surfaceDiff?: (oldPath: string, from: string, newPath: string, to: string) => Promise<SurfaceDiff>;
  onProgress?: (line: string) => void;
}

function goPolicy(instance: DependencyInstance, options: GoAssessOptions): TargetPolicy {
  const minutes = (options.cooldownDays ?? REGISTRY.cooldownDays) * 1440;
  return {
    now: options.now ?? new Date(),
    minAgeMinutes: () => minutes,
    pins: [],
    allowPrerelease: instance.version ? goScheme.isPrerelease(instance.version) : false,
    fallbackMajors: 0,
  };
}

export async function assessGoRepo(repoDir: string, tree: RepoTree, options: GoAssessOptions) {
  const projects = await readGoInventory(repoDir, tree);
  const assessments: GoAssessment[] = [];
  const diffOf = options.surfaceDiff ?? goSurfaceDiff;
  for (const project of projects) {
    for (const instance of project.instances) {
      if (!instance.direct || instance.source !== "registry") continue;
      if (options.onlyPackage && instance.name !== options.onlyPackage) continue;
      const base: GoAssessment = {
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
        targetPath: null,
      };
      // Pseudo-versions pin a commit, not a release: there is no release line to move along.
      if (!instance.version || goScheme.isPrerelease(instance.version)) {
        assessments.push(base);
        continue;
      }
      const family = await goModuleFamily(instance.name, options).catch(() => null);
      if (!family) {
        assessments.push(base);
        continue;
      }
      const decision = chooseTarget(family.info, instance.version, goPolicy(instance, options), goScheme);
      const a: GoAssessment = {
        ...base,
        info: family.info,
        decision,
        deprecation: deprecationChange(family.info, instance.version),
      };
      if (decision.kind === "upgrade") {
        const targetPath = family.pathOf(decision.to);
        a.targetPath = targetPath;
        const isMajor = decision.isMajor || targetPath !== instance.name;
        if (isMajor) {
          options.onProgress?.(
            `${instance.name} ${instance.version} → ${targetPath} ${decision.to}: apidiff`,
          );
          a.diff = await diffOf(instance.name, instance.version, targetPath, decision.to);
          a.records = surfaceChangeRecords(a.diff);
          a.located = await locateGo({
            repoDir,
            projectRoot: project.root,
            modulePath: instance.name,
            declKeys: locateTargets(a.records).declKeys,
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
        } else {
          a.summary = { verdict: "not_affected", breaking: [], annotations: [], coverage: null };
          a.priority = 4;
        }
      }
      assessments.push(a);
    }
    if (options.advisories !== false)
      assessments.push(
        ...(
          await securityAssessments(project, "go", goScheme, options, (instance) =>
            goPolicy(instance, options),
          )
        ).map((s) => ({ ...s, targetPath: s.instance.name })),
      );
  }
  return { projects, assessments };
}

/** The target version's source in the shared module cache (downloaded by the diff), for the agent to read. */
function moduleCacheDir(path: string, version: string) {
  const dir = join(goEnv("/tmp").GOMODCACHE ?? "", `${escapeModulePath(path)}@${version}`);
  return existsSync(dir) ? dir : null;
}

export async function fixGoDependency(
  input: Omit<FixDependencyInput, "assessment"> & { assessment: GoAssessment },
): Promise<FixDependencyResult> {
  const { assessment: a, options } = input;
  const decision = a.decision;
  if (decision?.kind !== "upgrade" || !a.instance.version)
    throw new Error(`${a.instance.name} has no upgrade target`);
  const target = decision.to;
  const targetPath = a.targetPath ?? a.instance.name;
  const from = a.instance.version;

  input.onEvent?.({ step: "transaction", detail: `reading release notes ${from} → ${target}` });
  const { sources } = await gatherGoNotes(targetPath, from, target, options);
  const docs = documentsForReading(sources);
  const extraction = docs.length
    ? await extractNotes(
        input.tf,
        docs,
        {
          name: targetPath,
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
  const behaviour = extraction ? noteRecords(extraction, { name: targetPath, from, to: target }) : [];
  if (extraction)
    input.onEvent?.({
      step: "transaction",
      model: extraction.receipt.model,
      detail: `${extraction.items.length} quoted item(s) from ${sources.length} source(s), ${extraction.dropped.length} dropped`,
      costUsd: extraction.receipt.costUsd,
    });

  const plan = detectGoChecks(input.tree, a.project);
  const targetDir = moduleCacheDir(targetPath, target) ?? "";
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
    transaction: goTransaction(input.tree, a.project, a.instance, targetPath, target),
    instance: a.instance,
    target: targetPath === a.instance.name ? target : `${targetPath} ${target}`,
    findings: [...(a.summary?.breaking ?? []), ...(a.summary?.annotations ?? [])],
    records: a.records,
    notes,
    targetDir,
    targetPaths: new Set(),
    docs: async () =>
      targetDir
        ? `The target module's source is at ${targetDir}; read its exported declarations there.`
        : "The target module's source is not in the cache; rely on the quoted migration notes and the compiler output.",
    onEvent: input.onEvent,
  });
  const groupKey = `go/${a.instance.name}/${target}`;
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
