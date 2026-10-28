/**
 * S02a end to end on one public repo, no GitHub writes: inventory → target → API-surface diff →
 * located sites → verdicts → (with --verify) the plain upgrade checked baseline vs after, or (with
 * --fix) the upgrade fixed by Nemotron 3 Ultra and verified in the sandbox.
 * Run: pnpm --filter @teire/engine s02a [owner/repo] [ref] [--verify | --fix] [--package=<name>]
 */

import type { ChangeV2, DependencyInstance } from "../src/contract";
import { jsTransaction, lockfileCommand, lookupDocs, planManifestEdits, runFix } from "../src/fix";
import {
  assess,
  type DependencyVerdict,
  type FindingDraft,
  locateTargets,
  summariseFindings,
} from "../src/impact";
import type { JsProject, RepoTree } from "../src/inventory";
import {
  directoryTree,
  fetchRepoTarball,
  jsTargetPolicy,
  readJsInventory,
  readJsUpgradePolicy,
} from "../src/inventory";
import { createTokenFactory, fetchModelPrices, tokenFactoryConfigFromEnv } from "../src/llm";
import { locateTs } from "../src/locate";
import {
  documentsForReading,
  extractNotes,
  gatherNpmNotes,
  githubRepoOf,
  migrationNotes,
} from "../src/notes";
import { chooseTarget, getNpmVersion, getPackageInfo, memoryCache, npmScheme } from "../src/registry";
import { npmSurface, npmSurfaceDiff, npmTypesLayout, surfaceChangeRecords } from "../src/surface";
import { detectJsChecks, type SideResult, type SideRun, selectBackend, verifyChange } from "../src/verify";

const args = process.argv.slice(2);
const verify = args.includes("--verify");
const fix = args.includes("--fix");
const onlyPackage = args.find((a) => a.startsWith("--package="))?.slice("--package=".length);
const [slug = "teire-dev/examples", ref = "main"] = args.filter((a) => !a.startsWith("--"));
const [owner, repo] = slug.split("/") as [string, string];
const options = { cache: memoryCache() };
const log = (...parts: unknown[]) => console.log(...parts);

const checkout = await fetchRepoTarball(owner, repo, ref);
const tree = directoryTree(checkout.dir);
log(`\n# ${slug}@${checkout.sha?.slice(0, 12) ?? ref}`);

