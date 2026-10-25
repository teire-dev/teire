/**
 * The whole loop on one public repo, any supported ecosystem, through the same pipeline calls the
 * worker makes (no GitHub writes): assess every dependency, then with --fix=<package> fix that one
 * and print the diff, the baseline-vs-after table and the model per step.
 * With --api it also checks the API providers the repo talks to (an installed SDK, an API host in
 * its code) for retired models and removed endpoints, reading only those providers' sources;
 * --fix-api=<group> fixes one group (`models/nebius-token-factory`).
 * Run: pnpm --filter @teire/engine exec tsx --env-file=../../.env.local scripts/repo.ts owner/repo [--fix=<package>] [--api] [--fix-api=<group>]
 */
import { readTeireConfig } from "../src/config";
import { directoryTree, fetchRepoTarball } from "../src/inventory";
import type { PyProject } from "../src/inventory/python";
import type { RubyProject } from "../src/inventory/ruby";
import type { RustProject } from "../src/inventory/rust";
import { createTokenFactory, fetchModelPrices, tokenFactoryConfigFromEnv } from "../src/llm";
import {
  type Assessment,
  assessApiChanges,
  assessGoRepo,
  assessJsRepo,
  assessPyRepo,
  assessRubyRepo,
  assessRustRepo,
  fixApiChanges,
  fixGoDependency,
  fixJsDependency,
  fixPyDependency,
  fixRubyDependency,
  fixRustDependency,
  type GoAssessment,
  liveProviderChanges,
  repoInstances,
} from "../src/pipeline";
import { memoryCache } from "../src/registry";
import { type SideResult, selectBackend } from "../src/verify";

const args = process.argv.slice(2);
const fixName = args.find((a) => a.startsWith("--fix="))?.slice("--fix=".length);
const fixApi = args.find((a) => a.startsWith("--fix-api="))?.slice("--fix-api=".length);
const api = args.includes("--api") || !!fixApi;
const [slug = "teire-dev/demo-py-major"] = args.filter((a) => !a.startsWith("--"));
const [owner, repo] = slug.split("/") as [string, string];
const options = { cache: memoryCache(), githubToken: process.env.GITHUB_TOKEN };
const log = (...parts: unknown[]) => console.log(...parts);

const checkout = await fetchRepoTarball(
  owner,
  repo,
  "main",
  process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {},
);
const tree = directoryTree(checkout.dir);
log(`# ${slug}@${checkout.sha?.slice(0, 12)}`);

const js = await assessJsRepo(checkout.dir, tree, options);
const py = await assessPyRepo(checkout.dir, tree, options);
const go = await assessGoRepo(checkout.dir, tree, options);
const rust = await assessRustRepo(checkout.dir, tree, options);
const ruby = await assessRubyRepo(checkout.dir, tree, options);
const all: Assessment<{ root: string; manager: string; instances: Assessment["instance"][] }>[] = [
  ...js.assessments,
  ...py.assessments,
  ...go.assessments,
  ...rust.assessments,
  ...ruby.assessments,
];
for (const p of [...js.projects, ...py.projects, ...go.projects, ...rust.projects, ...ruby.projects])
  log(
    `\n## ${p.root} (${p.manager}${p.lockfile ? `, ${p.lockfile}` : ""}): ${p.instances.filter((i) => i.direct).length} direct, ${p.instances.filter((i) => !i.direct).length} transitive`,
  );
for (const a of all) {
  if (a.decision?.kind !== "upgrade") continue;
  const s = a.summary;
  const c = s?.coverage;
  log(
    `- [${a.purpose}] ${a.instance.ecosystem}:${a.instance.name} ${a.instance.version} → ${a.decision.to}${a.decision.isMajor ? " (major)" : ""}: ${s?.verdict ?? "?"}${s?.breaking.length ? `, ${s.breaking.reduce((n, f) => n + f.callSites.length, 0)} site(s)` : ""}${c ? ` · ${c.filesScanned} files ${c.resolutionLevel}-resolved, ${c.unresolvedSites} unresolved` : ""}`,
  );
  for (const f of s?.breaking ?? [])
    for (const site of f.callSites)
      log(`    ${site.file}:${site.line} ${f.changeKind} · ${site.snippet.slice(0, 100)}`);
  if (a.purpose === "security")
    for (const f of a.findings) log(`    ${f.changeId} [${f.reachability}]: ${f.reason.slice(0, 260)}`);
}

