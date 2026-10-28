import { VERIFY } from "../constants";
import type { VerifyBackend, VerifySession } from "./backend";
import type { CheckPlan } from "./commands";
import { type CheckResult, decideEvidence, type Evidence, type SideResult } from "./evidence";
import { countsFromJson, countsFromJunit, countsFromOutput, goJsonToText, typeErrorCount } from "./reports";

/**
 * Baseline vs after (card C5, D69): each side in its own sandbox from the same commit, each
 * installing its own lockfile with registry-only network, then the same checks with the network
 * off. The after side first receives the change (manifest, code) and regenerates the lockfile
 * with the repo's package manager in lockfile-only mode.
 */
export interface Change {
  /** Repo-relative path → new content. */
  files: Record<string, string>;
  /** Lockfile regeneration to run after writing the files (install phase, project directory). */
  lockfile?: string[];
  /** Repo-relative lockfile path to read back after regeneration. */
  lockfilePath?: string;
  /**
   * Changes that aren't text writes, so another project's after side gets the exact final file set
   * (review R2): bytes (a binary lockfile), a deletion (null), an executable (100755) or a symlink
   * (120000, whose bytes are the link's target).
   */
  writes?: { path: string; bytes: Uint8Array | null; mode?: "100755" | "120000" }[];
}

export interface SideRun extends SideResult {
  /** Regenerated lockfile content (after side only). */
  lockfile?: string;
  lockfileRun?: { exitCode: number; ms: number; output: string };
}

export interface VerifyRun {
  backend: string;
  baseline: SideRun;
  after: SideRun;
  evidence: Evidence;
  ms: number;
}

const tail = (text: string) =>
  text.length > VERIFY.outputTailChars ? text.slice(-VERIFY.outputTailChars) : text;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Install side of a run: write the change, regenerate the lockfile, install, switch the network off. */
export async function prepareSide(
  session: VerifySession,
  plan: CheckPlan,
  side: "baseline" | "after",
  change?: Change,
  onLog?: (line: string) => void,
): Promise<SideRun> {
  const result: SideRun = {
    side,
    install: { ok: false, exitCode: -1, ms: 0, output: "" },
    checks: [],
    deniedHosts: [],
  };
  if (change) {
    for (const [path, content] of Object.entries(change.files))
      await session.writeFile(`${VERIFY.workDir}/${path}`, encoder.encode(content));
    let n = 0;
    for (const w of change.writes ?? []) {
      const target = `${VERIFY.workDir}/${w.path}`;
      const argv =
        w.bytes === null
          ? ["rm", "-f", target]
          : w.mode === "120000"
            ? ["ln", "-sfn", decoder.decode(w.bytes), target]
            : null;
      if (argv) await session.run(`${side}-write-${++n}`, argv, { timeoutSec: 60 });
      else if (w.bytes) {
        await session.writeFile(target, w.bytes);
        if (w.mode === "100755")
          await session.run(`${side}-write-${++n}`, ["chmod", "+x", target], { timeoutSec: 60 });
      }
    }
    if (change.lockfile) {
      const run = await session.run(`${side}-lockfile`, change.lockfile, {
        cwd: plan.cwd,
        timeoutSec: plan.installTimeoutSec ?? VERIFY.installTimeoutSec,
      });
      result.lockfileRun = {
        exitCode: run.exitCode ?? -1,
        ms: run.ms,
        output: tail(run.stdout + run.stderr),
      };
      onLog?.(`${side}: lockfile regeneration exit ${run.exitCode} in ${run.ms} ms`);
      if (run.exitCode !== 0) {
        result.install = {
          ok: false,
          exitCode: run.exitCode ?? -1,
          ms: run.ms,
          output: result.lockfileRun.output,
        };
        return result;
      }
      if (change.lockfilePath) {
        const bytes = await session.readFile(`${VERIFY.workDir}/${change.lockfilePath}`);
        if (bytes) result.lockfile = decoder.decode(bytes);
      }
    }
  }
  const install = await session.run(`${side}-install`, plan.install, {
    cwd: plan.cwd,
    ...(plan.installEnv ? { env: plan.installEnv } : {}),
    timeoutSec: plan.installTimeoutSec ?? VERIFY.installTimeoutSec,
  });
  result.install = {
    ok: install.exitCode === 0,
    exitCode: install.exitCode ?? -1,
    ms: install.ms,
    output: tail(install.stdout + install.stderr),
  };
  onLog?.(`${side}: install exit ${install.exitCode} in ${install.ms} ms`);
  if (result.install.ok) await session.setPhase("check");
  return result;
}

