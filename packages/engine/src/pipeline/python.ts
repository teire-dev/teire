import * as pep440 from "@renovatebot/pep440";
import { PRIORITY, REGISTRY } from "../constants";
import type { DependencyInstance } from "../contract";
import { runFix } from "../fix/run";
import { pyTransaction } from "../fix/upgrade-py";
import { composeFixPullRequest } from "../github/compose";
import { assess, locateTargets, summariseFindings } from "../impact";
import { type PyProject, readPythonInventory } from "../inventory/python";
import type { RepoTree } from "../inventory/tree";
import { locatePython } from "../locate/python";
import { documentsForReading, extractNotes, migrationNotes, noteRecords } from "../notes/extract";
import { gatherPypiNotes } from "../notes/sources";
import { getPackageInfo, type RegistryOptions } from "../registry/clients";
import { deprecationChange } from "../registry/deprecation";
import { getPypiIndex, type PypiIndex, versionFiles } from "../registry/pypi";
import { chooseTarget, type TargetPolicy, withTargetMax } from "../registry/target";
import { pypiScheme } from "../registry/versions";
import { fetchPypiWheel, pypiSurfaceDiff } from "../surface/pypi";
import { surfaceChangeRecords, unreadableDiff } from "../surface/records";
import type { SurfaceDiff } from "../surface/types";
import { withVerifyOverrides } from "../verify/commands";
import { detectPyChecks } from "../verify/python-commands";
import { pythonFor } from "../verify/toolchains";
import type { ScanCoverage } from "./coverage";
import type { Assessment, FixDependencyInput, FixDependencyResult } from "./js";
import { securityAssessments } from "./security";

/**
 * The Python loop (plan S03), the same two calls as JS: assess (inventory → target → griffe diff
 * on wheels → jedi sites → verdicts, plus advisories) and fix (notes → uv/Poetry/Pipenv/pip-tools
 * transaction → agent → baseline vs after in the Python sandbox → PR body).
 */
/** The sandbox image's own Python, for a project that names none (toolchains.ts provides the rest). */
const DEFAULT_PYTHON = "3.12";

export interface PyAssessOptions extends RegistryOptions {
  cacheDir?: string;
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
 * A version this project's Python cannot install: every file for it requires another Python (the
 * one the repo asks for, as the sandbox runs it; D-38). devchat (`^3.8`, CI 3.8) never gets a
 * pydantic that needs 3.10.
 */
function requiresNewerPython(index: PypiIndex | null, version: string, python: string) {
  if (!index) return null;
  const reqs = [
    ...new Set(
      versionFiles(index, version)
        .map((f) => f.requiresPython)
        .filter((r): r is string => !!r),
    ),
  ];
  if (!reqs.length) return null;
  return reqs.every((r) => pep440.validRange(r) && !pep440.satisfies(`${python}.0`, r))
    ? `requires Python ${reqs[0]}; this project runs ${python}`
    : null;
}

function pyPolicy(
  instance: DependencyInstance,
  index: PypiIndex | null,
  options: PyAssessOptions,
  python = DEFAULT_PYTHON,
): TargetPolicy {
  const minutes = (options.cooldownDays ?? REGISTRY.cooldownDays) * 1440;
  return {
    now: options.now ?? new Date(),
    minAgeMinutes: () => minutes,
    pins: [],
    allowPrerelease: instance.version ? pypiScheme.isPrerelease(instance.version) : false,
    fallbackMajors: options.fallbackMajors ?? 0,
    exclude: (v) => requiresNewerPython(index, v, python),
  };
}

