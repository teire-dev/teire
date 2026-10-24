/**
 * S02a end to end on one public repo, no GitHub writes: inventory → target → API-surface diff →
 * located sites → verdicts → (with --verify) the upgrade checked baseline vs after in the sandbox.
 * Run: pnpm --filter @teire/engine s02a [owner/repo] [ref] [--verify] [--package=<name>]
 */
import { lockfileCommand, planManifestEdits } from "../src/fix";
import { assess, locateTargets, summariseFindings } from "../src/impact";
import {
  directoryTree,
  fetchRepoTarball,
  jsTargetPolicy,
  readJsInventory,
  readJsUpgradePolicy,
} from "../src/inventory";
import { locateTs } from "../src/locate";
import { chooseTarget, getPackageInfo, memoryCache, npmScheme } from "../src/registry";
import { npmSurfaceDiff, npmTypesLayout, surfaceChangeRecords } from "../src/surface";
import { detectJsChecks, type SideRun, selectBackend, verifyChange } from "../src/verify";

const args = process.argv.slice(2);
const verify = args.includes("--verify");
const onlyPackage = args.find((a) => a.startsWith("--package="))?.slice("--package=".length);
const [slug = "teire-dev/demo-npm-major", ref = "main"] = args.filter((a) => !a.startsWith("--"));
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
        lockfile: lockfileCommand(plan.manager, project.lockfileVersion),
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
