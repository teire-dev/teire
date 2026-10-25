/**
 * The S03 evaluation: real repos in teire-dev through the same pipeline calls the worker makes
 * (assess, then fix in the sandbox), the fix agent run once on Nemotron 3 Ultra and once on
 * Nemotron 3 Super. Release notes are read by the reader model (Ultra) in both runs, so only the
 * agent differs. One JSON line per run goes to --out; nothing is written to GitHub.
 * Run: pnpm --filter @teire/engine exec tsx --env-file=../../.env.local scripts/eval.ts --out=<file> [--case=<slug>] [--models=ultra,super]
 */
import { appendFileSync } from "node:fs";
import { directoryTree, fetchRepoTarball } from "../src/inventory";
import type { PyProject } from "../src/inventory/python";
import { createTokenFactory, fetchModelPrices, tokenFactoryConfigFromEnv } from "../src/llm";
import {
  type Assessment,
  assessApiChanges,
  assessJsRepo,
  assessPyRepo,
  fixApiChanges,
  fixJsDependency,
  fixPyDependency,
  liveProviderChanges,
  repoInstances,
} from "../src/pipeline";
import { memoryCache } from "../src/registry";
import { type SideResult, selectBackend } from "../src/verify";

interface Case {
  slug: string;
  ecosystem: "npm" | "pypi";
  name: string;
  expect: "affected" | "not_affected";
}

const CASES: Case[] = [
  { slug: "teire-dev/demo-npm-major", ecosystem: "npm", name: "openai", expect: "affected" },
  { slug: "teire-dev/demo-npm-zod", ecosystem: "npm", name: "zod", expect: "affected" },
  { slug: "teire-dev/demo-py-major", ecosystem: "pypi", name: "anthropic", expect: "affected" },
  { slug: "teire-dev/demo-py-openai", ecosystem: "pypi", name: "openai", expect: "affected" },
  { slug: "teire-dev/demo-py-httpx", ecosystem: "pypi", name: "httpx", expect: "affected" },
  { slug: "teire-dev/demo-py-pydantic", ecosystem: "pypi", name: "pydantic", expect: "affected" },
  { slug: "teire-dev/demo-clean", ecosystem: "npm", name: "openai", expect: "not_affected" },
  { slug: "teire-dev/demo-py-clean", ecosystem: "pypi", name: "httpx", expect: "not_affected" },
];

/** Provider changes (retired models): no package moves; the agent adapts the code around the swap. */
const API_CASES: { slug: string; group: string }[] = [
  { slug: "teire-dev/demo-py-agent", group: "models/nebius-token-factory" },
];

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = flag("out");
if (!out) throw new Error("--out=<file> is required");
const only = flag("case");
const models = (flag("models") ?? "ultra,super").split(",");

const env = tokenFactoryConfigFromEnv();
const prices = await fetchModelPrices();
const { backend, note } = await selectBackend();
const counts = (side: SideResult) =>
  side.checks.map((k) => ({
    name: k.name,
    exit: k.exitCode,
    ...(k.counts ? { passed: k.counts.passed, collected: k.counts.collected } : {}),
  }));

