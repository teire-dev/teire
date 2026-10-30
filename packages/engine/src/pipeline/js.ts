import type { DeclaredSource } from "../config";
import { PRIORITY } from "../constants";
import type { ChangeV2, DependencyInstance } from "../contract";
import type { MigrationNote } from "../fix/codemods";
import { lookupDocs } from "../fix/context7";
import { type FixRun, runFix } from "../fix/run";
import type { RequestUpgrade, Transaction } from "../fix/transaction";
import { jsTransaction } from "../fix/upgrade-js";
import { composeFixPullRequest, type RepoRef } from "../github/compose";
import {
  assess,
  type DependencyVerdict,
  type FindingDraft,
  locateTargets,
  summariseFindings,
} from "../impact";
import { type JsProject, readJsInventory } from "../inventory/js";
import { jsTargetPolicy, readJsUpgradePolicy } from "../inventory/js-policy";
import type { RepoTree } from "../inventory/tree";
import type { ModelPrice, TokenFactory } from "../llm";
import { type LocateResult, locateTs } from "../locate/ts";
import { documentsForReading, extractNotes, migrationNotes, noteRecords } from "../notes/extract";
import { declaredPackageNotes, gatherNpmNotes, githubRepoOf } from "../notes/sources";
import { getNpmVersion, npmDistTag, supplyChainSignals } from "../registry/clients";
import { deprecationChange } from "../registry/deprecation";
import { widenedManifests } from "../registry/library";
import { applyPrivateClaims, comparable, lookupPackage } from "../registry/private";
import {
  beyondRange,
  chooseTarget,
  comparedInstance,
  patchedHold,
  type TargetDecision,
  withTargetMax,
} from "../registry/target";
import type { PackageInfo } from "../registry/types";
import { npmScheme } from "../registry/versions";
import { dependabotVersioning } from "../resolver/scan-policy";
import { type NpmSurfaceOptions, npmSurface, npmSurfaceDiff, npmTypesLayout } from "../surface/npm";
import { surfaceChangeRecords, unreadableDiff } from "../surface/records";
import type { SurfaceDiff } from "../surface/types";
import type { VerifyBackend } from "../verify/backend";
import { detectJsChecks, withVerifyOverrides } from "../verify/commands";
import type { ScanCoverage } from "./coverage";
import { securityAssessments } from "./security";

/**
 * The JS/TS loop as two calls the worker and the scripts share: assess a repo (inventory → target
 * → surface diff → located sites → verdicts), then fix one dependency (notes → upgrade transaction
 * → codemods → agent → verification → PR body).
 */
/** The project fields every ecosystem's pipeline shares. */
export interface AssessedProject {
  root: string;
  manager: string;
  lockfile?: string | null;
  lockfileVersion?: string | null;
  instances: DependencyInstance[];
}

export interface Assessment<P extends AssessedProject = JsProject> {
  /** An upgrade to the newest allowed version, or the smallest version that clears advisories. */
  purpose: "upgrade" | "security";
  project: P;
  instance: DependencyInstance;
  info: PackageInfo | null;
  decision: TargetDecision | null;
  diff: SurfaceDiff | null;
  records: ChangeV2[];
  deprecation: ChangeV2 | null;
  located: LocateResult | null;
  findings: FindingDraft[];
  summary: DependencyVerdict | null;
  /** PR queue position (D70): lower opens first; null when there is nothing to open. */
  priority: number | null;
}

export interface AssessOptions extends NpmSurfaceOptions {
  cooldownDays?: number;
  /** Look up advisories for every locked version (default on). */
  advisories?: boolean;
  githubToken?: string;
  onlyPackage?: string;
  /** A cached surface diff (the worker's `surface_diffs`); defaults to computing it. */
  surfaceDiff?: (name: string, from: string, to: string) => Promise<SurfaceDiff>;
  onProgress?: (line: string) => void;
  /** The scan's record of what it could not check (D96). */
  coverage?: ScanCoverage;
}

