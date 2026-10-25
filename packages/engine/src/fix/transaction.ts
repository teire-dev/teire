import { VERIFY } from "../constants";
import type { VerifySession } from "../verify/backend";
import type { CheckPlan } from "../verify/commands";
import { prepareSide, type SideRun } from "../verify/run";
import type { ManifestEdit } from "./upgrade-js";

/**
 * The upgrade transaction for any ecosystem (card C4 steps 2–3): manifest edits Teire writes as
 * text, then the repo's own tool regenerating the lock in the after sandbox (install phase), then
 * the files read back. Some tools rewrite the manifest themselves (Poetry, Pipenv), so every file
 * a tool may touch is read back, not only the lock. `check` confirms the change landed (a
 * transitive fix really locked); `fallback` is the next way to try (an override).
 */
export interface Transaction {
  describe: string;
  manifest: ManifestEdit[];
  commands: string[][];
  readBack: string[];
  lockfilePath?: string;
  check?: (files: Record<string, string>) => string | null;
  fallback?: Transaction;
}

export interface PreparedTransaction {
  side: SideRun;
  /** Read-back contents (path → text) of the transaction that landed. */
  files: Record<string, string>;
  /** The transactions applied, the first one and any fallback that took over. */
  applied: Transaction[];
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export async function prepareTransaction(
  session: VerifySession,
  plan: CheckPlan,
  transaction: Transaction,
  log: (line: string) => void,
  /** Called before a transaction's manifest edits are written, so the worker copy keeps the same. */
  onManifest: (edits: ManifestEdit[]) => void,
): Promise<PreparedTransaction> {
  const applied: Transaction[] = [];
  const failed = (output: string): PreparedTransaction => ({
    side: { side: "after", install: { ok: false, exitCode: 1, ms: 0, output }, checks: [], deniedHosts: [] },
    files: {},
    applied,
  });
  let current: Transaction | undefined = transaction;
  let files: Record<string, string> = {};
  let step = 0;
  attempt: while (current) {
    const t: Transaction = current;
    applied.push(t);
    onManifest(t.manifest);
    for (const edit of t.manifest)
      await session.writeFile(`${VERIFY.workDir}/${edit.path}`, encoder.encode(edit.after));
    for (const argv of t.commands) {
      const run = await session.run(`after-lock-${++step}`, argv, {
        cwd: plan.cwd,
        timeoutSec: VERIFY.installTimeoutSec,
        // The same settings as the install (Go: GOTOOLCHAIN=local, so `go get` never fetches a toolchain).
        ...(plan.installEnv ? { env: plan.installEnv } : {}),
      });
      log(`after: ${argv.slice(0, 3).join(" ")} exit ${run.exitCode} in ${run.ms} ms`);
      if (run.exitCode !== 0) {
        if (t.fallback) {
          current = t.fallback;
          continue attempt;
        }
        return failed(`${argv.join(" ")} failed: ${(run.stdout + run.stderr).slice(-2000)}`);
      }
    }
    files = {};
    for (const path of t.readBack) {
      const bytes = await session.readFile(`${VERIFY.workDir}/${path}`);
      if (bytes) files[path] = decoder.decode(bytes);
    }
    const problem = t.check?.(files) ?? null;
    if (problem) {
      if (t.fallback) {
        current = t.fallback;
        continue;
      }
      return failed(problem);
    }
    break;
  }
  const side = await prepareSide(session, plan, "after", undefined, log);
  return { side, files, applied };
}
