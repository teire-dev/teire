import type { ChangeV2, DependencyInstance } from "../contract";
import type { MigrationNote } from "../fix/codemods";
import { lookupDocs } from "../fix/context7";
import { type FixRun, runFix } from "../fix/run";
import type { Transaction } from "../fix/transaction";
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
import { gatherNpmNotes, githubRepoOf } from "../notes/sources";
import { getNpmVersion, getPackageInfo } from "../registry/clients";
import { deprecationChange } from "../registry/deprecation";
import { chooseTarget, type TargetDecision, withTargetMax } from "../registry/target";
import type { PackageInfo } from "../registry/types";
import { npmScheme } from "../registry/versions";
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
    const policy = readJsUpgradePolicy(tree, project);
    for (const instance of project.instances) {
      if (!instance.direct || instance.source !== "registry") continue;
      if (options.onlyPackage && instance.name !== options.onlyPackage) continue;
      const base: Assessment = {
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
      const info = await getPackageInfo("npm", instance.name, options).catch(() => {
        options.coverage?.lookupsFailed.push({ ecosystem: "npm", name: instance.name });
        return null;
      });
      if (!info) {
        assessments.push(base);
        continue;
      }
      const decision = chooseTarget(
        info,
        instance.version,
        withTargetMax(
          jsTargetPolicy(policy, instance.name, instance.version, { cooldownDays: options.cooldownDays }),
          instance.name,
          options,
        ),
        npmScheme,
      );
      const a: Assessment = {
        ...base,
        info,
        decision,
        deprecation: deprecationChange(info, instance.version),
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
        a.priority = 4;
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
  /** teire.yml `verify` commands, which replace the detected ones per workspace (C8). */
  verify?: { workspace: string; install?: string; typecheck?: string; test?: string }[];
  /**
   * The dependency-file change made elsewhere (dependabot-core's updater, S15.1): used instead of
   * this ecosystem's own transaction.
   */
  transaction?: Transaction;
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

  const detail = await getNpmVersion(a.instance.name, target, options);
  const sourceRepo = githubRepoOf(detail?.repository?.url);
  const targetSurface = await npmSurface(a.instance.name, target, options);
  const targetLayout = await npmTypesLayout(a.instance.name, target, options);
  const plan = withVerifyOverrides(detectJsChecks(input.tree, a.project), a.project.root, input.verify);
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
    transaction: input.transaction ?? jsTransaction(input.tree, a.project, a.instance, target),
    instance: a.instance,
    target,
    findings: [...(a.summary?.breaking ?? []), ...(a.summary?.annotations ?? [])],
    records: a.records,
    notes: [...notes, ...(input.extraNotes ?? [])],
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
