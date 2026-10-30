import type { VerifyBackend } from "./backend";
import type { CheckPlan } from "./commands";

/**
 * A repository probed in the sandbox at scan time (S19): its dependencies installed with the
 * network, then one command with the network off whose output file is read back. The probe runs
 * the repository's own build: rust-analyzer runs build scripts and proc-macros, a JVM build
 * compiles, so it runs in the sandbox, never on the worker.
 */
export async function scanProbe(
  backend: VerifyBackend,
  input: {
    id: string;
    tarball: { url: string; token?: string };
    plan: Pick<CheckPlan, "image" | "instance" | "cwd" | "install" | "installEnv" | "env">;
    probe: string[];
    /** The file the probe writes, read back when it succeeds. */
    output: string;
    timeoutSec: number;
  },
): Promise<{ bytes: Uint8Array; ms: number } | { error: string }> {
  const started = Date.now();
  const session = await backend.open(input.id, {
    tarball: input.tarball,
    image: input.plan.image,
    ...(input.plan.instance ? { instance: input.plan.instance } : {}),
  });
  const tail = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().slice(-400);
  try {
    if (input.plan.install) {
      const installed = await session.run(`${input.id}-install`, input.plan.install, {
        cwd: input.plan.cwd,
        ...(input.plan.installEnv ? { env: input.plan.installEnv } : {}),
        timeoutSec: input.timeoutSec,
      });
      if (installed.exitCode !== 0)
        return { error: `install exit ${installed.exitCode}: ${tail(installed)}` };
    }
    await session.setPhase("check");
    const probed = await session.run(`${input.id}-probe`, input.probe, {
      cwd: input.plan.cwd,
      ...(input.plan.env ? { env: input.plan.env } : {}),
      timeoutSec: input.timeoutSec,
    });
    if (probed.exitCode !== 0) return { error: `probe exit ${probed.exitCode}: ${tail(probed)}` };
    const bytes = await session.readFile(input.output);
    if (!bytes?.length) return { error: `the probe wrote no ${input.output}` };
    return { bytes, ms: Date.now() - started };
  } finally {
    await session.close();
  }
}