const wanted = only?.split(",") ?? [];
for (const c of CASES.filter((x) => !wanted.length || wanted.some((w) => x.slug.endsWith(w)))) {
  const [owner, repo] = c.slug.split("/") as [string, string];
  try {
    const options = {
      cache: memoryCache(),
      githubToken: process.env.GITHUB_TOKEN,
      onlyPackage: c.name,
      advisories: false,
    };
    const checkout = await fetchRepoTarball(
      owner,
      repo,
      "main",
      process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {},
    );
    const tree = directoryTree(checkout.dir);
    const t0 = Date.now();
    const assessed =
      c.ecosystem === "npm"
        ? await assessJsRepo(checkout.dir, tree, options)
        : await assessPyRepo(checkout.dir, tree, options);
    const a = (
      assessed.assessments as Assessment<{
        root: string;
        manager: string;
        instances: Assessment["instance"][];
      }>[]
    ).find((x) => x.instance.name === c.name && x.decision?.kind === "upgrade");
    if (a?.decision?.kind !== "upgrade") {
      appendFileSync(out, `${JSON.stringify({ case: c.slug, error: "no upgrade decision" })}\n`);
      continue;
    }
    const assessment = {
      case: c.slug,
      package: `${c.ecosystem}:${c.name}`,
      from: a.instance.version,
      to: a.decision.to,
      expected: c.expect,
      verdict: a.summary?.verdict ?? null,
      sites: (a.summary?.breaking ?? []).flatMap((f) =>
        f.callSites.map((s) => `${s.file}:${s.line} ${f.changeKind}`),
      ),
      annotations: (a.summary?.annotations ?? []).length,
      coverage: a.summary?.coverage ?? null,
      diffCounts: a.diff?.counts ?? null,
      assessMs: Date.now() - t0,
    };
    console.log(
      `\n# ${c.slug} ${assessment.package} ${assessment.from} → ${assessment.to}: ${assessment.verdict} (expected ${c.expect}), ${assessment.sites.length} site(s)`,
    );
    // A clean repo is fixed once (a plain bump); the agent has nothing to do, so no model comparison.
    for (const m of c.expect === "affected" ? models : ["ultra"]) {
      const agentModel = m === "super" ? env.models.failover : env.models.agent;
      const tf = createTokenFactory({
        ...env,
        models: { ...env.models, agent: agentModel, failover: env.models.failover },
      });
      const runId = `eval-${repo}-${m}-${Date.now().toString(36)}`;
      const common = {
        tf,
        prices,
        backend,
        backendNote: note,
        runId,
        repoDir: checkout.dir,
        tree,
        repo: { owner, repo, baseSha: checkout.sha ?? "main" },
        tarball: { url: `https://api.github.com/repos/${owner}/${repo}/tarball/${checkout.sha ?? "main"}` },
        options: { ...options, context7Key: process.env.CONTEXT7_API_KEY },
        onEvent: (e: { step: string; detail: string; model?: string }) =>
          console.log(`    [${m} ${e.step}${e.model ? ` · ${e.model}` : ""}] ${e.detail.slice(0, 160)}`),
      };
      const started = Date.now();
      try {
        // A fresh checkout per run: the agent edits the working copy in place.
        const fresh = await fetchRepoTarball(
          owner,
          repo,
          "main",
          process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {},
        );
        const input = { ...common, repoDir: fresh.dir, tree: directoryTree(fresh.dir) };
        const result =
          c.ecosystem === "pypi"
            ? await fixPyDependency({ ...input, assessment: a as unknown as Assessment<PyProject> })
            : await fixJsDependency({ ...input, assessment: a as unknown as Assessment });
        const run = result.run;
        const record = {
          ...assessment,
          agent: m,
          agentModel,
          evidence: run.evidence.kind,
          prMode: run.evidence.prMode,
          reasons: run.evidence.reasons,
          baseline: counts(run.baseline),
          after: counts(run.after),
          attempts: run.attempts.map((x) => ({
            n: x.n,
            model: x.model,
            failover: x.failover,
            replan: x.replan,
            steps: x.steps,
            evidence: x.evidence,
            costUsd: x.costUsd,
          })),
          codemods: run.codemods.length,
          files: run.files.filter((f) => !run.transactionFiles.includes(f.path)).map((f) => f.path),
          patchLines: run.files
            .filter((f) => !run.transactionFiles.includes(f.path))
            .reduce((n, f) => n + f.patch.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length, 0),
          notesCostUsd: result.notesReceipt?.costUsd ?? 0,
          costUsd: run.costUsd + (result.notesReceipt?.costUsd ?? 0),
          ms: Date.now() - started,
          // What the sandbox said, when it did not verify: the reason a fix failed is in here.
          ...(run.evidence.kind === "verified"
            ? {}
            : {
                afterOutput: run.after.checks.map((k) => `[${k.name}] ${k.output.slice(-3000)}`).join("\n"),
                summary: run.summary,
              }),
          patch: run.files
            .filter((f) => !run.transactionFiles.includes(f.path))
            .map((f) => f.patch)
            .join("\n"),
        };
        appendFileSync(out, `${JSON.stringify(record)}\n`);
        console.log(
          `  => ${m}: ${record.evidence} (${record.prMode}), ${record.attempts.length} attempt(s), $${record.costUsd.toFixed(4)}, ${Math.round(record.ms / 1000)} s`,
        );
      } catch (error) {
        appendFileSync(
          out,
          `${JSON.stringify({ ...assessment, agent: m, agentModel, error: String(error).slice(0, 2000), ms: Date.now() - started })}\n`,
        );
        console.log(`  => ${m}: error ${String(error).slice(0, 300)}`);
      }
    }
  } catch (error) {
    // A network failure while assessing one repo must not end the run for the others.
    appendFileSync(out, `${JSON.stringify({ case: c.slug, error: String(error).slice(0, 2000) })}\n`);
    console.log(`  => error ${String(error).slice(0, 300)}`);
  }
}