let checkRound = 0;

/**
 * The offline checks, after writing `files` (repo-relative → content). Run as often as a fix
 * needs: the install is done once, each round only rewrites the edited files.
 */
export async function runChecks(
  session: VerifySession,
  plan: CheckPlan,
  side: "baseline" | "after",
  files: Record<string, string> = {},
  onLog?: (line: string) => void,
): Promise<{ checks: CheckResult[]; deniedHosts: string[] }> {
  for (const [path, content] of Object.entries(files))
    await session.writeFile(`${VERIFY.workDir}/${path}`, encoder.encode(content));
  const round = ++checkRound;
  const checks: CheckResult[] = [];
  for (const check of plan.checks) {
    const run = await session.run(`${side}-${check.name}-${round}`, check.argv, {
      cwd: plan.cwd,
      env: plan.env,
      timeoutSec: VERIFY.checkTimeoutSec,
    });
    // stderr first: compilers write warnings there and runners (cargo, pytest, go, Maven) write
    // results to stdout, so the kept tail shows the results, not the build noise.
    const raw = run.stderr + run.stdout;
    // Go reports tests as JSON events: counted from those, shown as the plain text they carry.
    const output = goJsonToText(raw);
    let counts = null;
    if (check.name === "test") {
      const report = check.reportPath ? await session.readFile(check.reportPath) : null;
      const text = report ? decoder.decode(report) : null;
      const fromReport = text
        ? check.reportFormat === "junit"
          ? countsFromJunit(text)
          : countsFromJson(text)
        : null;
      counts = fromReport ?? countsFromOutput(raw);
    }
    // `timeout` exits 124; 137 is a kill, a timeout only when it came at the limit (else memory).
    const timedOut =
      run.exitCode === 124 || (run.exitCode === 137 && run.ms >= VERIFY.checkTimeoutSec * 1000);
    const result: CheckResult = {
      name: check.name,
      argv: check.argv,
      exitCode: run.exitCode ?? -1,
      ms: run.ms,
      timedOut,
      counts,
      typeErrors: typeErrorCount(output),
      output: tail(output),
    };
    checks.push(result);
    onLog?.(
      `${side}: ${check.name} exit ${run.exitCode} in ${run.ms} ms${counts ? ` (${counts.passed}/${counts.collected} passed)` : ""}${result.typeErrors ? ` (${result.typeErrors} TS errors)` : ""}`,
    );
  }
  const egress = await session.egress().catch(() => []);
  return { checks, deniedHosts: [...new Set(egress.filter((e) => e.phase === "check").map((e) => e.host))] };
}

export async function runSide(
  session: VerifySession,
  plan: CheckPlan,
  side: "baseline" | "after",
  change?: Change,
  onLog?: (line: string) => void,
): Promise<SideRun> {
  const result = await prepareSide(session, plan, side, change, onLog);
  if (!result.install.ok) return result;
  const { checks, deniedHosts } = await runChecks(session, plan, side, {}, onLog);
  return { ...result, checks, deniedHosts };
}

export async function verifyChange(input: {
  backend: VerifyBackend;
  runId: string;
  tarball: { url: string; token?: string };
  plan: CheckPlan;
  change: Change;
  onLog?: (line: string) => void;
}): Promise<VerifyRun> {
  const started = Date.now();
  // The project's own image and size: a JVM or Rust project can't build in the default Node image.
  const open = (suffix: string) =>
    input.backend.open(`${input.runId}-${suffix}`, {
      tarball: input.tarball,
      image: input.plan.image,
      ...(input.plan.instance ? { instance: input.plan.instance } : {}),
    });
  const [base, after] = await Promise.all([open("base"), open("after")]);
  try {
    const [baseline, afterRun] = await Promise.all([
      runSide(base, input.plan, "baseline", undefined, input.onLog),
      runSide(after, input.plan, "after", input.change, input.onLog),
    ]);
    return {
      backend: input.backend.name,
      baseline,
      after: afterRun,
      evidence: decideEvidence(baseline, afterRun),
      ms: Date.now() - started,
    };
  } finally {
    await Promise.all([base.close(), after.close()]);
  }
}