if (fixName) {
  const target = all.find((a) => a.instance.name === fixName && a.decision?.kind === "upgrade");
  if (!target) throw new Error(`no upgrade for ${fixName}`);
  const tf = createTokenFactory(tokenFactoryConfigFromEnv());
  const prices = await fetchModelPrices();
  const { backend, note } = await selectBackend();
  const common = {
    tf,
    prices,
    backend,
    backendNote: note,
    runId: `repo-${Date.now().toString(36)}`,
    repoDir: checkout.dir,
    tree,
    repo: { owner, repo, baseSha: checkout.sha ?? "main" },
    tarball: { url: `https://api.github.com/repos/${owner}/${repo}/tarball/${checkout.sha ?? "main"}` },
    options: { ...options, context7Key: process.env.CONTEXT7_API_KEY },
    onEvent: (e: { step: string; detail: string; model?: string; costUsd?: number }) =>
      log(
        `    [${e.step}${e.model ? ` · ${e.model}` : ""}] ${e.detail}${e.costUsd ? ` ($${e.costUsd.toFixed(4)})` : ""}`,
      ),
  };
  log(`\n## Fix ${target.instance.ecosystem}:${target.instance.name} (${note})`);
  const result =
    target.instance.ecosystem === "pypi"
      ? await fixPyDependency({ ...common, assessment: target as unknown as Assessment<PyProject> })
      : target.instance.ecosystem === "go"
        ? await fixGoDependency({ ...common, assessment: target as unknown as GoAssessment })
        : target.instance.ecosystem === "cargo"
          ? await fixRustDependency({ ...common, assessment: target as unknown as Assessment<RustProject> })
          : target.instance.ecosystem === "rubygems"
            ? await fixRubyDependency({ ...common, assessment: target as unknown as Assessment<RubyProject> })
            : await fixJsDependency({ ...common, assessment: target as unknown as Assessment });
  const run = result.run;
  log("\n## Diff");
  for (const m of run.manifest) log(`  ${m.path}: ${m.from} → ${m.to}`);
  if (run.lockfile) log(`  ${run.lockfile.path}: +${run.lockfile.added}/−${run.lockfile.removed} lines`);
  for (const f of run.files.filter((x) => !run.transactionFiles.includes(x.path))) log(f.patch);
  const cell = (side: SideResult, name: string) => {
    const k = side.checks.find((x) => x.name === name);
    return k
      ? `exit ${k.exitCode}${k.counts ? `, ${k.counts.passed}/${k.counts.collected} passed` : ""}`
      : "—";
  };
  for (const side of [run.baseline, run.after])
    if (!side.install.ok) log(`\n  ${side.side} install failed (exit ${side.install.exitCode}):\n${side.install.output.slice(-2500)}`);
  log("  | check | baseline | after |");
  for (const name of ["typecheck", "build", "test"])
    if (run.baseline.checks.some((k) => k.name === name))
      log(`  | ${name} | ${cell(run.baseline, name)} | ${cell(run.after, name)} |`);
  log(
    `\n  => ${run.evidence.kind.toUpperCase()} (${run.evidence.prMode}) — ${run.evidence.reasons.join("; ")}`,
  );
  if (result.notesReceipt)
    log(`  notes: ${result.notesReceipt.model} $${result.notesReceipt.costUsd.toFixed(4)}`);
  for (const a of run.attempts)
    log(
      `  attempt ${a.n}${a.replan ? " (replan)" : ""}: ${a.model}${a.failover ? " (failover)" : ""}, ${a.steps} steps, $${a.costUsd.toFixed(4)} → ${a.evidence}`,
    );
  log(`  run ${Math.round(run.ms / 1000)} s; PR title: ${result.pr.title}`);
}