for (const project of readJsInventory(tree)) {
  log(`\n## Inventory (${project.root}, ${project.manager} lockfile v${project.lockfileVersion ?? "?"})`);
  const direct = project.instances.filter((i) => i.direct && i.source === "registry");
  for (const i of direct)
    log(`  ${i.name.padEnd(28)} ${String(i.version).padEnd(12)} ${i.scope} ${i.workspace}`);
  log(`  … ${project.instances.length - direct.length} transitive`);

  const policy = readJsUpgradePolicy(tree, project);
  for (const instance of direct) {
    if (!instance.version || (onlyPackage && instance.name !== onlyPackage)) continue;
    const info = await getPackageInfo("npm", instance.name, options);
    if (!info) continue;
    const decision = chooseTarget(
      info,
      instance.version,
      jsTargetPolicy(policy, instance.name, instance.version),
      npmScheme,
    );
    if (decision.kind !== "upgrade" || !decision.isMajor) continue;

    log(`\n## ${instance.name} ${instance.version} → ${decision.to} (major)`);
    for (const s of decision.skipped) log(`  skipped ${s.count} newer (${s.reason}): ${s.detail}`);
    const diff = await npmSurfaceDiff(instance.name, instance.version, decision.to, options);
    log(`  surface: ${diff.from.symbols} → ${diff.to.symbols} symbols, ${JSON.stringify(diff.counts)}`);
    const records = surfaceChangeRecords(diff);
    const from = await npmTypesLayout(instance.name, instance.version, options);
    const to = await npmTypesLayout(instance.name, decision.to, options);
    const located = locateTs({
      repoDir: checkout.dir,
      projectRoot: project.root,
      packageName: instance.name,
      link: from.link,
      roots: from.roots,
      targetDir: to.link.dir,
      ...locateTargets(records),
    });
    const c = located.coverage;
    const findings = assess({ instance, target: decision.to, isMajor: true, records, locate: located });
    const summary = summariseFindings(findings);
    log(
      `  => ${summary.verdict.toUpperCase()}: ${summary.breaking.length} breaking finding(s), ${summary.annotations.length} annotation(s); coverage ${c.filesScanned} files (${c.languages.join(", ")}), ${c.resolutionLevel}-resolved, ${c.unresolvedSites} unresolved (${located.ms} ms)`,
    );
    for (const f of findings) {
      log(`  ${f.verdict.toUpperCase().padEnd(14)} ${f.changeId.split("/").at(-1)} — ${f.reason}`);
      for (const site of f.callSites) log(`      ${site.file}:${site.line}  ${site.kind}  ${site.snippet}`);
    }
    if (fix && summary.verdict === "affected") {
      await runFixStep({
        instance,
        target: decision.to,
        records,
        findings,
        summary,
        project,
        project_tree: tree,
      });
      continue;
    }
    if (!verify) continue;

    const plan = detectJsChecks(tree, project);
    const edits = planManifestEdits(tree, instance, decision.to);
    log(`\n  ## Verify the plain upgrade (${edits.map((e) => `${e.path}: ${e.from} → ${e.to}`).join(", ")})`);
    log(`  checks: ${plan.checks.map((k) => `${k.name} [${k.source}] ${k.argv.join(" ")}`).join(" | ")}`);
    const { backend, note } = await selectBackend();
    log(`  backend: ${note}`);
    const result = await verifyChange({
      backend,
      runId: `s02a-${Date.now().toString(36)}`,
      tarball: { url: `https://api.github.com/repos/${owner}/${repo}/tarball/${checkout.sha ?? ref}` },
      plan,
      change: {
        files: Object.fromEntries(edits.map((e) => [e.path, e.after])),
        lockfile: lockfileCommand(project.manager, project.lockfileVersion),
        ...(project.lockfile ? { lockfilePath: project.lockfile } : {}),
      },
      onLog: (line) => log(`    ${line}`),
    });
    const cell = (side: SideRun, name: string) => {
      const k = side.checks.find((x) => x.name === name);
      if (!k) return "—";
      return `exit ${k.exitCode}${k.counts ? `, ${k.counts.passed}/${k.counts.collected} passed` : ""}${k.typeErrors ? `, ${k.typeErrors} TS errors` : ""}`;
    };
    log("  | check | baseline | after |");
    for (const name of ["typecheck", "build", "test"])
      if (result.baseline.checks.some((k) => k.name === name))
        log(`  | ${name} | ${cell(result.baseline, name)} | ${cell(result.after, name)} |`);
    log(
      `  => evidence: ${result.evidence.kind} (${result.evidence.prMode}) — ${result.evidence.reasons.join("; ")}`,
    );
    if (result.after.deniedHosts.length)
      log(`  denied in check phase: ${result.after.deniedHosts.join(", ")}`);
  }
}