export async function assessPyRepo(repoDir: string, tree: RepoTree, options: PyAssessOptions) {
  const projects = await readPythonInventory(repoDir, tree);
  const assessments: Assessment<PyProject>[] = [];
  const diffOf = options.surfaceDiff ?? ((name, from, to) => pypiSurfaceDiff(name, from, to, options));
  for (const project of projects) {
    const python = pythonFor(tree, project.root)?.version ?? DEFAULT_PYTHON;
    for (const instance of project.instances) {
      if (!instance.direct || instance.source !== "registry") continue;
      if (options.onlyPackage && instance.name !== options.onlyPackage) continue;
      const base: Assessment<PyProject> = {
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
      if (!instance.version || instance.environment?.markers) {
        assessments.push(base);
        continue;
      }
      const info = await getPackageInfo("pypi", instance.name, options).catch(() => {
        options.coverage?.lookupsFailed.push({ ecosystem: "pypi", name: instance.name });
        return null;
      });
      if (!info) {
        assessments.push(base);
        continue;
      }
      const index = await getPypiIndex(instance.name, options).catch(() => null);
      const decision = chooseTarget(
        info,
        instance.version,
        withTargetMax(pyPolicy(instance, index, options, python), instance.name, options),
        pypiScheme,
      );
      const a: Assessment<PyProject> = {
        ...base,
        info,
        decision,
        deprecation: deprecationChange(info, instance.version),
      };
      if (decision.kind === "upgrade" && decision.isMajor) {
        options.onProgress?.(`${instance.name} ${instance.version} → ${decision.to}: griffe diff`);
        a.diff = await diffOf(instance.name, instance.version, decision.to).catch((error: unknown) =>
          unreadableDiff("pypi", instance.name, instance.version as string, decision.to, error),
        );
        a.records = surfaceChangeRecords(a.diff);
        // As npm: nothing to search for after an unreadable diff; a failed locator leaves it inconclusive.
        const records = a.records;
        const version = instance.version;
        a.located = a.diff.unanalyzable
          ? null
          : await (async () => {
              const wheel = await fetchPypiWheel(instance.name, version, options);
              return locatePython({
                repoDir,
                projectRoot: project.root,
                packages: wheel.topLevel,
                siteDirs: [wheel.dir],
                ...locateTargets(records),
              });
            })().catch(() => null);
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
        ...(await securityAssessments(project, "pypi", pypiScheme, options, (instance) =>
          pyPolicy(instance, null, options, python),
        )),
      );
  }
  return { projects, assessments };
}

export async function fixPyDependency(
  input: Omit<FixDependencyInput, "assessment"> & { assessment: Assessment<PyProject> },
): Promise<FixDependencyResult> {
  const { assessment: a, options } = input;
  const decision = a.decision;
  if (decision?.kind !== "upgrade" || !a.instance.version)
    throw new Error(`${a.instance.name} has no upgrade target`);
  const target = decision.to;
  const from = a.instance.version;

  input.onEvent?.({ step: "transaction", detail: `reading release notes ${from} → ${target}` });
  const { sources } = await gatherPypiNotes(a.instance.name, from, target, options);
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

  const targetWheel = await fetchPypiWheel(a.instance.name, target, options);
  // Hash-pinned requirements (`--hash=sha256:…`) need the target's hashes, the same set
  // `pip-compile --generate-hashes` writes: every file PyPI has for that version.
  const index = await getPypiIndex(a.instance.name, options);
  const hashes = index
    ? versionFiles(index, target)
        .map((f) => f.sha256)
        .filter(Boolean)
    : [];
  const plan = withVerifyOverrides(detectPyChecks(input.tree, a.project), a.project.root, input.verify);
  const run = await runFix({
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
    transaction: input.transaction ?? pyTransaction(input.tree, a.project, a.instance, target, hashes),
    instance: a.instance,
    target,
    findings: [...(a.summary?.breaking ?? []), ...(a.summary?.annotations ?? [])],
    records: a.records,
    notes: [...notes, ...(input.extraNotes ?? [])],
    targetDir: targetWheel.dir,
    targetPaths: new Set(),
    docs: async () =>
      "Version-pinned documentation lookup is not available for PyPI packages yet; rely on the quoted migration notes.",
    onEvent: input.onEvent,
  });
  const groupKey = `pypi/${a.instance.name}/${target}`;
  const pr = composeFixPullRequest({
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
    notes,
    behaviour,
    ...(extraction ? { notesReceipt: extraction.receipt } : {}),
  });
  return { run, pr, groupKey, behaviour, notesReceipt: extraction?.receipt ?? null };
}
