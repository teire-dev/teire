import { createHash } from "node:crypto";
import { and, eq, gt, resolverResults, sql } from "@teire/db";
import type { Ecosystem } from "@teire/engine/contract";
import {
  buildJob,
  type JobInput,
  type ResolverResult,
  resolve,
  resolverConfigFromEnv,
} from "@teire/engine/resolver";
import type { WorkerContext } from "./jobs/scan";
import { appendEvent, recordSandboxExec } from "./store";

/**
 * dependabot-core's updater through the resolver service (plan S14.3), for a fix run or a scan:
 * one cached result per job and commit, a "resolver" step on the run's timeline, and the
 * execution on its receipt. Null when the worker has no resolver configured.
 */
const CACHE_HOURS = 24;

export interface ResolvedFor {
  result: ResolverResult;
  tarballSha256: string | null;
  ms: number;
  cached: boolean;
}

export async function resolveForRepo(
  ctx: Pick<WorkerContext, "db" | "gh">,
  repo: { id: number; installationId: number | null; isPrivate?: boolean | null },
  input: JobInput,
  lead: { ecosystem: Ecosystem; name: string },
  runId?: string,
): Promise<ResolvedFor | null> {
  const config = resolverConfigFromEnv();
  if (!config) return null;
  const key = createHash("sha256")
    .update(JSON.stringify([buildJob(input), input.overlay ?? []]))
    .digest("hex");
  const [hit] = await ctx.db
    .select()
    .from(resolverResults)
    .where(
      and(
        eq(resolverResults.key, key),
        gt(resolverResults.createdAt, sql`now() - make_interval(hours => ${CACHE_HOURS})`),
      ),
    )
    .limit(1);
  if (hit) {
    if (runId)
      await appendEvent(ctx.db, runId, "resolver", "cached", { key: key.slice(0, 12), state: hit.state });
    return {
      result: hit.result as ResolverResult,
      tarballSha256: hit.tarballSha256,
      ms: hit.durationMs ?? 0,
      cached: true,
    };
  }
  // A token that reads this one repository (D106): private tarballs, release notes, Go metadata.
  const token = repo.installationId
    ? await (await ctx.gh.installation(repo.installationId)).readToken(repo.id).catch(() => undefined)
    : undefined;
  if (runId)
    await appendEvent(ctx.db, runId, "resolver", "started", {
      packageManager: buildJob(input).job["package-manager"],
      dependency: lead.name,
      roots: input.roots,
    });
  const run = await resolve(
    config,
    {
      ...input,
      ...(token ? { token } : {}),
      onState: (state) => {
        if (runId) void appendEvent(ctx.db, runId, "resolver", state, {}).catch(() => undefined);
      },
    },
    lead,
  );
  // Only results that can't be transient are reused: a stop (a timed-out private source, a timeout)
  // is asked again next time, so `@teire fix` after it gets a fresh answer.
  if (run.result.kind !== "stop")
    await ctx.db
      .insert(resolverResults)
      .values({
        key,
        repoId: repo.id,
        commit: input.commit,
        tarballSha256: run.tarballSha256,
        state: run.state,
        exitCode: run.exitCode,
        durationMs: run.ms,
        result: run.result,
      })
      .onConflictDoUpdate({
        target: resolverResults.key,
        set: {
          tarballSha256: run.tarballSha256,
          state: run.state,
          exitCode: run.exitCode,
          durationMs: run.ms,
          result: run.result,
          createdAt: new Date(),
        },
      });
  if (runId) {
    // On the receipt beside the sandbox runs: what ran, where, for how long (S-P17).
    await recordSandboxExec(ctx.db, {
      runId,
      backend: "resolver (dependabot-core under gVisor)",
      phase: "resolve",
      jobId: run.id,
      command: `dependabot update ${buildJob(input).job["package-manager"]} ${lead.name}`,
      exitCode: run.exitCode,
      timedOut: run.state === "timeout",
      durationMs: run.ms,
      stderrTail: run.stderrTail.slice(-4000),
    });
    await appendEvent(ctx.db, runId, "resolver", run.result.kind, {
      ...(run.result.kind === "change"
        ? {
            files: run.result.files.map((f) => f.path),
            moved: run.result.moved,
            leadVersion: run.result.leadVersion,
          }
        : run.result.kind === "stop"
          ? { type: run.result.type, message: run.result.message }
          : {}),
    });
  }
  return { result: run.result, tarballSha256: run.tarballSha256, ms: run.ms, cached: false };
}