async function runFixStep(ctx: {
  instance: DependencyInstance;
  target: string;
  records: ChangeV2[];
  findings: FindingDraft[];
  summary: DependencyVerdict;
  project: JsProject;
  project_tree: RepoTree;
}) {
  const { instance, target } = ctx;
  const tf = createTokenFactory(tokenFactoryConfigFromEnv());
  const prices = await fetchModelPrices();
  log(`\n  ## Notes (${tf.modelId("reader")})`);
  const { sources } = await gatherNpmNotes(instance.name, instance.version ?? "", target, {
    ...options,
    githubToken: process.env.GITHUB_TOKEN,
  });
  for (const s of sources) log(`  source: ${s.kind} ${s.url}`);
  const removedApis = ctx.findings.flatMap((f) => f.callSites.map((c) => c.snippet.trim().slice(0, 80)));
  const extraction = await extractNotes(
    tf,
    documentsForReading(sources),
    { name: instance.name, from: instance.version ?? "", to: target, removedApis },
    prices,
  );
  const notes = migrationNotes(extraction);
  log(
    `  ${extraction.items.length} item(s) kept with verified quotes, ${extraction.dropped.length} dropped; ${notes.length} migration note(s); $${extraction.receipt.costUsd.toFixed(4)}`,
  );

  const detail = await getNpmVersion(instance.name, target, options);
  const repoOfPackage = githubRepoOf(detail?.repository?.url);
  const targetSurface = await npmSurface(instance.name, target, options);
  const targetPaths = new Set([
    ...Object.keys(targetSurface.surface.symbols),
    ...Object.keys(targetSurface.surface.aliases),
  ]);
  const targetLayout = await npmTypesLayout(instance.name, target, options);
  const plan = detectJsChecks(tree, ctx.project);
  const { backend, note } = await selectBackend();
  log(`\n  ## Fix (${tf.modelId("agent")} agent, ${tf.modelId("failover")} failover; ${note})`);
  log(`  checks: ${plan.checks.map((k) => `${k.name}: ${k.argv.join(" ")}`).join(" | ")}`);
  const run = await runFix({
    tf,
    prices,
    backend,
    runId: `s02a-${Date.now().toString(36)}`,
    repoDir: checkout.dir,
    tree,
    tarball: { url: `https://api.github.com/repos/${owner}/${repo}/tarball/${checkout.sha ?? ref}` },
    project: ctx.project,
    plan,
    transaction: jsTransaction(tree, ctx.project, instance, target),
    instance,
    target,
    findings: [...ctx.summary.breaking, ...ctx.summary.annotations],
    records: ctx.records,
    notes,
    targetDir: targetLayout.link.dir,
    targetPaths,
    docs: async (query) => {
      const d = await lookupDocs({
        packageName: instance.name,
        ...(repoOfPackage ? { sourceRepo: `${repoOfPackage.owner}/${repoOfPackage.repo}` } : {}),
        target,
        query,
        apiKey: process.env.CONTEXT7_API_KEY,
      });
      return `${d.note}\n${d.text}`;
    },
    onEvent: (e) =>
      log(
        `    [${e.step}${e.model ? ` · ${e.model}` : ""}] ${e.detail}${e.costUsd ? ` ($${e.costUsd.toFixed(4)})` : ""}`,
      ),
  });

  log("\n  ## Diff");
  for (const m of run.manifest) log(`  ${m.path}: ${m.from} → ${m.to}`);
  if (run.lockfile)
    log(
      `  ${run.lockfile.path}: regenerated by ${plan.manager} (+${run.lockfile.added}/−${run.lockfile.removed} lines)`,
    );
  for (const f of run.files.filter((x) => !run.manifest.some((m) => m.path === x.path))) log(f.patch);
  const cell = (side: SideResult, name: string) => {
    const k = side.checks.find((x) => x.name === name);
    if (!k) return "—";
    return `exit ${k.exitCode}${k.counts ? `, ${k.counts.passed}/${k.counts.collected} passed` : ""}${k.typeErrors ? `, ${k.typeErrors} TS errors` : ""}`;
  };
  log("  | check | baseline | after |");
  for (const name of ["typecheck", "build", "test"])
    if (run.baseline.checks.some((k) => k.name === name))
      log(`  | ${name} | ${cell(run.baseline, name)} | ${cell(run.after, name)} |`);
  log(
    `\n  => ${run.evidence.kind.toUpperCase()} (${run.evidence.prMode} PR) — ${run.evidence.reasons.join("; ")}`,
  );
  log("  ## Models per step");
  log(
    `  notes: ${extraction.receipt.model} (${extraction.receipt.tokensIn} in / ${extraction.receipt.tokensOut} out, $${extraction.receipt.costUsd.toFixed(4)})`,
  );
  for (const a of run.attempts)
    log(
      `  attempt ${a.n}${a.replan ? " (replanned)" : ""}: ${a.model}${a.failover ? " (failover)" : ""}, ${a.steps} steps, $${a.costUsd.toFixed(4)} → ${a.evidence}`,
    );
  if (!run.attempts.length) log("  no agent step needed: deterministic edits were enough");
  log(
    `  total model cost $${(run.costUsd + extraction.receipt.costUsd).toFixed(4)}; run ${Math.round(run.ms / 1000)} s; summary: ${run.summary}`,
  );
}
