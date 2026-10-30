import * as pep440 from "@renovatebot/pep440";
import { parse as parseToml } from "smol-toml";
import { PRIORITY, REGISTRY } from "../constants";
import type { DependencyInstance } from "../contract";
import { planPythonEdits } from "../fix/python-edits";
import { plannedRenames } from "../fix/renames";
import { runFix } from "../fix/run";
import { pyTransaction } from "../fix/upgrade-py";
import { composeFixPullRequest } from "../github/compose";
import { assess, locateTargets, summariseFindings } from "../impact";
import { type PyProject, readPythonInventory } from "../inventory/python";
import type { RepoTree } from "../inventory/tree";
import { locatePython } from "../locate/python";
import { documentsForReading, extractNotes, migrationNotes, noteRecords } from "../notes/extract";
import { declaredPackageNotes, gatherPypiNotes, githubRepoOf } from "../notes/sources";
import { getPackageInfo, type RegistryOptions } from "../registry/clients";
import { deprecationChange } from "../registry/deprecation";
import { widenedManifests } from "../registry/library";
import { comparable, lookupPackage } from "../registry/private";
import { getPypiIndex, type PypiIndex, versionFiles } from "../registry/pypi";
import { pypiSignals, snapshotOwners } from "../registry/supply-chain";
import {
  beyondRange,
  chooseTarget,
  comparedInstance,
  type TargetPolicy,
  withTargetMax,
} from "../registry/target";
import { pypiScheme } from "../registry/versions";
import { dependabotVersioning } from "../resolver/scan-policy";
import { pythonDocsLookup } from "../surface/pydoc";
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

