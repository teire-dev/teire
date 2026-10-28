import { SCAN, VERIFY } from "../constants";
import {
  CloudflareSandbox,
  type EgressEvent,
  type InstanceType,
  type JobResult,
  sandboxConfigFromEnv,
} from "./cloudflare";
import { tokenFactoryBackend, tokenFactorySandboxConfigFromEnv } from "./tokenfactory";

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
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutSec?: number;
      /** The command's output as it is written, where the backend streams it. */
      onLog?: (chunk: string) => void;
    },
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

/**
 * A repository tarball, fetched by the worker (no code runs here) and streamed to the sandbox's
 * upload without being held in memory (review R17). GitHub sends no length, so the bytes are
 * counted on the way and the upload fails past `SCAN.maxTarballBytes`.
 */
async function fetchTarball(url: string, token?: string): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(url, {
    headers: { "user-agent": "teire", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    redirect: "follow",
    signal: AbortSignal.timeout(VERIFY.uploadTimeoutMs),
  });
  if (!response.ok || !response.body) throw new Error(`tarball ${response.status}`);
  return response.body.pipeThrough(byteCap(SCAN.maxTarballBytes));
}

/** Passes bytes through until `max`, then fails the stream with the reason. */
export function byteCap(max: number) {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max)
        controller.error(
          new Error(
            `the repository's tarball is over ${Math.round(max / 1024 / 1024)} MB, the most Teire sends to a sandbox`,
          ),
        );
      else controller.enqueue(chunk);
    },
  });
}

/**
 * The backend this run uses, and why (D107): Token Factory Sandboxes for public repositories and
 * dry runs, since its saved images keep code for 180 days with no delete; Cloudflare Containers for
 * private repositories, and whenever Token Factory access isn't granted.
 */
export async function selectBackend(
  env: NodeJS.ProcessEnv = process.env,
  repo?: { isPrivate: boolean | null },
) {
  const tf = tokenFactorySandboxConfigFromEnv(env);
  const images = env.TEIRE_SANDBOX_IMAGES;
  if (repo && repo.isPrivate === false && tf && images) {
    const access = await tokenFactorySandboxAccess(env);
    if (access.available)
      return {
        backend: tokenFactoryBackend(tf, { dir: images }, fetchTarball),
        note: "Token Factory Sandboxes (a public repository)",
      };
    return {
      backend: cloudflareBackend(sandboxConfigFromEnv(env)),
      note: `Cloudflare Containers (Token Factory Sandboxes: ${access.reason})`,
    };
  }
  return {
    backend: cloudflareBackend(sandboxConfigFromEnv(env)),
    note: repo?.isPrivate
      ? "Cloudflare Containers (a private repository)"
      : `Cloudflare Containers (Token Factory Sandboxes: ${!tf ? "not configured" : !images ? "no image recipes" : "not chosen"})`,
  };
}