if (api) {
  // Only the providers this repo talks to are read, live (the worker caches them across repos).
  const instances = await repoInstances(checkout.dir, tree);
  const reader = { tf: createTokenFactory(tokenFactoryConfigFromEnv()), prices: await fetchModelPrices() };
  const api = await assessApiChanges(checkout.dir, tree, instances, {
    changes: liveProviderChanges({ reader }),
    discover: options,
    triage: reader,
    declared: readTeireConfig(tree).sources,
    openapi: {
      ...options,
      githubToken: process.env.GITHUB_TOKEN,
      ...(checkout.sha ? { repo: { owner, name: repo, sha: checkout.sha } } : {}),
    },
  });
  const { scan, findings, providers, records, discovery } = api;
  log(
    `\n## Providers this repo uses: ${providers.map((p) => `${p.provider.name}${p.provider.discovery ? " [discovered]" : ""} (${p.via.join(", ")})`).join("; ") || "none"}`,
  );
  for (const p of providers.filter((x) => x.provider.discovery))
    log(
      `   ${p.provider.name}: ${p.provider.sources.map((s) => s.url).join(", ")} (via ${p.provider.discovery?.via.join(" + ")})`,
    );
  if (discovery.usage.length || discovery.notes.length)
    log(
      `   discovery: ${discovery.candidates} candidate(s), Tavily ${discovery.usage.map((u) => `${u.endpoint} ${u.credits} credit(s)`).join(", ") || "not called"}${discovery.notes.length ? `; ${discovery.notes.join("; ")}` : ""}`,
    );
  log(
    `## Provider changes (${records.length} records read; ${scan.filesScanned} files, ${scan.languages.join(", ")}, ${scan.ms} ms)`,
  );
  for (const n of api.openapiNotes) log(`   openapi: ${n}`);
  for (const r of api.receipts)
    log(`   triage ${r.model}: ${r.tokensIn} in / ${r.tokensOut} out, $${r.costUsd.toFixed(4)}, ${r.ms} ms`);
  for (const f of findings) {
    log(
      `- [${f.groupKey}] ${f.changeId}: ${f.verdict} (${f.class}, priority ${f.priority ?? "-"}) — ${f.reason}`,
    );
    for (const site of f.callSites) log(`    ${site.file}:${site.line} ${site.snippet.slice(0, 100)}`);
  }
  if (fixApi) {
    const group = findings.filter((f) => f.groupKey === fixApi);
    if (!group.length) throw new Error(`no findings in group ${fixApi}`);
    const tf = createTokenFactory(tokenFactoryConfigFromEnv());
    const { backend, note } = await selectBackend();
    const provider = records.find((r) => r.id === group[0]?.changeId)?.subject.provider;
    log(`\n## Fix ${fixApi} (${note})`);
    const result = await fixApiChanges({
      tf,
      prices: await fetchModelPrices(),
      backend,
      backendNote: note,
      runId: `repo-api-${Date.now().toString(36)}`,
      repoDir: checkout.dir,
      tree,
      repo: { owner, repo, baseSha: checkout.sha ?? "main" },
      tarball: { url: `https://api.github.com/repos/${owner}/${repo}/tarball/${checkout.sha ?? "main"}` },
      options: { ...options, context7Key: process.env.CONTEXT7_API_KEY },
      findings: group,
      records: records.filter((r) => group.some((f) => f.changeId === r.id)),
      related: records.filter((r) => r.subject.provider === provider && r.status === "confirmed"),
      providerName: providers.find((p) => p.provider.slug === provider)?.provider.name,
      onEvent: (e) =>
        log(
          `    [${e.step}${e.model ? ` · ${e.model}` : ""}] ${e.detail}${e.costUsd ? ` ($${e.costUsd.toFixed(4)})` : ""}`,
        ),
    });
    const run = result.run;
    log("\n## Diff");
    for (const f of run.files) log(f.patch);
    log(
      `\n  => ${run.evidence.kind.toUpperCase()} (${run.evidence.prMode}) — ${run.evidence.reasons.join("; ")}`,
    );
    for (const a of run.attempts)
      log(
        `  attempt ${a.n}${a.replan ? " (replan)" : ""}: ${a.model}, ${a.steps} steps, $${a.costUsd.toFixed(4)} → ${a.evidence}`,
      );
    log(`  run ${Math.round(run.ms / 1000)} s; PR title: ${result.pr.title}\n`);
    log(result.pr.body);
  }
}
