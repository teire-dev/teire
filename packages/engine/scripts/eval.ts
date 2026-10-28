/**
 * The S03 evaluation, extended in S10 to all six ecosystems and the API cases: real repos in
 * teire-dev through the same pipeline calls the worker makes (assess, then fix in the sandbox),
 * with false-positive checks per ecosystem. The fix agent runs once on Nemotron 3 Ultra and once on
 * Nemotron 3 Super. Release notes are read by the reader model (Ultra) in both runs, so only the
 * agent differs. One JSON line per run goes to --out; nothing is written to GitHub.
 * Run: pnpm --filter @teire/engine exec tsx --env-file=../../.env.local scripts/eval.ts --out=<file> [--case=<slug>] [--models=ultra,super]
 */
import { appendFileSync } from "node:fs";
import { directoryTree, fetchRepoTarball, scopedTree } from "../src/inventory";

/** A case's tree: the whole checkout, narrowed to its folder when the slug names one (`owner/repo/folder`). */
const treeOf = (dir: string, sub: string) =>
  sub ? scopedTree(directoryTree(dir), { paths: [`${sub}/**`], ignorePaths: [] }) : directoryTree(dir);

import type { JvmProject } from "../src/inventory/jvm";
import type { PyProject } from "../src/inventory/python";
import type { RubyProject } from "../src/inventory/ruby";
import type { RustProject } from "../src/inventory/rust";
import { createTokenFactory, fetchModelPrices, tokenFactoryConfigFromEnv } from "../src/llm";
import {
  type Assessment,
  assessApiChanges,
  assessGoRepo,
  assessJsRepo,
  assessJvmRepo,
  assessPyRepo,
  assessRubyRepo,
  assessRustRepo,
  fixApiChanges,
  fixGoDependency,
  fixJsDependency,
  fixJvmDependency,
  fixPyDependency,
  fixRubyDependency,
  fixRustDependency,
  type GoAssessment,
  liveProviderChanges,
  repoInstances,
} from "../src/pipeline";
import { memoryCache } from "../src/registry";
import { type SideResult, selectBackend } from "../src/verify";

interface Case {
  slug: string;
  ecosystem: "npm" | "pypi" | "go" | "cargo" | "rubygems" | "maven";
  name: string;
  expect: "affected" | "not_affected";
}

/** S03's npm and PyPI cases, then S10's: one major per ecosystem plus a false-positive check each. */
const CASES: Case[] = [
  { slug: "teire-dev/examples/npm-major", ecosystem: "npm", name: "openai", expect: "affected" },
  { slug: "teire-dev/examples/npm-zod", ecosystem: "npm", name: "zod", expect: "affected" },
  { slug: "teire-dev/examples/py-major", ecosystem: "pypi", name: "anthropic", expect: "affected" },
  { slug: "teire-dev/examples/py-openai", ecosystem: "pypi", name: "openai", expect: "affected" },
  { slug: "teire-dev/examples/py-httpx", ecosystem: "pypi", name: "httpx", expect: "affected" },
  { slug: "teire-dev/examples/py-pydantic", ecosystem: "pypi", name: "pydantic", expect: "affected" },
  {
    slug: "teire-dev/examples/go-major",
    ecosystem: "go",
    name: "github.com/golang-jwt/jwt/v4",
    expect: "affected",
  },
  { slug: "teire-dev/examples/rust-major", ecosystem: "cargo", name: "rand", expect: "affected" },
  { slug: "teire-dev/examples/ruby-major", ecosystem: "rubygems", name: "faraday", expect: "affected" },
  { slug: "teire-dev/examples/rails-db", ecosystem: "rubygems", name: "faraday", expect: "affected" },
  {
    slug: "teire-dev/examples/jvm-major",
    ecosystem: "maven",
    name: "com.google.guava:guava",
    expect: "affected",
  },
  {
    slug: "teire-dev/examples/kotlin-major",
    ecosystem: "maven",
    name: "com.squareup.okhttp3:okhttp",
    expect: "affected",
  },
  { slug: "teire-dev/examples/clean", ecosystem: "npm", name: "openai", expect: "not_affected" },
  { slug: "teire-dev/examples/py-clean", ecosystem: "pypi", name: "httpx", expect: "not_affected" },
  {
    slug: "teire-dev/examples/go-clean",
    ecosystem: "go",
    name: "github.com/golang-jwt/jwt/v4",
    expect: "not_affected",
  },
  { slug: "teire-dev/examples/rust-clean", ecosystem: "cargo", name: "thiserror", expect: "not_affected" },
  { slug: "teire-dev/examples/ruby-clean", ecosystem: "rubygems", name: "faraday", expect: "not_affected" },
  {
    slug: "teire-dev/examples/jvm-clean",
    ecosystem: "maven",
    name: "com.google.guava:guava",
    expect: "not_affected",
  },
];

