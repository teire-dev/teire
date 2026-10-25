import { advisoriesFor } from "../advisories";
import type { ChangeV2, DependencyInstance } from "../contract";
import { lookupDocs } from "../fix/context7";
import { type FixRun, runFix } from "../fix/run";
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
import { chooseFixedTarget, chooseTarget, type TargetDecision } from "../registry/target";
import type { PackageInfo } from "../registry/types";
import { npmScheme } from "../registry/versions";
import { type NpmSurfaceOptions, npmSurface, npmSurfaceDiff, npmTypesLayout } from "../surface/npm";
import { surfaceChangeRecords } from "../surface/records";
import type { SurfaceDiff } from "../surface/types";
import type { VerifyBackend } from "../verify/backend";
import { detectJsChecks } from "../verify/commands";

/**
 * The JS/TS loop as two calls the worker and the scripts share: assess a repo (inventory → target
 * → surface diff → located sites → verdicts), then fix one dependency (notes → upgrade transaction
 * → codemods → agent → verification → PR body).
 */
export interface Assessment {
  /** An upgrade to the newest allowed version, or the smallest version that clears advisories. */
  purpose: "upgrade" | "security";
  project: JsProject;
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
      const info = await getPackageInfo("npm", instance.name, options).catch(() => null);
      if (!info) {
        assessments.push(base);
        continue;
      }
      const decision = chooseTarget(
        info,
        instance.version,
        jsTargetPolicy(policy, instance.name, instance.version, { cooldownDays: options.cooldownDays }),
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
        a.diff = await diffOf(instance.name, instance.version, decision.to);
        a.records = surfaceChangeRecords(a.diff);
        const from = await npmTypesLayout(instance.name, instance.version, options);
        const to = await npmTypesLayout(instance.name, decision.to, options);
        a.located = locateTs({
          repoDir,
          projectRoot: project.root,
          packageName: instance.name,
          link: from.link,
          roots: from.roots,
          targetDir: to.link.dir,
          ...locateTargets(a.records),
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
      assessments.push(...(await securityAssessments(project, policy, options)));
  }
  return { projects, assessments };
}

/**
 * Advisories for every locked version in a project, direct and transitive (D51): one assessment
 * per affected instance, targeting the smallest version that clears every advisory it has.
 */
async function securityAssessments(
  project: JsProject,
  policy: ReturnType<typeof readJsUpgradePolicy>,
  options: AssessOptions,
): Promise<Assessment[]> {
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
  const matches = await advisoriesFor(
    instances.map((i) => ({ ecosystem: "npm" as const, name: i.name, version: i.version ?? "" })),
    { githubToken: options.githubToken },
  ).catch((error) => {
    options.onProgress?.(`advisories unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });
  const out: Assessment[] = [];
  for (const instance of instances) {
    const records = matches
      .filter((m) => m.query.name === instance.name && m.query.version === instance.version)
      .map((m) => m.record);
    if (!records.length || !instance.version) continue;
    const info = await getPackageInfo("npm", instance.name, options).catch(() => null);
    if (!info) continue;
    const targetPolicy = jsTargetPolicy(policy, instance.name, instance.version, {
      cooldownDays: options.cooldownDays,
    });
    // Each advisory's smallest fix on the installed line, then the highest of those clears them all.
    const fixes = records
      .map((r) =>
        chooseFixedTarget(info, instance.version ?? "", r.applicability.fixedIn, targetPolicy, npmScheme),
      )
      .flatMap((d) => (d.kind === "upgrade" ? [d.to] : []));
    const required = fixes.sort((x, y) => npmScheme.compare(y, x))[0];
    const decision: TargetDecision = required
      ? chooseFixedTarget(info, instance.version, [required], targetPolicy, npmScheme)
      : { kind: "blocked", from: instance.version, reason: "no fixed version is published", skipped: [] };
    const target = decision.kind === "upgrade" ? decision.to : null;
    const findings = assess({
      instance,
      target,
      isMajor: decision.kind === "upgrade" && decision.isMajor,
      records,
      locate: null,
    });
    const summary = summariseFindings(findings);
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
      summary,
      priority: target ? Math.min(...findings.map((f) => f.priority ?? 4)) : null,
    });
  }
  return out;
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
      detail: `${extraction.items.length} quoted item(s) from ${sources.length} source(s), ${extraction.dropped.length} dropped`,
      costUsd: extraction.receipt.costUsd,
    });

  const detail = await getNpmVersion(a.instance.name, target, options);
  const sourceRepo = githubRepoOf(detail?.repository?.url);
  const targetSurface = await npmSurface(a.instance.name, target, options);
  const targetLayout = await npmTypesLayout(a.instance.name, target, options);
  const plan = detectJsChecks(input.tree, a.project);
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
    instance: a.instance,
    target,
    findings: [...(a.summary?.breaking ?? []), ...(a.summary?.annotations ?? [])],
    records: a.records,
    notes,
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
