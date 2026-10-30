/**
 * The smoke suite's fork layer (plan S21.1): every fork in `smoke/forks/` scanned with the real CLI
 * (`teire scan <repo> --json --all`, the same engine the worker runs) and held to what its file
 * says Teire must find. A file's prose stays the walk's record; this checks the parts it states
 * firmly:
 *  - each upgrade's package is read at its `from` version and an upgrade is proposed for it;
 *  - an upgrade, model or advisory whose expectation starts with "affected" is affected;
 *  - a model the file names is found, and each security package gets an advisory group.
 * Anything a file says that this can't read is listed as not checked, never passed silently.
 *
 * Run: pnpm --filter @teire/engine smoke:forks [fork …]   (needs the CLI built: pnpm --filter ./packages/cli build)
 * Writes smoke/results/forks-latest.json and, in GitHub Actions, the step summary. Exit 1 on a miss.
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const cli = join(root, "packages/cli/dist/teire.mjs");
const SCAN_TIMEOUT_MS = 20 * 60_000;

interface Finding {
  verdict: string;
  class?: string;
  position?: { version?: string | null; target?: string | null } | null;
  callSites?: { file: string }[];
}
interface Group {
  key: string;
  title: string;
  verdict: string;
  findings: Finding[];
}
interface Upgrade {
  package?: string;
  packages?: string;
  from?: string;
  teire?: string;
  expected?: string;
}
interface Fork {
  repo: string;
  status?: string;
  ecosystem?: string;
  upgrades?: Upgrade[];
  models?: { id: string; expected?: string }[];
  security?: { packages: string; expected?: string }[];
}
interface Check {
  what: string;
  ok: boolean | null;
  detail: string;
}

const only = new Set(process.argv.slice(2));
const files = readdirSync(join(root, "smoke/forks")).filter((f) => f.endsWith(".yaml"));
const report: { repo: string; skipped?: string; error?: string; checks: Check[]; ms?: number }[] = [];

for (const file of files) {
  const fork = YAML.parse(readFileSync(join(root, "smoke/forks", file), "utf8")) as Fork;
  if (only.size && !only.has(fork.repo) && !only.has(file.replace(/\.yaml$/, ""))) continue;
  // A fork its file retires (replaced by another, no passing baseline) isn't scanned.
  if (typeof fork.status === "string" && /replaced|retired|no baseline/i.test(fork.status)) {
    report.push({ repo: fork.repo, skipped: fork.status, checks: [] });
    continue;
  }
  const started = Date.now();
  let groups: Group[];
  let upgrades: { name: string; from: string | null; to: string }[] = [];
  try {
    const { stdout } = await run(process.execPath, [cli, "scan", fork.repo, "--json", "--all"], {
      cwd: root,
      timeout: SCAN_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    });
    const scan = JSON.parse(stdout) as {
      groups: Group[];
      upgrades?: { name: string; from: string | null; to: string }[];
      skipped?: unknown;
      notes?: string[];
    };
    groups = scan.groups;
    upgrades = scan.upgrades ?? [];
    // The fork's own ecosystem skipped (its toolchain isn't on this machine) is a setup failure, not misses.
    const skippedText = JSON.stringify(scan.skipped ?? []);
    if (fork.ecosystem && skippedText.includes(fork.ecosystem)) {
      report.push({
        repo: fork.repo,
        error: `the scan skipped ${fork.ecosystem}: ${skippedText.slice(0, 300)}`,
        checks: [],
      });
      continue;
    }
  } catch (error) {
    report.push({
      repo: fork.repo,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      checks: [],
    });
    continue;
  }
  const checks: Check[] = [];
  const affected = (text?: string) => !!text && /^\s*affected\b/i.test(text);
  // A package's group: `<ecosystem>/<name>/<target>` (a Go module or npm scope may hold slashes).
  const groupOf = (name: string) =>
    groups.find((g) => g.key.includes(`/${name}/`) && !g.key.startsWith("advisory/")) ??
    groups.find((g) => g.key.includes(`/${name}/`));

  for (const u of fork.upgrades ?? []) {
    const names = u.package
      ? [u.package]
      : (u.packages ?? "")
          .split(/,\s*/)
          .map((p) => p.trim().split(/\s+/)[0] ?? "")
          .filter(Boolean);
    if (!names.length) {
      checks.push({ what: "an upgrade entry", ok: null, detail: "names no package this can read" });
      continue;
    }
    for (const name of names) {
      const g = groupOf(name);
      // A plain upgrade (nothing it changes reaches the code) is in the scan's upgrades, not its groups.
      const plain = upgrades.find((x) => x.name === name);
      if (!g && plain) {
        checks.push({ what: `${name}: upgrade proposed`, ok: true, detail: `${plain.from} → ${plain.to}` });
        if (u.from)
          checks.push({
            what: `${name}: read at ${u.from}`,
            ok: !!plain.from && plain.from.replace(/^v/, "").startsWith(u.from.replace(/^v/, "")),
            detail: `scan read ${plain.from ?? "no version"}`,
          });
        if (affected(u.teire ?? u.expected))
          checks.push({
            what: `${name}: affected`,
            ok: false,
            detail: "only a plain upgrade: nothing reaches the code",
          });
        continue;
      }
      if (!g) {
        checks.push({
          what: `${name}: upgrade proposed`,
          ok: false,
          detail: "neither a group nor an upgrade for it",
        });
        continue;
      }
      const version = g.findings.find((f) => f.position?.version)?.position?.version ?? null;
      checks.push({
        what: `${name}: upgrade proposed`,
        ok: true,
        detail: `${g.key} (${g.verdict})`,
      });
      if (u.from)
        checks.push({
          what: `${name}: read at ${u.from}`,
          ok: !!version && version.replace(/^v/, "").startsWith(u.from.replace(/^v/, "")),
          detail: `scan read ${version ?? "no version"}`,
        });
      if (affected(u.teire ?? u.expected))
        checks.push({
          what: `${name}: affected`,
          ok: g.verdict === "affected",
          detail: `verdict ${g.verdict}; ${g.findings.flatMap((f) => f.callSites ?? []).length} site(s)`,
        });
    }
  }

  for (const m of fork.models ?? []) {
    const g = groups.find((x) => x.key.includes(m.id) || x.title.includes(m.id));
    checks.push({
      what: `model ${m.id}: found`,
      ok: !!g,
      detail: g ? `${g.key} (${g.verdict})` : "no group names it",
    });
    if (g && affected(m.expected))
      checks.push({
        what: `model ${m.id}: affected`,
        ok: g.verdict === "affected",
        detail: `verdict ${g.verdict}`,
      });
  }

  for (const s of fork.security ?? []) {
    for (const part of s.packages.split(/,\s*/)) {
      const name = part.split(/\s*→\s*/)[0]?.trim();
      if (!name) continue;
      const g = groups.find(
        (x) => x.key.includes(`/${name}/`) && x.findings.some((f) => f.class === "security"),
      );
      checks.push({
        what: `${name}: advisory found`,
        ok: !!g,
        detail: g ? `${g.key} (${g.verdict})` : "no security group for it",
      });
    }
  }
  report.push({ repo: fork.repo, checks, ms: Date.now() - started });
}

