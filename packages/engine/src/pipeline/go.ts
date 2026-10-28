import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { goVulnReachability } from "../advisories/govulncheck";
import { PRIORITY, REGISTRY } from "../constants";
import type { DependencyInstance } from "../contract";
import { runFix } from "../fix/run";
import { goTransaction } from "../fix/upgrade-go";
import { composeFixPullRequest } from "../github/compose";
import { goEnv } from "../golang/toolchain";
import { assess, locateTargets, priorityOf, summariseFindings } from "../impact";
import { type GoProject, readGoInventory } from "../inventory/go";
import type { RepoTree } from "../inventory/tree";
import { locateGo } from "../locate/go";
import { documentsForReading, extractNotes, migrationNotes, noteRecords } from "../notes/extract";
import { gatherGoNotes } from "../notes/sources";
import type { RegistryOptions } from "../registry/clients";
import { deprecationChange } from "../registry/deprecation";
import { escapeModulePath, goModuleFamily } from "../registry/go";
import { chooseTarget, type TargetPolicy, withTargetMax } from "../registry/target";
import { goScheme } from "../registry/versions";
import { goSurfaceDiff } from "../surface/go";
import { goDocsLookup } from "../surface/godoc";
import { surfaceChangeRecords, unreadableDiff } from "../surface/records";
import type { SurfaceDiff } from "../surface/types";
import { withVerifyOverrides } from "../verify/commands";
import { detectGoChecks } from "../verify/go-commands";
import type { ScanCoverage } from "./coverage";
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
  /** The scan's record of what it could not check (D96). */
  coverage?: ScanCoverage;
}

function goPolicy(instance: DependencyInstance, options: GoAssessOptions): TargetPolicy {
  const minutes = (options.cooldownDays ?? REGISTRY.cooldownDays) * 1440;
  return {
    now: options.now ?? new Date(),
    minAgeMinutes: () => minutes,
    pins: [],
    allowPrerelease: instance.version ? goScheme.isPrerelease(instance.version) : false,
    fallbackMajors: options.fallbackMajors ?? 0,
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
      const family = await goModuleFamily(instance.name, options).catch(() => {
        options.coverage?.lookupsFailed.push({ ecosystem: "go", name: instance.name });
        return null;
      });
      if (!family) {
        assessments.push(base);
        continue;
      }
      const decision = chooseTarget(
        family.info,
        instance.version,
        withTargetMax(goPolicy(instance, options), instance.name, options),
        goScheme,
      );
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
          a.diff = await diffOf(instance.name, instance.version, targetPath, decision.to).catch(
            (error: unknown) =>
              unreadableDiff("go", instance.name, instance.version as string, decision.to, error),
          );
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
          a.priority = PRIORITY.plainBump;
        }
      }
      assessments.push(a);
    }
    if (options.advisories !== false) {
      const security = await securityAssessments(project, "go", goScheme, options, (instance) =>
        goPolicy(instance, options),
      );
      if (security.length) await withReachability(repoDir, project, security, options);
      assessments.push(...security.map((s) => ({ ...s, targetPath: s.instance.name })));
    }
  }
  return { projects, assessments };
}

function lineOf(repoDir: string, file: string, line: number) {
  try {
    return (readFileSync(join(repoDir, file), "utf8").split("\n")[line - 1] ?? "").trim().slice(0, 200);
  } catch {
    return "";
  }
}

const ADVISORY_ID = /\b(?:GO-\d{4}-\d+|GHSA(?:-[0-9a-z]{4}){3}|CVE-\d{4}-\d+)\b/g;

/**
 * Go advisories with govulncheck's reachability (D74): called (with the repo's call site),
 * imported but not called, or required but not imported. An advisory govulncheck does not relate to
 * the code keeps "package present"; a govulncheck failure keeps every advisory as it was.
 */
async function withReachability(
  repoDir: string,
  project: GoProject,
  security: Assessment<GoProject>[],
  options: GoAssessOptions,
) {
  let reach: Awaited<ReturnType<typeof goVulnReachability>>;
  try {
    reach = await goVulnReachability(repoDir, project.root, project.module);
  } catch (error) {
    options.onProgress?.(`govulncheck failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const a of security)
    for (const f of a.findings) {
      const record = a.records.find((r) => r.id === f.changeId);
      const text = record ? `${record.id} ${record.summary}` : f.changeId;
      const ids = [...new Set([...text.matchAll(ADVISORY_ID)].map((m) => m[0]))];
      const r = ids.map((id) => reach.get(id)).find(Boolean);
      if (!r) continue;
      f.coverage = {
        filesScanned: 0,
        filesSkipped: [],
        languages: ["go"],
        resolutionLevel: "type",
        unresolvedSites: 0,
        transitiveAnalysed: true,
      };
      const fixedIn = record?.applicability.fixedIn ?? [];
      const position = `${a.instance.name}@${a.instance.version} is in the vulnerable range${fixedIn.length ? `; fixed in ${fixedIn.join(", ")}` : "; no fixed version is published"}.`;
      if (r.level === "called") {
        f.verdict = "affected";
        f.reachability = "function-reachable";
        f.priority = record ? priorityOf(record, "affected", options.now ?? new Date()) : 0;
        if (r.sites.length)
          f.callSites = r.sites.map((site) => ({
            ...site,
            snippet: lineOf(repoDir, site.file, site.line) || site.snippet,
          }));
        f.reason = `${position} govulncheck: ${r.symbol ?? "the vulnerable function"} is called${r.sites[0] ? ` from ${r.sites[0].file}:${r.sites[0].line}` : ""}.`;
      } else {
        // Not reached in govulncheck's call graph of this module: stated with that coverage (D74).
        f.verdict = "not_affected";
        f.reachability = "function-not-reachable";
        f.priority = null;
        f.callSites = [];
        f.reason = `${position} govulncheck: ${r.level === "imported" ? "the vulnerable package is imported, but its vulnerable functions are not called" : "the module is required, but the vulnerable package is not imported"}.`;
      }
    }
  for (const a of security) {
    a.summary = summariseFindings(a.findings);
    const open = a.findings.filter((f) => f.verdict === "affected").map((f) => f.priority ?? 4);
    a.priority = open.length && a.decision?.kind === "upgrade" ? Math.min(...open) : null;
  }
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
      detail: `${extraction.items.length} quoted item(s) from ${sources.length} source(s), ${extraction.dropped.length} dropped${extraction.error ? `; ${extraction.error}` : ""}`,
      costUsd: extraction.receipt.costUsd,
    });

  const plan = withVerifyOverrides(detectGoChecks(input.tree, a.project), a.project.root, input.verify);
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
    transaction: input.transaction ?? goTransaction(input.tree, a.project, a.instance, targetPath, target),
    instance: a.instance,
    target: targetPath === a.instance.name ? target : `${targetPath} ${target}`,
    findings: [...(a.summary?.breaking ?? []), ...(a.summary?.annotations ?? [])],
    records: a.records,
    notes: [...notes, ...(input.extraNotes ?? [])],
    targetDir,
    targetPaths: new Set(),
    docs: goDocsLookup(targetPath, target, targetDir),
    onEvent: input.onEvent,
  });
  const groupKey = `go/${a.instance.name}/${target}`;
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