// Provider sources are read live, only for the providers each repo talks to.
const providerChanges = liveProviderChanges({
  reader: { tf: createTokenFactory(tokenFactoryConfigFromEnv()), prices: await fetchModelPrices() },
});
for (const c of API_CASES.filter((x) => !wanted.length || wanted.some((w) => x.slug.endsWith(w)))) {
  const [owner, repo] = c.slug.split("/") as [string, string];
  try {
    const token = process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {};
    const checkout = await fetchRepoTarball(owner, repo, "main", token);
    const t0 = Date.now();
    const tree = directoryTree(checkout.dir);
    const {
      scan,
      findings,
      records: catalog,
    } = await assessApiChanges(checkout.dir, tree, await repoInstances(checkout.dir, tree), {
      changes: providerChanges,
      discover: { cache: memoryCache() },
    });
    const group = findings.filter((f) => f.groupKey === c.group);
    const assessment = {
      case: c.slug,
      package: c.group,
      from: group.map((f) => f.position.version).join(", "),
      to: group.map((f) => f.position.target).join(", "),
      expected: "affected",
      verdict: group.some((f) => f.verdict === "affected")
        ? "affected"
        : group.length
          ? "inconclusive"
          : "not_affected",
      sites: group.flatMap((f) => f.callSites.map((s) => `${s.file}:${s.line} ${f.changeKind}`)),
      coverage: group[0]?.coverage ?? null,
      scanMs: scan.ms,
      assessMs: Date.now() - t0,
    };
    console.log(`\n# ${c.slug} ${c.group}: ${assessment.verdict}, ${assessment.sites.length} site(s)`);
    const provider = catalog.find((r) => r.id === group[0]?.changeId)?.subject.provider;
    for (const m of models) {
      const agentModel = m === "super" ? env.models.failover : env.models.agent;
      const tf = createTokenFactory({ ...env, models: { ...env.models, agent: agentModel } });
      const started = Date.now();
      try {
        const fresh = await fetchRepoTarball(owner, repo, "main", token);
        const result = await fixApiChanges({
          tf,
          prices,
          backend,
          backendNote: note,
          runId: `eval-${repo}-${m}-${Date.now().toString(36)}`,
          repoDir: fresh.dir,
          tree: directoryTree(fresh.dir),
          repo: { owner, repo, baseSha: fresh.sha ?? "main" },
          tarball: { url: `https://api.github.com/repos/${owner}/${repo}/tarball/${fresh.sha ?? "main"}` },
          options: { cache: memoryCache() },
          findings: group,
          records: catalog.filter((r) => group.some((f) => f.changeId === r.id)),
          related: catalog.filter((r) => r.subject.provider === provider && r.status === "confirmed"),
          onEvent: (e: { step: string; detail: string; model?: string }) =>
            console.log(`    [${m} ${e.step}${e.model ? ` · ${e.model}` : ""}] ${e.detail.slice(0, 160)}`),
        });
        const run = result.run;
        const record = {
          ...assessment,
          agent: m,
          agentModel,
          evidence: run.evidence.kind,
          prMode: run.evidence.prMode,
          reasons: run.evidence.reasons,
          baseline: counts(run.baseline),
          after: counts(run.after),
          attempts: run.attempts.map((x) => ({
            n: x.n,
            model: x.model,
            failover: x.failover,
            replan: x.replan,
            steps: x.steps,
            evidence: x.evidence,
            costUsd: x.costUsd,
          })),
          codemods: run.codemods.length,
          files: run.files.map((f) => f.path),
          patchLines: run.files.reduce(
            (n, f) => n + f.patch.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length,
            0,
          ),
          notesCostUsd: 0,
          costUsd: run.costUsd,
          ms: Date.now() - started,
          ...(run.evidence.kind === "verified"
            ? {}
            : {
                afterOutput: run.after.checks.map((k) => `[${k.name}] ${k.output.slice(-3000)}`).join("\n"),
                summary: run.summary,
              }),
          patch: run.files.map((f) => f.patch).join("\n"),
        };
        appendFileSync(out, `${JSON.stringify(record)}\n`);
        console.log(
          `  => ${m}: ${record.evidence} (${record.prMode}), ${record.attempts.length} attempt(s), $${record.costUsd.toFixed(4)}, ${Math.round(record.ms / 1000)} s`,
        );
      } catch (error) {
        appendFileSync(
          out,
          `${JSON.stringify({ ...assessment, agent: m, agentModel, error: String(error).slice(0, 2000), ms: Date.now() - started })}\n`,
        );
        console.log(`  => ${m}: error ${String(error).slice(0, 300)}`);
      }
    }
  } catch (error) {
    appendFileSync(out, `${JSON.stringify({ case: c.slug, error: String(error).slice(0, 2000) })}\n`);
    console.log(`  => error ${String(error).slice(0, 300)}`);
  }
}