export async function assessJsRepo(repoDir: string, tree: RepoTree, options: AssessOptions) {
  const projects = readJsInventory(tree);
  const assessments: Assessment[] = [];
  const diffOf = options.surfaceDiff ?? ((name, from, to) => npmSurfaceDiff(name, from, to, options));
  for (const project of projects) {
    // What a private registry the repo names serves is read there, or not compared (S18 review S1).
    applyPrivateClaims(project.instances, "npm", options);
    const policy = readJsUpgradePolicy(tree, project);
    // Libraries widen, apps bump (S18.5): each importer's package.json on its own.
    project.widen = await widenedManifests(
      "npm",
      project.importers.map((importer) => {
        const path = [project.root, importer].filter((p) => p !== ".").join("/");
        const manifest = path ? `${path}/package.json` : "package.json";
        let doc: { name?: string; description?: string; private?: boolean } = {};
        try {
          doc = JSON.parse(tree.read(manifest) ?? "{}");
        } catch {
          // An unreadable package.json is no library.
        }
        return {
          path: manifest,
          name: typeof doc.name === "string" ? doc.name : null,
          description: typeof doc.description === "string" ? doc.description : null,
          private: doc.private === true,
        };
      }),
      {
        ...options,
        versioning: dependabotVersioning(options.dependabot, "npm", project) ?? options.versioning,
      },
    );
    for (const declared of project.instances) {
      if (!declared.direct || !comparable("npm", declared, options)) continue;
      if (options.onlyPackage && declared.name !== options.onlyPackage) continue;
      // A peer that is also installed (devDependencies) is assessed once, from the installed one;
      // its fix widens the peer range with it (D-22).
      if (
        declared.scope === "peer" &&
        project.instances.some(
          (i) =>
            i.direct && i.scope !== "peer" && i.name === declared.name && i.workspace === declared.workspace,
        )
      )
        continue;
      const base: Assessment = {
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
      if (!declared.version && !(declared.declaredRange && npmScheme.isRange(declared.declaredRange))) {
        assessments.push(base);
        continue;
      }
      const info = await lookupPackage("npm", declared, options).catch(() => {
        options.coverage?.lookupsFailed.push({ ecosystem: "npm", name: declared.name });
        return null;
      });
      if (!info) {
        assessments.push(base);
        continue;
      }
      const instance = comparedInstance(declared, info, npmScheme);
      if (!instance?.version) {
        assessments.push(base);
        continue;
      }
      const floor = instance.resolvedBy === "range-floor";
      // A dist-tag the repo follows for this package (D-43) is the ceiling in place of `latest`.
      // A dist-tag is npm's own; a private package's tags live in its registry (S18 review S13).
      const tag = declared.source === "registry" ? options.distTags?.[instance.name] : undefined;
      const followTag = tag ? await npmDistTag(instance.name, tag).catch(() => null) : null;
      if (tag && !followTag) options.coverage?.notes.push(`${instance.name}: no "${tag}" dist-tag on npm`);
      const chosen = chooseTarget(
        info,
        instance.version,
        {
          ...withTargetMax(
            jsTargetPolicy(policy, instance.name, instance.version, {
              cooldownDays: options.cooldownDays,
              fallbackMajors: options.fallbackMajors,
            }),
            instance.name,
            options,
            "npm",
            { project, instance },
          ),
          ...(followTag ? { followTag: { tag: tag as string, version: followTag } } : {}),
        },
        npmScheme,
      );
      const decision = patchedHold(
        floor ? beyondRange(chosen, declared.declaredRange as string, npmScheme) : chosen,
        instance,
      );
      const a: Assessment = {
        ...base,
        instance,
        info,
        decision,
        // The floor isn't what installs get (the newest the range allows is): no deprecation from it.
        deprecation: floor ? null : deprecationChange(info, instance.version),
      };
      if (decision.kind === "upgrade" && decision.isMajor) {
        options.onProgress?.(`${instance.name} ${instance.version} → ${decision.to}: API-surface diff`);
        a.diff = await diffOf(instance.name, instance.version, decision.to).catch((error: unknown) =>
          unreadableDiff("npm", instance.name, instance.version as string, decision.to, error),
        );
        a.records = surfaceChangeRecords(a.diff);
        // An unreadable diff has nothing to search for; a locator that fails leaves the finding
        // inconclusive ("the repo's code was not analysed"), never the whole scan failed.
        const records = a.records;
        const version = instance.version;
        a.located = a.diff.unanalyzable
          ? null
          : await (async () => {
              const from = await npmTypesLayout(instance.name, version, options);
              const to = await npmTypesLayout(instance.name, decision.to, options);
              return locateTs({
                repoDir,
                projectRoot: project.root,
                packageName: instance.name,
                link: from.link,
                roots: from.roots,
                targetDir: to.link.dir,
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
        ...(await securityAssessments(project, "npm", npmScheme, options, (instance) =>
          jsTargetPolicy(policy, instance.name, instance.version ?? "", {
            cooldownDays: options.cooldownDays,
          }),
        )),
      );
  }
  return { projects, assessments };
}

export interface FixDependencyInput {
  tf: TokenFactory;
  prices?: Map<string, ModelPrice>;
  backend: VerifyBackend;
  backendNote: string;
  runId: string;
  runUrl?: string;
  repoDir: string;
  tree: RepoTree;
  repo: RepoRef;
  tarball: { url: string; token?: string };
  assessment: Assessment;
  options: NpmSurfaceOptions & { githubToken?: string; context7Key?: string };
  onEvent?: Parameters<typeof runFix>[0]["onEvent"];
  /** Extra context for the agent (a CI failure on the PR it is repairing, C6). */
  extraNotes?: MigrationNote[];
  /** Breaking changes located in packages the upgrade moved with it (D-10), each naming its package. */
  extraFindings?: FindingDraft[];
  /** Those packages' change records, so the agent sees their before and after signatures. */
  extraRecords?: ChangeV2[];
  /** Those packages' own release notes (D-10): read by the agent and quoted in the PR. */
  movedNotes?: MigrationNote[];
  /** Other upgrades the agent may ask dependabot-core's updater for (S15.2). */
  requestUpgrade?: RequestUpgrade;
  /** teire.yml `sources`: a package's own changelog the repository names (S16.1). */
  declaredSources?: DeclaredSource[];
  /** The repository's download cache, on backends that keep one (R21.11). */
  depCache?: Parameters<typeof runFix>[0]["depCache"];
  /** teire.yml `verify` commands, which replace the detected ones per workspace (C8). */
  verify?: { workspace: string; install?: string; typecheck?: string; test?: string }[];
  /**
   * The dependency-file change made elsewhere (dependabot-core's updater, S15.1): used instead of
   * this ecosystem's own transaction.
   */
  transaction?: Transaction;
  /** The newer major this run fell back from (D71), and why: the PR says so. */
  fallbackFrom?: { version: string; reason: string };
  /** Dependabot's open PRs for this package (S18.6). */
  supersedes?: { number: number; title: string; url: string }[];
}

export interface FixDependencyResult {
  run: FixRun;
  pr: { title: string; body: string };
  groupKey: string;
  behaviour: ChangeV2[];
  notesReceipt: { model: string; tokensIn: number; tokensOut: number; costUsd: number; ms: number } | null;
}

export async function fixJsDependency(input: FixDependencyInput): Promise<FixDependencyResult> {
  const { assessment: a, options } = input;
  const decision = a.decision;
  if (decision?.kind !== "upgrade" || !a.instance.version)
    throw new Error(`${a.instance.name} has no upgrade target`);
  const target = decision.to;
  const from = a.instance.version;

  // Release notes, read by Nemotron 3 Ultra behind the quote gate.
  input.onEvent?.({ step: "transaction", detail: `reading release notes ${from} → ${target}` });
  const { sources } = await gatherNpmNotes(a.instance.name, from, target, options);
  // The repository's own teire.yml changelog for this package goes first (S16.1), never public (D53).
  const declared = await declaredPackageNotes(
    input.declaredSources,
    a.instance.name,
    from,
    target,
    npmScheme,
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
    ? noteRecords(extraction, { name: a.instance.name, from, to: target, ecosystem: "npm" })
    : [];
  if (extraction)
    input.onEvent?.({
      step: "transaction",
      model: extraction.receipt.model,
      detail: `${extraction.items.length} quoted item(s) from ${sources.length} source(s), ${extraction.dropped.length} dropped${extraction.error ? `; ${extraction.error}` : ""}`,
      costUsd: extraction.receipt.costUsd,
    });

  const detail = await getNpmVersion(a.instance.name, target, options);
  const installed = a.instance.version
    ? await getNpmVersion(a.instance.name, a.instance.version, options).catch(() => null)
    : null;
  const supplyChain = supplyChainSignals(installed, detail);
  const sourceRepo = githubRepoOf(detail?.repository?.url);
  const targetSurface = await npmSurface(a.instance.name, target, options);
  const targetLayout = await npmTypesLayout(a.instance.name, target, options);
  const plan = withVerifyOverrides(detectJsChecks(input.tree, a.project), a.project.root, input.verify);
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
    transaction: input.transaction ?? jsTransaction(input.tree, a.project, a.instance, target),
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
    targetDir: targetLayout.link.dir,
    targetPaths: new Set([
      ...Object.keys(targetSurface.surface.symbols),
      ...Object.keys(targetSurface.surface.aliases),
    ]),
    docs: async (query) => {
      const d = await lookupDocs({
        packageName: a.instance.name,
        ...(sourceRepo ? { sourceRepo: `${sourceRepo.owner}/${sourceRepo.repo}` } : {}),
        target,
        query,
        apiKey: options.context7Key,
      });
      return `${d.note}\n${d.text}`;
    },
    onEvent: input.onEvent,
  });
  const groupKey = `npm/${a.instance.name}/${target}`;
  const pr = composeFixPullRequest({
    repo: input.repo,
    runId: input.runId,
    ...(input.options.targetMax ? { targetMax: input.options.targetMax } : {}),
    ...(input.fallbackFrom ? { fallbackFrom: input.fallbackFrom } : {}),
    ...(input.supersedes?.length ? { supersedes: input.supersedes } : {}),
    ...(supplyChain.length ? { supplyChain } : {}),
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
