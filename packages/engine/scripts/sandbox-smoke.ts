/**
 * Proves the Cloudflare sandbox before anything depends on it (plan S02a task 1), on the real
 * demo repo `teire-dev/demo-npm-major`:
 *   1. start (cold) + repo tarball through the egress intercept
 *   2. baseline install with registry-only egress; a POST is denied and logged
 *   3. check phase: a live API call is denied with the marker and logged
 *   4. baseline checks offline (typecheck + tests with a JSON report)
 *   5. upgrade: back to install phase, new lockfile, install; check phase, same checks offline
 *   6. with --snapshot: snapshot timing, and a second sandbox started from that snapshot
 * Prints one JSON line per step. Run:
 *   pnpm --filter @teire/engine exec tsx --env-file=../../.env.local scripts/sandbox-smoke.ts
 */
import { CloudflareSandbox, sandboxConfigFromEnv } from "../src/verify/cloudflare";

const REPO_TARBALL = "https://api.github.com/repos/teire-dev/demo-npm-major/tarball/main";
const UPGRADE_TO = "openai@7.43.0";

const config = sandboxConfigFromEnv();
const run = Date.now().toString(36);
const sandbox = new CloudflareSandbox(config, `smoke-${run}`);
const report = (step: string, value: object) => console.log(JSON.stringify({ step, ...value }));

interface VitestReport {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
}

async function checks(label: string) {
  const typecheck = await sandbox.runJob(`${label}-typecheck`, ["npm", "run", "-s", "typecheck"], {
    timeoutSec: 300,
  });
  const tests = await sandbox.runJob(
    `${label}-tests`,
    ["npx", "--no-install", "vitest", "run", "--reporter=json", `--outputFile=/tmp/${label}-vitest.json`],
    { timeoutSec: 300 },
  );
  let counts: VitestReport | null = null;
  try {
    counts = JSON.parse(new TextDecoder().decode(await sandbox.readFile(`/tmp/${label}-vitest.json`)));
  } catch {}
  report(`${label}-checks`, {
    typecheck: {
      exitCode: typecheck.exitCode,
      ms: typecheck.ms,
      errors: (typecheck.stdout.match(/error TS\d+/g) ?? []).length,
    },
    tests: {
      exitCode: tests.exitCode,
      ms: tests.ms,
      total: counts?.numTotalTests,
      passed: counts?.numPassedTests,
      failed: counts?.numFailedTests,
    },
  });
}

/** Thrown to end the run early without a failure. */
class Done extends Error {}

let second: CloudflareSandbox | null = null;
try {
  const t0 = Date.now();
  const started = await sandbox.start({ instance: "standard-2", tarball: { url: REPO_TARBALL } });
  report("start", { ...started, wallMs: Date.now() - t0 });

  const install = await sandbox.runJob(
    "install-baseline",
    ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      timeoutSec: 600,
    },
  );
  report("install-baseline", {
    exitCode: install.exitCode,
    ms: install.ms,
    tail: install.stdout.trim().split("\n").slice(-1)[0],
  });

  const audit = await sandbox.exec(["npm", "audit", "--json"], { cwd: "/work", timeoutSec: 60 });
  report("install-phase-post-denied", { exitCode: audit.exitCode, ms: audit.ms });

  await sandbox.setPhase("check");
  const live = await sandbox.exec(
    [
      "node",
      "-e",
      'fetch("https://api.openai.com/v1/models").then(r=>console.log(r.status, r.headers.get("x-teire-egress"))).catch(e=>console.log("error", e.message))',
    ],
    { timeoutSec: 30 },
  );
  report("check-phase-live-api", { output: live.stdout.trim(), ms: live.ms });

  await checks("baseline");

  await sandbox.setPhase("install");
  const upgrade = await sandbox.runJob(
    "upgrade",
    ["npm", "install", UPGRADE_TO, "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { timeoutSec: 300 },
  );
  const reinstall = await sandbox.runJob(
    "install-after",
    ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      timeoutSec: 600,
    },
  );
  report("upgrade", {
    lockfile: upgrade.exitCode,
    lockfileMs: upgrade.ms,
    install: reinstall.exitCode,
    installMs: reinstall.ms,
  });
  await sandbox.setPhase("check");
  await checks("after-unedited");

  const egress = await sandbox.egress();
  report("egress-log", {
    denied: egress.length,
    byPhase: egress.reduce<Record<string, string[]>>((acc, e) => {
      acc[e.phase] = [...(acc[e.phase] ?? []), `${e.method} ${e.host}`];
      return acc;
    }, {}),
  });

  // Snapshots are a Cloudflare public beta and optional for Teire (each side installs its own
  // lockfile, plan D69); measure them only when asked.
  if (!process.argv.includes("--snapshot")) throw new Done();
  const snap = await sandbox.snapshot(`smoke-${run}`);
  report("snapshot", { id: snap.id, sizeMb: Math.round(snap.size / 1e6), ms: snap.ms });

  second = new CloudflareSandbox(config, `smoke-${run}-restore`);
  const t1 = Date.now();
  const restored = await second.start({ instance: "standard-2", snapshotId: snap.id });
  const probe = await second.exec(["bash", "-c", "ls /work/node_modules | wc -l; node -v"], {
    timeoutSec: 30,
  });
  report("start-from-snapshot", {
    ...restored,
    wallMs: Date.now() - t1,
    probe: probe.stdout.trim().split("\n"),
  });
} catch (error) {
  if (!(error instanceof Done)) {
    report("failed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
} finally {
  await sandbox.destroy().catch(() => {});
  await second?.destroy().catch(() => {});
  report("destroyed", {});
}
