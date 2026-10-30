import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIX, VERIFY } from "../constants";
import type { VerifySession } from "../verify/backend";
import type { CheckPlan } from "../verify/commands";
import type { RequestUpgrade, Transaction } from "./transaction";

type Moved = NonNullable<Transaction["moved"]>[number];

/**
 * Upgrades the agent asks for (S15.2): moved by dependabot-core's updater on top of this run's
 * dependency files, installed with the network on as the first install was, and put back if that
 * install fails, so the run's environment never stays broken. Two upgrades that land, four asks in
 * all; an ask the updater refuses, or one whose install fails and is put back, doesn't use an
 * upgrade. When the install before it can't be restored either, the environment is lost: every
 * later ask and check is refused and the run ends in a named stop (`lost()`).
 */
export function upgradeRequester(deps: {
  ask: RequestUpgrade;
  after: Pick<VerifySession, "run" | "writeFile" | "setPhase">;
  plan: Pick<CheckPlan, "install" | "cwd" | "installEnv" | "installTimeoutSec">;
  repoDir: string;
  /** The run's dependency files: sent to the updater, and joined by what it writes. */
  transactionFiles: Set<string>;
  binaryPaths: ReadonlySet<string>;
  /** Each file's text before the run touched it; "" for a file the run added. */
  originals: Map<string, string>;
  /** Each dependency file's text as it stands after the run's own writes. */
  landed: Map<string, string>;
  /** What the updater moved before (the run's transaction) and on earlier asks. */
  movedBefore: readonly Moved[];
  /** Where packages moved on asks are listed, with why, for the PR. */
  extraMoved: Moved[];
  remember: (path: string) => void;
  emit: (e: { step: "transaction"; detail: string }) => void;
  clip: (text: string) => string;
}) {
  let requests = 0;
  let granted = 0;
  let lost: string | null = null;
  const read = (path: string) => readFileSync(join(deps.repoDir, path), "utf8");
  const nowText = (p: string) => (existsSync(join(deps.repoDir, p)) ? read(p) : "");
  const { after, plan } = deps;

  const ask = async (name: string, version: string, why: string): Promise<string> => {
    if (lost) return `stopped: ${lost}`;
    if (granted >= FIX.maxUpgradeRequests)
      return `refused: this run already moved ${FIX.maxUpgradeRequests} other dependencies`;
    if (requests >= FIX.maxUpgradeAttempts)
      return `refused: this run already asked the updater ${FIX.maxUpgradeAttempts} times`;
    requests++;
    const current = Object.fromEntries(
      [...deps.transactionFiles]
        .filter((p) => !deps.binaryPaths.has(p) && existsSync(join(deps.repoDir, p)))
        .map((p) => [p, read(p)]),
    );
    deps.emit({ step: "transaction", detail: `the agent asks for ${name} ${version}: ${deps.clip(why)}` });
    const already = [...deps.movedBefore, ...deps.extraMoved].findLast((m) => m.name === name)?.to;
    const answer = await deps.ask({
      name,
      version,
      why,
      files: current,
      ...(already ? { current: already } : {}),
    });
    if (!answer.ok) {
      deps.emit({ step: "transaction", detail: `${name} ${version} not moved: ${answer.reason}` });
      return `refused: ${answer.reason}`;
    }
    const previous = new Map(
      answer.files.map((f) => [f.path, existsSync(join(deps.repoDir, f.path)) ? read(f.path) : null]),
    );
    const added = new Set<string>();
    let n = 0;
    const put = async (path: string, content: string | null) => {
      const full = join(deps.repoDir, path);
      if (content === null) {
        rmSync(full, { force: true });
        await after.run(`after-request-${requests}-${++n}`, ["rm", "-f", `${VERIFY.workDir}/${path}`], {
          timeoutSec: 60,
        });
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
        await after.writeFile(`${VERIFY.workDir}/${path}`, new TextEncoder().encode(content));
      }
    };
    const install = async (label: string) => {
      await after.setPhase("install");
      const run = await after.run(label, plan.install, {
        cwd: plan.cwd,
        ...(plan.installEnv ? { env: plan.installEnv } : {}),
        timeoutSec: plan.installTimeoutSec ?? VERIFY.installTimeoutSec,
      });
      await after.setPhase("check");
      return run;
    };
    for (const f of answer.files) {
      if (!deps.originals.has(f.path)) {
        if (previous.get(f.path) !== null) deps.remember(f.path);
        else {
          deps.originals.set(f.path, "");
          added.add(f.path);
        }
      }
      await put(f.path, f.content);
      deps.transactionFiles.add(f.path);
      deps.landed.set(f.path, nowText(f.path));
    }
    const run = await install(`after-install-request-${requests}`);
    if (run.exitCode !== 0) {
      for (const [path, content] of previous) {
        await put(path, content);
        deps.landed.set(path, nowText(path));
        if (added.has(path)) {
          deps.originals.delete(path);
          deps.transactionFiles.delete(path);
        }
      }
      const undo = await install(`after-install-request-${requests}-undo`);
      const said = (run.stderr + run.stdout).slice(-FIX.maxCheckOutputChars);
      // The files are back but the install isn't: every later check would read a broken tree.
      if (undo.exitCode !== 0) {
        lost = `${name} ${answer.to} failed to install and the install before it couldn't be restored (exit ${undo.exitCode})`;
        deps.emit({ step: "transaction", detail: lost });
        return `stopped: ${lost}. Call finish; the run ends here.`;
      }
      deps.emit({
        step: "transaction",
        detail: `${name} ${answer.to}: the install failed (exit ${run.exitCode}), so it was put back`,
      });
      return `the install failed with ${name} ${answer.to}, so it was put back:\n${said}`;
    }
    granted++;
    deps.extraMoved.push(...answer.moved.map((m) => ({ ...m, requested: why })));
    const also = answer.moved.filter((m) => m.name !== name);
    deps.emit({
      step: "transaction",
      detail: `${name} → ${answer.to} by dependabot-core's updater, asked for by the agent${also.length ? `, with ${also.map((m) => m.name).join(", ")}` : ""}; installed in ${run.ms} ms`,
    });
    return `${name} is now ${answer.to}${also.length ? ` (it also moved ${also.map((m) => `${m.name} ${m.from ?? "new"} → ${m.to ?? "removed"}`).join(", ")})` : ""}, installed. Call run_check.`;
  };

  return { ask, lost: () => lost };
}