const misses = report.flatMap((r) => [
  ...(r.error ? [`${r.repo}: scan failed: ${r.error}`] : []),
  ...r.checks.filter((c) => c.ok === false).map((c) => `${r.repo}: ${c.what} — ${c.detail}`),
]);
const lines = [
  "# Smoke: forks",
  "",
  "| Fork | Passed | Missed | Not checked | Time |",
  "|---|---|---|---|---|",
  ...report.map((r) =>
    r.skipped
      ? `| ${r.repo} | skipped: ${r.skipped} | | | |`
      : r.error
        ? `| ${r.repo} | scan failed | | | |`
        : `| ${r.repo} | ${r.checks.filter((c) => c.ok).length} | ${r.checks.filter((c) => c.ok === false).length} | ${r.checks.filter((c) => c.ok === null).length} | ${Math.round((r.ms ?? 0) / 1000)} s |`,
  ),
  "",
  ...(misses.length ? ["## Misses", "", ...misses.map((m) => `- ${m}`)] : ["Every check passed."]),
];
mkdirSync(join(root, "smoke/results"), { recursive: true });
writeFileSync(
  join(root, "smoke/results/forks-latest.json"),
  `${JSON.stringify({ at: new Date().toISOString(), report }, null, 2)}\n`,
);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
process.exit(misses.length ? 1 : 0);
