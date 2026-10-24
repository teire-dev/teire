/**
 * S02a end to end on one public repo, no GitHub writes: inventory → target → API-surface diff →
 * located sites → verdicts (and, as the later tasks land, verification and the fix).
 * Run: pnpm --filter @teire/engine s02a [owner/repo] [ref]
 */
import { join } from "node:path";
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

const [slug = "teire-dev/demo-npm-major", ref = "main"] = process.argv.slice(2);
const [owner, repo] = slug.split("/") as [string, string];
const cache = memoryCache();
const options = { cache };
const log = (...parts: unknown[]) => console.log(...parts);

const checkout = await fetchRepoTarball(owner, repo, ref);
log(`\n# ${slug}@${checkout.sha?.slice(0, 12) ?? ref}`);

for (const project of readJsInventory(directoryTree(checkout.dir))) {
  log(`\n## Inventory (${project.root}, ${project.manager} ${project.lockfileVersion ?? ""})`);
  const direct = project.instances.filter((i) => i.direct && i.source === "registry");
  for (const i of direct)
    log(`  ${i.name.padEnd(28)} ${String(i.version).padEnd(12)} ${i.scope} ${i.workspace}`);
  log(`  … ${project.instances.length - direct.length} transitive`);

  const policy = readJsUpgradePolicy(directoryTree(checkout.dir), project);
  for (const instance of direct) {
    if (!instance.version) continue;
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
    const layout = await npmTypesLayout(instance.name, instance.version, options);
    const target = await npmTypesLayout(instance.name, decision.to, options);
    const { declKeys, names } = locateTargets(records);
    const located = locateTs({
      repoDir: checkout.dir,
      projectRoot: project.root,
      packageName: instance.name,
      link: layout.link,
      roots: layout.roots,
      targetDir: target.link.dir,
      declKeys,
      names,
    });
    const c = located.coverage;
    log(
      `  located in ${located.ms} ms: ${located.hits.length} hit(s), ${located.imports.length} import(s); coverage ${c.filesScanned} files, ${c.resolutionLevel}, ${c.unresolvedSites} unresolved`,
    );
    const findings = assess({ instance, target: decision.to, isMajor: true, records, locate: located });
    const summary = summariseFindings(findings);
    log(
      `  => ${summary.verdict.toUpperCase()}: ${summary.breaking.length} breaking finding(s), ${summary.annotations.length} annotation(s); coverage ${c.filesScanned} files (${c.languages.join(", ")}), ${c.resolutionLevel}-resolved, ${c.unresolvedSites} unresolved`,
    );
    for (const f of findings) {
      log(`  ${f.verdict.toUpperCase().padEnd(14)} ${f.changeId.split("/").at(-1)} — ${f.reason}`);
      for (const site of f.callSites)
        log(`      ${join(site.file)}:${site.line}  ${site.kind}  ${site.snippet}`);
    }
  }
}