/** `[project].name`, or Poetry's `[tool.poetry].name`, of a pyproject. */
function pyprojectName(text: string | null) {
  if (!text) return null;
  try {
    const doc = parseToml(text) as { project?: { name?: unknown }; tool?: { poetry?: { name?: unknown } } };
    const name = doc.project?.name ?? doc.tool?.poetry?.name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
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
    // A published library's pyproject ranges widen; an app's bump (S18.5).
    const pyproject = project.root === "." ? "pyproject.toml" : `${project.root}/pyproject.toml`;
    project.widen = await widenedManifests(
      "pypi",
      [{ path: pyproject, name: pyprojectName(tree.read(pyproject)) }],
      {
        ...options,
        versioning: dependabotVersioning(options.dependabot, "pypi", project) ?? options.versioning,
      },
    );
    for (const declared of project.instances) {
      if (!declared.direct || !comparable("pypi", declared, options)) continue;
      if (options.onlyPackage && declared.name !== options.onlyPackage) continue;
      const base: Assessment<PyProject> = {
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
      if (
        (!declared.version && !(declared.declaredRange && pypiScheme.isRange(declared.declaredRange))) ||
        declared.environment?.markers
      ) {
        assessments.push(base);
        continue;
      }
      const info = await lookupPackage("pypi", declared, options).catch(() => {
        options.coverage?.lookupsFailed.push({ ecosystem: "pypi", name: declared.name });
        return null;
      });
      if (!info) {
        assessments.push(base);
        continue;
      }
      const instance = comparedInstance(declared, info, pypiScheme);
      if (!instance?.version) {
        assessments.push(base);
        continue;
      }
      const floor = instance.resolvedBy === "range-floor";
      const index = await getPypiIndex(instance.name, options).catch(() => null);
      const chosen = chooseTarget(
        info,
        instance.version,
        {
          ...withTargetMax(pyPolicy(instance, index, options, python), instance.name, options, "pypi", {
            project,
            instance,
          }),
          ...(project.excludeNewer ? { publishedBefore: project.excludeNewer } : {}),
        },
        pypiScheme,
      );
      const decision = floor ? beyondRange(chosen, declared.declaredRange as string, pypiScheme) : chosen;
      const a: Assessment<PyProject> = {
        ...base,
        info,
        decision,
        instance,
        // The floor isn't what installs get (the newest the range allows is): no deprecation from it.
        deprecation: floor ? null : deprecationChange(info, instance.version),
      };
      // Who owns the project now, kept for the upgrade's owner comparison (D-14, R21.6).
      if (decision.kind === "upgrade")
        await snapshotOwners("pypi", instance.name, instance.version, options).catch(() => undefined);
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
  // The repository's own teire.yml changelog for this package goes first (S16.1), never public (D53).
  const declared = await declaredPackageNotes(
    input.declaredSources,
    a.instance.name,
    from,
    target,
    pypiScheme,
  );
  if (declared.source) {
    const discovered = sources.filter((src) => src.kind !== "changelog");
    sources.splice(0, sources.length, declared.source, ...discovered);
    input.onEvent?.({
      step: "transaction",
      detail: `release notes from this repository's teire.yml: ${declared.source.url}`,
    });
  } else if (declared.note) input.onEvent?.({ step: "transaction", detail: declared.note });
  // The package's own repository, from the notes' sources, so docs prefer its library.
  const repoOf = sources.map((src) => githubRepoOf(src.url)).find(Boolean);
  const sourceRepo = repoOf ? `${repoOf.owner}/${repoOf.repo}` : undefined;
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
    ? noteRecords(extraction, { name: a.instance.name, from, to: target, ecosystem: "pypi" })
    : [];
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
  // Renames a quoted note names, at the located sites, proven by the target's own source (S15.4).
  const renames = await plannedRenames({
    ecosystem: "pypi",
    name: a.instance.name,
    target,
    repoDir: input.repoDir,
    findings: [...(a.summary?.breaking ?? []), ...(a.summary?.annotations ?? [])],
    notes,
    targetDir: targetWheel.dir,
  });
  // Moved imports and removed keywords the target's surface backs, after the renames (R21.7).
  const pythonEdits = planPythonEdits({
    repoDir: input.repoDir,
    findings: [...(a.summary?.breaking ?? []), ...(a.summary?.annotations ?? [])],
    records: a.records,
    notes,
  }).filter(
    (e) => !renames.some((r) => r.file === e.file && r.line >= e.line && r.line <= (e.endLine ?? e.line)),
  );
  const edits = [...renames, ...pythonEdits];
  const run = await runFix({
    ...(edits.length ? { edits } : {}),
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
    findings: [
      ...(a.summary?.breaking ?? []),
      ...(a.summary?.annotations ?? []),
      ...(input.extraFindings ?? []),
    ],
    records: [...a.records, ...(input.extraRecords ?? [])],
    notes: [...notes, ...(input.extraNotes ?? []), ...(input.movedNotes ?? [])],
    ...(input.requestUpgrade ? { requestUpgrade: input.requestUpgrade } : {}),
    ...(input.depCache ? { depCache: input.depCache } : {}),
    targetDir: targetWheel.dir,
    targetPaths: new Set(),
    docs: pythonDocsLookup({
      name: a.instance.name,
      target,
      targetDir: targetWheel.dir,
      ...(sourceRepo ? { sourceRepo } : {}),
      ...(options.context7Key ? { context7Key: options.context7Key } : {}),
    }),
    onEvent: input.onEvent,
  });
  const groupKey = `pypi/${a.instance.name}/${target}`;
  // Who published the target and what runs when it installs, against the installed version (D-14).
  const supplyChain = await pypiSignals(a.instance.name, from, target, options).catch(() => [] as string[]);
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
    summary: a.summary ?? { verdict: "not_affected", breaking: [], annotations: [], coverage: null },
    records: a.records,
    notes: [...notes, ...(input.movedNotes ?? [])],
    behaviour,
    ...(extraction ? { notesReceipt: extraction.receipt } : {}),
  });
  return { run, pr, groupKey, behaviour, notesReceipt: extraction?.receipt ?? null };
}
