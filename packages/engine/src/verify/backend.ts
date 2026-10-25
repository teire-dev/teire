import {
  CloudflareSandbox,
  type EgressEvent,
  type InstanceType,
  type JobResult,
  sandboxConfigFromEnv,
} from "./cloudflare";

/**
 * Where checks run (card C5, D41/D49). Cloudflare Containers by default; Token Factory Sandboxes
 * once `GET /v1/whoami` shows the spawn permission for our project; the run names its backend.
 */
export interface VerifySession {
  readonly id: string;
  setPhase(phase: "install" | "check"): Promise<void>;
  run(
    jobId: string,
    argv: string[],
    options: { cwd?: string; env?: Record<string, string>; timeoutSec?: number },
  ): Promise<JobResult>;
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  egress(): Promise<EgressEvent[]>;
  close(): Promise<void>;
}

export interface VerifyBackend {
  readonly name: "cloudflare" | "tokenfactory";
  open(
    id: string,
    options: { tarball: { url: string; token?: string }; instance?: InstanceType; image?: string },
  ): Promise<VerifySession>;
}

export function cloudflareBackend(config = sandboxConfigFromEnv()): VerifyBackend {
  return {
    name: "cloudflare",
    async open(id, options) {
      const sandbox = new CloudflareSandbox(config, id);
      await sandbox.start({
        instance: options.instance ?? "standard-2",
        tarball: options.tarball,
        ...(options.image ? { image: options.image } : {}),
      });
      return {
        id,
        setPhase: async (phase) => {
          await sandbox.setPhase(phase);
        },
        run: (jobId, argv, opts) => sandbox.runJob(jobId, argv, opts),
        readFile: async (path) => {
          try {
            return await sandbox.readFile(path);
          } catch {
            return null;
          }
        },
        writeFile: async (path, content) => {
          await sandbox.writeFile(path, content);
        },
        egress: () => sandbox.egress(),
        close: async () => {
          await sandbox.destroy().catch(() => undefined);
        },
      };
    },
  };
}

/** Token Factory Sandboxes access, read from `whoami` (permissions + limits); never assumed. */
export async function tokenFactorySandboxAccess(env: NodeJS.ProcessEnv = process.env) {
  const key = env.TOKENFACTORY_API_KEY;
  const project = env.NEBIUS_PROJECT_ID;
  if (!key) return { available: false, reason: "TOKENFACTORY_API_KEY is not set" };
  if (!project) return { available: false, reason: "NEBIUS_PROJECT_ID is not set (the console shows it)" };
  try {
    const res = await fetch("https://api.tokenfactory.nebius.com/sandboxes/v1/whoami", {
      headers: { authorization: `Bearer ${key}`, project },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { permissions?: unknown };
    const permissions = JSON.stringify(body.permissions ?? "");
    const spawn = res.ok && /spawn/i.test(permissions) && !/"spawn"\s*:\s*false/.test(permissions);
    return {
      available: spawn,
      reason: spawn ? "whoami grants spawn" : `whoami ${res.status}: no spawn permission`,
    };
  } catch (error) {
    return {
      available: false,
      reason: `whoami failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The backend this run uses, and why. */
export async function selectBackend(env: NodeJS.ProcessEnv = process.env) {
  const access = await tokenFactorySandboxAccess(env);
  // A Token Factory backend is added when access is granted; until then every run says so.
  return {
    backend: cloudflareBackend(sandboxConfigFromEnv(env)),
    note: `Cloudflare Containers (Token Factory Sandboxes: ${access.reason})`,
  };
}
