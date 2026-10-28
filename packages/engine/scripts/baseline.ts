/**
 * Baseline-only verification of a repo (plan S13.12): every project's own install and checks on the
 * unchanged commit, in the sandbox, with the repo's own tool versions. A pass means Teire can prove
 * changes there; a failure is an environment stop to fix (or a fork to replace) before any PR.
 * Prints one block per project and a JSON summary line. No GitHub writes, no model calls.
 * Run: pnpm --filter @teire/engine exec tsx --env-file=../../.env.local scripts/baseline.ts owner/repo [--ref=<sha>] [--root=<dir>] [--verbose]
 */
import { randomBytes } from "node:crypto";
import {
  directoryTree,
  fetchRepoTarball,
  readGoInventory,
  readJsInventory,
  readJvmInventory,
  readPythonInventory,
  readRubyInventory,
  readRustInventory,
  scopedTree,
} from "../src/inventory";
import {
  type CheckPlan,
  classifyFailure,
  detectGoChecks,
  detectJsChecks,
  detectJvmChecks,
  detectPyChecks,
  detectRubyChecks,
  detectRustChecks,
  runSide,
  selectBackend,
} from "../src/verify";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const [slug] = args.filter((a) => !a.startsWith("--"));
if (!slug?.includes("/")) throw new Error("usage: baseline.ts owner/repo [--ref=<sha>] [--root=<dir>]");
const [owner, repo] = slug.split("/") as [string, string];
const token = process.env.GITHUB_TOKEN;

const checkout = await fetchRepoTarball(owner, repo, flag("ref") ?? "HEAD", token ? { token } : {});
// --root reads only that root's files, so other roots' toolchains (go for go.mod) aren't needed here.
const only = flag("root");
const tree = scopedTree(directoryTree(checkout.dir), {
  paths: only && only !== "." ? [`${only}/**`] : [],
  ignorePaths: [],
});
const sha = checkout.sha ?? flag("ref") ?? "HEAD";
console.log(`# ${slug}@${sha.slice(0, 12)}`);

const plans: { ecosystem: string; root: string; plan: CheckPlan }[] = [
  ...readJsInventory(tree).map((p) => ({ ecosystem: "npm", root: p.root, plan: detectJsChecks(tree, p) })),
  ...(await readPythonInventory(checkout.dir)).map((p) => ({
    ecosystem: "pypi",
    root: p.root,
    plan: detectPyChecks(tree, p),
  })),
  ...(await readGoInventory(checkout.dir, tree)).map((p) => ({
    ecosystem: "go",
    root: p.root,
    plan: detectGoChecks(tree, p),
  })),
  ...readRustInventory(tree).map((p) => ({
    ecosystem: "cargo",
    root: p.root,
    plan: detectRustChecks(tree, p),
  })),
  ...readRubyInventory(tree).map((p) => ({
    ecosystem: "rubygems",
    root: p.root,
    plan: detectRubyChecks(tree, p),
  })),
  ...readJvmInventory(tree).map((p) => ({
    ecosystem: "maven",
    root: p.root,
    plan: detectJvmChecks(tree, p),
  })),
].filter((p) => !flag("root") || p.root === flag("root"));

const { backend, note } = await selectBackend();
console.log(`backend: ${note}`);
const tarball = {
  url: `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`,
  ...(token ? { token } : {}),
};
const summary: object[] = [];

for (const { ecosystem, root, plan } of plans) {
  console.log(`\n## ${ecosystem} ${root} (${plan.manager}, image ${plan.image})`);
  console.log(`install: ${plan.install.join(" ")}`);
  for (const c of plan.checks) console.log(`${c.name} (${c.source}): ${c.argv.join(" ")}`);
  for (const n of plan.notes) console.log(`note: ${n}`);
  if (!plan.checks.length) {
    summary.push({ ecosystem, root, result: "no-checks", notes: plan.notes });
    continue;
  }
  const session = await backend.open(`baseline-${repo}-${randomBytes(3).toString("hex")}`, {
    tarball,
    image: plan.image,
    ...(plan.instance ? { instance: plan.instance } : {}),
  });
  try {
    const side = await runSide(session, plan, "baseline", undefined, (line) => console.log(`  ${line}`));
    if (!side.install.ok || args.includes("--verbose"))
      console.log(`install output (tail):\n${side.install.output.slice(-3000)}`);
    const causes: Record<string, string> = {};
    for (const c of side.checks.filter((c) => c.exitCode !== 0)) {
      console.log(`${c.name} output (tail):\n${c.output.slice(-3000)}`);
      // How a fix run would read this failure (the PR's evidence label).
      const { cause } = classifyFailure(c.output, side.deniedHosts);
      causes[c.name] = cause ?? "unclassified";
      console.log(`${c.name}: classified ${cause}`);
    }
    const passed = side.install.ok && side.checks.every((c) => c.exitCode === 0);
    summary.push({
      ecosystem,
      root,
      result: passed ? "pass" : side.install.ok ? "checks-failed" : "install-failed",
      install: { exitCode: side.install.exitCode, ms: side.install.ms },
      checks: side.checks.map((c) => ({ name: c.name, exitCode: c.exitCode, ms: c.ms, counts: c.counts })),
      deniedHosts: side.deniedHosts,
      ...(Object.keys(causes).length ? { causes } : {}),
      notes: plan.notes,
    });
  } finally {
    await session.close();
  }
}
console.log(`\n${JSON.stringify({ repo: slug, sha, projects: summary })}`);
