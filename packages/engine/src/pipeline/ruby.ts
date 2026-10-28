import { REGISTRY, RUBY } from "../constants";
import type { DependencyInstance } from "../contract";
import { runFix } from "../fix/run";
import { rubyTransaction } from "../fix/upgrade-ruby";
import { composeFixPullRequest } from "../github/compose";
import { assess, locateTargets, summariseFindings } from "../impact";
import { type RubyProject, readRubyInventory } from "../inventory/ruby";
import type { RepoTree } from "../inventory/tree";
import { locateRuby } from "../locate/ruby";
import { documentsForReading, extractNotes, migrationNotes, noteRecords } from "../notes/extract";
import { gatherRubyNotes } from "../notes/sources";
import { getPackageInfo, type RegistryOptions } from "../registry/clients";
import { deprecationChange } from "../registry/deprecation";
import { type GemVersion, gemVersions, requiresOtherRuby } from "../registry/rubygems";
import { chooseTarget, type TargetPolicy } from "../registry/target";
import { rubygemsScheme } from "../registry/versions";
import { surfaceChangeRecords, unreadableDiff } from "../surface/records";
import { rubySurfaceDiff } from "../surface/ruby";
import { rubyDocsLookup } from "../surface/rubydoc";
import type { SurfaceDiff } from "../surface/types";
import { withVerifyOverrides } from "../verify/commands";
import { detectRubyChecks } from "../verify/ruby-commands";
import type { Assessment, FixDependencyInput, FixDependencyResult } from "./js";
import { securityAssessments } from "./security";

/**
 * The Ruby loop (plan S07): assess (Gemfile.lock → target that runs on the project's Ruby →
 * Prism surface diff of both .gem files plus dropped runtime dependencies → Prism sites →
 * verdicts, plus advisories) and fix (notes → requirement splice + `bundle lock --update
 * --conservative --cooldown` → agent → baseline vs after in the Ruby sandbox, with the services
 * and database setup the repo's CI uses → PR body).
 */
export interface RubyAssessOptions extends RegistryOptions {
  cooldownDays?: number;
  onlyPackage?: string;
  advisories?: boolean;
  githubToken?: string;
  surfaceDiff?: (name: string, from: string, to: string) => Promise<SurfaceDiff>;
  onProgress?: (line: string) => void;
}

function rubyPolicy(
  instance: DependencyInstance,
  project: RubyProject,
  versions: GemVersion[],
  options: RubyAssessOptions,
): TargetPolicy {
  const minutes = (options.cooldownDays ?? REGISTRY.cooldownDays) * 1440;
  // No pin: the sandbox's Ruby is the one the upgrade must run on.
  const ruby = project.rubyVersion ?? RUBY.sandboxRuby;
  return {
    now: options.now ?? new Date(),
    minAgeMinutes: () => minutes,
    pins: [],
    allowPrerelease: instance.version ? rubygemsScheme.isPrerelease(instance.version) : false,
    fallbackMajors: 0,
    exclude: (v) => requiresOtherRuby(versions, v, ruby),
  };
}

