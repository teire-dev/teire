import { createHmac } from "node:crypto";
import { SANDBOX } from "../constants";

/**
 * Client for Teire's sandbox service on Cloudflare Containers (`apps/sandbox`). Every request
 * carries a token signed for this one sandbox id, so a leaked token reaches nothing else.
 */
export interface SandboxServiceConfig {
  baseUrl: string;
  key: string;
}

export type SandboxPhase = "install" | "check";
export type InstanceType = "standard-1" | "standard-2" | "standard-3" | "standard-4";

export interface StartOptions {
  image?: string;
  instance?: InstanceType;
  tarball?: { url: string; token?: string };
  snapshotId?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface JobStatus {
  state: "missing" | "starting" | "running" | "exited" | "lost";
  exitCode?: number;
  pid?: number;
}

export interface JobResult extends JobStatus {
  stdout: string;
  stderr: string;
  ms: number;
}

export interface EgressEvent {
  at: number;
  phase: SandboxPhase;
  method: string;
  host: string;
  path: string;
}

export function sandboxConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxServiceConfig {
  const baseUrl = env.TEIRE_SANDBOX_URL;
  const key = env.TEIRE_SANDBOX_KEY;
  if (!baseUrl || !key) throw new Error("TEIRE_SANDBOX_URL and TEIRE_SANDBOX_KEY must be set");
  return { baseUrl: baseUrl.replace(/\/$/, ""), key };
}

/** `<expiry>.<base64url HMAC-SHA256(key, "<sid>.<expiry>")>`, the format the Worker verifies. */
export function signSandboxToken(key: string, sid: string, ttlSeconds: number = SANDBOX.tokenTtlSeconds) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = createHmac("sha256", key).update(`${sid}.${expiry}`).digest("base64url");
  return `${expiry}.${signature}`;
}

export class CloudflareSandbox {
  readonly #config: SandboxServiceConfig;
  readonly sid: string;

  constructor(config: SandboxServiceConfig, sid: string) {
    this.#config = config;
    this.sid = sid;
  }

  async #request(method: string, path: string, body?: unknown, raw = false): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${signSandboxToken(this.#config.key, this.sid)}`,
    };
    let payload: string | Uint8Array | undefined;
    if (body instanceof Uint8Array) {
      payload = body;
      headers["content-type"] = "application/octet-stream";
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const response = await fetch(`${this.#config.baseUrl}/v1/sandboxes/${this.sid}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(SANDBOX.requestTimeoutMs),
    });
    if (!raw && !response.ok) {
      throw new Error(
        `sandbox ${method} ${path || "/"} → ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    return response;
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.#request(method, path, body)).json() as Promise<T>;
  }

  start(options: StartOptions) {
    return this.#json<{ sid: string; instance: string; startMs: number; fetchMs: number }>(
      "POST",
      "",
      options,
    );
  }

  setPhase(phase: SandboxPhase) {
    return this.#json<{ phase: SandboxPhase }>("PUT", "/phase", { phase });
  }

  exec(argv: string[], options: { cwd?: string; env?: Record<string, string>; timeoutSec?: number } = {}) {
    return this.#json<ExecResult>("POST", "/exec", { argv, ...options });
  }

  startJob(
    jobId: string,
    argv: string[],
    options: { cwd?: string; env?: Record<string, string>; timeoutSec?: number } = {},
  ) {
    return this.#json<JobStatus>("POST", "/jobs", { jobId, argv, ...options });
  }

  jobStatus(jobId: string) {
    return this.#json<JobStatus>("GET", `/jobs/${jobId}`);
  }

  /** Bytes from `offset`; `nextOffset` is where the next read starts. */
  async jobLog(jobId: string, stream: "stdout" | "stderr", offset: number) {
    const response = await this.#request(
      "GET",
      `/jobs/${jobId}/log?stream=${stream}&offset=${offset}`,
      undefined,
      true,
    );
    if (response.status === 404) return { text: "", nextOffset: offset };
    if (!response.ok) throw new Error(`sandbox log → ${response.status}`);
    const text = await response.text();
    return { text, nextOffset: Number(response.headers.get("x-next-offset") ?? offset) };
  }

  /** Starts a job and polls it to the end, collecting both logs by offset. */
  async runJob(
    jobId: string,
    argv: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutSec?: number;
      onLog?: (chunk: string) => void;
    } = {},
  ): Promise<JobResult> {
    const started = Date.now();
    await this.startJob(jobId, argv, options);
    let stdout = "";
    let stderr = "";
    let outOffset = 0;
    let errOffset = 0;
    for (;;) {
      const status = await this.jobStatus(jobId);
      for (;;) {
        const out = await this.jobLog(jobId, "stdout", outOffset);
        if (!out.text) break;
        stdout += out.text;
        outOffset = out.nextOffset;
        options.onLog?.(out.text);
      }
      for (;;) {
        const err = await this.jobLog(jobId, "stderr", errOffset);
        if (!err.text) break;
        stderr += err.text;
        errOffset = err.nextOffset;
      }
      if (status.state === "exited" || status.state === "lost" || status.state === "missing") {
        return { ...status, stdout, stderr, ms: Date.now() - started };
      }
      await new Promise((resolve) => setTimeout(resolve, SANDBOX.pollIntervalMs));
    }
  }

  async readFile(path: string) {
    const response = await this.#request("GET", `/files?path=${encodeURIComponent(path)}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  writeFile(path: string, content: Uint8Array) {
    return this.#json<{ path: string; bytes: number }>(
      "PUT",
      `/files?path=${encodeURIComponent(path)}`,
      content,
    );
  }

  snapshot(name: string) {
    return this.#json<{ id: string; size: number; name?: string; ms: number }>("POST", "/snapshot", { name });
  }

  egress() {
    return this.#json<EgressEvent[]>("GET", "/egress");
  }

  destroy() {
    return this.#json<{ destroyed: boolean }>("DELETE", "");
  }
}