/** Provider changes (retired models): no package moves; the agent adapts the code around the swap. */
const API_CASES: { slug: string; group: string }[] = [
  { slug: "teire-dev/examples/py-agent", group: "models/nebius-token-factory" },
  { slug: "teire-dev/examples/ai-web", group: "models/openai" },
  // Groq has no hand-written reader: discovery names it after its domain (`groq-com`).
  { slug: "teire-dev/examples/wrapped-models", group: "models/groq-com" },
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
  const [owner = "", repo = "", ...rest] = c.slug.split("/");
  const sub = rest.join("/");
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
    const tree = treeOf(checkout.dir, sub);
    const t0 = Date.now();
    const assessed =
      c.ecosystem === "npm"
        ? await assessJsRepo(checkout.dir, tree, options)
        : c.ecosystem === "pypi"
          ? await assessPyRepo(checkout.dir, tree, options)
          : c.ecosystem === "go"
            ? await assessGoRepo(checkout.dir, tree, options)
            : c.ecosystem === "cargo"
              ? await assessRustRepo(checkout.dir, tree, options)
              : c.ecosystem === "rubygems"
                ? await assessRubyRepo(checkout.dir, tree, options)
                : await assessJvmRepo(checkout.dir, tree, options);
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
        const input = { ...common, repoDir: fresh.dir, tree: treeOf(fresh.dir, sub) };
        const result =
          c.ecosystem === "pypi"
            ? await fixPyDependency({ ...input, assessment: a as unknown as Assessment<PyProject> })
            : c.ecosystem === "go"
              ? await fixGoDependency({ ...input, assessment: a as unknown as GoAssessment })
              : c.ecosystem === "cargo"
                ? await fixRustDependency({ ...input, assessment: a as unknown as Assessment<RustProject> })
                : c.ecosystem === "rubygems"
                  ? await fixRubyDependency({ ...input, assessment: a as unknown as Assessment<RubyProject> })
                  : c.ecosystem === "maven"
                    ? await fixJvmDependency({ ...input, assessment: a as unknown as Assessment<JvmProject> })
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

// Provider sources are read live, only for the providers each repo talks to; the same Nemotron
// reader traces wrapped model IDs, as the worker's scan does.
const reader = { tf: createTokenFactory(tokenFactoryConfigFromEnv()), prices: await fetchModelPrices() };
const providerChanges = liveProviderChanges({ reader });
for (const c of API_CASES.filter((x) => !wanted.length || wanted.some((w) => x.slug.endsWith(w)))) {
  const [owner = "", repo = "", ...rest] = c.slug.split("/");
  const sub = rest.join("/");
  try {
    const token = process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {};
    const checkout = await fetchRepoTarball(owner, repo, "main", token);
    const t0 = Date.now();
    const tree = treeOf(checkout.dir, sub);
    const {
      scan,
      findings,
      records: catalog,
    } = await assessApiChanges(checkout.dir, tree, await repoInstances(checkout.dir, tree), {
      changes: providerChanges,
      discover: { cache: memoryCache() },
      triage: reader,
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
          runId: `eval-${sub || repo}-${m}-${Date.now().toString(36)}`,
          repoDir: fresh.dir,
          tree: treeOf(fresh.dir, sub),
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