/** Top-level constants a gem defines, from the change paths (`Faraday::Connection#x` → `Faraday`). */
function rootsOf(name: string, diff: SurfaceDiff) {
  const roots = new Set(
    diff.changes
      .map((c) => c.path)
      .filter((p) => !/^(?:require|gem):/.test(p))
      .map((p) => p.split(/::|#|\./)[0] ?? "")
      .filter((r) => /^[A-Z]/.test(r)),
  );
  // `faraday-net_http` → `Faraday`, `aws-sdk-s3` → `Aws`: the usual first constant.
  const head = name.split(/[-_]/)[0] ?? name;
  roots.add(head.charAt(0).toUpperCase() + head.slice(1));
  return [...roots];
}

export async function assessRubyRepo(repoDir: string, tree: RepoTree, options: RubyAssessOptions) {
  const projects = readRubyInventory(tree);
  const assessments: Assessment<RubyProject>[] = [];
  const diffOf = options.surfaceDiff ?? rubySurfaceDiff;
  for (const project of projects) {
    for (const instance of project.instances) {
      if (!instance.direct || instance.source !== "registry") continue;
      if (options.onlyPackage && instance.name !== options.onlyPackage) continue;
      const base: Assessment<RubyProject> = {
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
      const [info, versions] = await Promise.all([
        getPackageInfo("rubygems", instance.name, options).catch(() => null),
        gemVersions(instance.name).catch(() => [] as GemVersion[]),
      ]);
      if (!info) {
        assessments.push(base);
        continue;
      }
      const decision = chooseTarget(
        info,
        instance.version,
        rubyPolicy(instance, project, versions, options),
        rubygemsScheme,
      );
      const a: Assessment<RubyProject> = {
        ...base,
        info,
        decision,
        deprecation: deprecationChange(info, instance.version),
      };
      if (decision.kind === "upgrade" && decision.isMajor) {
        options.onProgress?.(`${instance.name} ${instance.version} → ${decision.to}: Prism surface diff`);
        a.diff = await diffOf(instance.name, instance.version, decision.to).catch((error: unknown) =>
          unreadableDiff("rubygems", instance.name, instance.version as string, decision.to, error),
        );
        a.records = surfaceChangeRecords(a.diff);
        const { declKeys } = locateTargets(a.records);
        for (const r of a.records)
          for (const s of r.signatures) if (s.kind === "import-path") declKeys.add(s.value);
        a.located = await locateRuby({
          repoDir,
          tree,
          projectRoot: project.root,
          roots: rootsOf(instance.name, a.diff),
          declKeys,
          keptMethodNames: new Set(a.diff.keptMethodNames ?? []),
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
    if (options.advisories !== false) {
      const versionsOf = new Map<string, GemVersion[]>();
      for (const i of project.instances)
        if (i.version && i.source === "registry")
          versionsOf.set(i.name, await gemVersions(i.name).catch(() => [] as GemVersion[]));
      assessments.push(
        ...(await securityAssessments(project, "rubygems", rubygemsScheme, options, (instance) =>
          rubyPolicy(instance, project, versionsOf.get(instance.name) ?? [], options),
        )),
      );
    }
  }
  return { projects, assessments };
}

export async function fixRubyDependency(
  input: Omit<FixDependencyInput, "assessment"> & { assessment: Assessment<RubyProject> },
): Promise<FixDependencyResult> {
  const { assessment: a, options } = input;
  const decision = a.decision;
  if (decision?.kind !== "upgrade" || !a.instance.version)
    throw new Error(`${a.instance.name} has no upgrade target`);
  const target = decision.to;
  const from = a.instance.version;

  input.onEvent?.({ step: "transaction", detail: `reading release notes ${from} → ${target}` });
  const { sources, notes: notesWhy } = await gatherRubyNotes(a.instance.name, from, target, options);
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
  const behaviour = extraction ? noteRecords(extraction, { name: a.instance.name, from, to: target }) : [];
  if (extraction)
    input.onEvent?.({
      step: "transaction",
      model: extraction.receipt.model,
      detail: `${extraction.items.length} quoted item(s) from ${sources.length} source(s), ${extraction.dropped.length} dropped${extraction.error ? `; ${extraction.error}` : ""}`,
      costUsd: extraction.receipt.costUsd,
    });

  const plan = withVerifyOverrides(detectRubyChecks(input.tree, a.project), a.project.root, input.verify);
  // Bundler's cooldown set to the target's age excludes exactly the versions published after it:
  // the resolver lands on the version Teire analysed, not a newer one.
  const lockCooldown = decision.publishedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(decision.publishedAt)) / 86_400_000))
    : REGISTRY.cooldownDays;
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
    transaction: await rubyTransaction(input.tree, a.project, a.instance, target, lockCooldown),
    instance: a.instance,
    target,
    findings: [...(a.summary?.breaking ?? []), ...(a.summary?.annotations ?? [])],
    records: a.records,
    notes: [...notes, ...(input.extraNotes ?? [])],
    targetDir: "",
    targetPaths: new Set(),
    // The target gem itself: its upgrade guide and README sections, then lib/ definitions.
    docs: rubyDocsLookup(
      a.instance.name,
      target,
      sources.map((src) => ({ path: src.url.split("/").pop() ?? src.url, text: src.text })),
    ),
    onEvent: input.onEvent,
  });
  const groupKey = `rubygems/${a.instance.name}/${target}`;
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
