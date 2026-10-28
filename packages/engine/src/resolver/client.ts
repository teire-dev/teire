import type { Ecosystem } from "../contract";
import { parseEvents, type ResolverEvent, type ResolverResult, resultOf } from "./events";
import { buildJob, type JobInput } from "./job";

/**
 * The worker's side of the resolver service (`apps/resolver/host/teire-resolver.py`, plan S14.3):
 * submit a job for the commit Teire scanned, wait for it, read its events. The service runs one job
 * at a time, so a job may wait in its queue before it starts.
 */
export interface ResolverConfig {
  url: string;
  secret: string;
}

export function resolverConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ResolverConfig | null {
  return env.TEIRE_RESOLVER_URL && env.TEIRE_RESOLVER_SECRET
    ? { url: env.TEIRE_RESOLVER_URL.replace(/\/+$/, ""), secret: env.TEIRE_RESOLVER_SECRET }
    : null;
}

export interface ResolverRun {
  id: string;
  state: "done" | "failed" | "timeout";
  exitCode: number | null;
  ms: number;
  /** The sha256 of the tarball the job ran on (D102). */
  tarballSha256: string | null;
  events: ResolverEvent[];
  result: ResolverResult;
  stderrTail: string;
  error: string | null;
}

export class ResolverUnavailableError extends Error {}

const POLL_MS = 5_000;
/** Queue wait plus the CLI's 20 minutes and the service's grace period. */
const MAX_WAIT_MS = 60 * 60_000;

async function call<T>(config: ResolverConfig, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.secret}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => {
    throw new ResolverUnavailableError(`resolver unreachable: ${(error as Error).message}`);
  });
  const value = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok)
    throw new ResolverUnavailableError(
      `resolver ${method} ${path} → ${response.status}: ${value.error ?? ""}`,
    );
  return value;
}

export async function resolve(
  config: ResolverConfig,
  input: JobInput & {
    /** A token for this one repository with contents:read (D106), or none for a public repository. */
    token?: string;
    timeoutSec?: number;
    onState?: (state: string) => void;
  },
  lead: { ecosystem: Ecosystem; name: string },
): Promise<ResolverRun> {
  const { id } = await call<{ id: string }>(config, "POST", "/jobs", {
    repo: input.repo,
    commit: input.commit,
    job: buildJob(input),
    ...(input.overlay?.length ? { overlay: input.overlay } : {}),
    ...(input.token ? { token: input.token } : {}),
    ...(input.timeoutSec ? { timeoutSec: input.timeoutSec } : {}),
  });
  const deadline = Date.now() + MAX_WAIT_MS;
  let last = "";
  for (;;) {
    const job = await call<{
      state: string;
      exitCode?: number | null;
      ms?: number;
      tarballSha256?: string;
      events?: string;
      stderrTail?: string;
      error?: string;
    }>(config, "GET", `/jobs/${id}`);
    if (job.state !== last) {
      last = job.state;
      input.onState?.(last);
    }
    // The host failing (download, images, cleanup) is an outage the worker retries, never a result.
    if (job.state === "failed")
      throw new ResolverUnavailableError(
        `resolver job ${id} failed on the host: ${job.error ?? "no reason given"}`,
      );
    if (job.state === "done" || job.state === "timeout") {
      const events = parseEvents(job.events ?? "");
      // The CLI exits 1 on any error event (D101); exiting non-zero with no event at all is a crash,
      // not "nothing to change".
      if (job.state === "done" && job.exitCode !== 0 && !events.length)
        throw new ResolverUnavailableError(
          `the updater exited ${job.exitCode} without reporting anything: ${(job.stderrTail ?? "").slice(-300)}`,
        );
      return {
        id,
        state: job.state,
        exitCode: job.exitCode ?? null,
        ms: job.ms ?? 0,
        tarballSha256: job.tarballSha256 ?? null,
        events,
        result:
          job.state === "done"
            ? resultOf(events, lead)
            : {
                kind: "stop",
                type: "timeout",
                message: job.error ?? "the updater ran past its 20-minute limit",
                warnings: [],
              },
        stderrTail: job.stderrTail ?? "",
        error: job.error ?? null,
      };
    }
    if (Date.now() > deadline)
      throw new ResolverUnavailableError(`resolver job ${id} still ${job.state} after an hour`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
