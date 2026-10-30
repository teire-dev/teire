/**
 * Teire's verification sandbox on Cloudflare Containers (plan D60, S02a).
 *
 * One Durable Object per sandbox drives one microVM through `this.ctx.container`. Customer code
 * runs only here. The container has no internet of its own (`enableInternet: false`); every
 * request leaves through the `Egress` entrypoint, which lets the install phase read package
 * registries and denies (and records) everything in the check phase. Secrets never enter the
 * container: the repo tarball's token is added by `Egress`, outside the VM.
 *
 * The Node worker calls the HTTPS routes below with a per-sandbox signed token.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DirectoryBackup, type DirectoryBackupRecord, Files } from "@cloudflare/sandbox";
import {
  ALARM_MS,
  BASE_ENV,
  CHECK_HOME,
  CHECK_USER,
  IDLE_MS,
  INTERCEPT_CA,
  type InstanceType,
  JOB_ID,
  JOBS_DIR,
  MAX_EXEC_OUTPUT_BYTES,
  MAX_EXEC_SECONDS,
  MAX_JOB_SECONDS,
  MAX_LOG_CHUNK_BYTES,
  MAX_TOKEN_TTL_SECONDS,
  type Phase,
  REGISTRY_HOSTS,
  SANDBOX_ID,
  START_WAIT_MS,
  WORK_DIR,
} from "./policy";

export { DirectoryBackupGateway } from "@cloudflare/sandbox";

interface Env extends Cloudflare.Env {
  /** HMAC key shared with the Node worker; signs `<sandbox id>.<expiry>`. */
  TEIRE_SANDBOX_KEY: string;
}

interface EgressProps {
  sid: string;
  phase: Phase;
  /** Exact URL of the repo tarball and the token to fetch it; only present while starting. */
  tarball?: { url: string; token?: string };
}

export interface EgressEvent {
  at: number;
  phase: Phase;
  method: string;
  host: string;
  path: string;
}

/** Every outbound request from the container arrives here. */
export class Egress extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    const { sid, phase, tarball } = this.ctx.props;
    const url = new URL(request.url);
    const read = request.method === "GET" || request.method === "HEAD";

    if (tarball && read && request.url === tarball.url) {
      // GitHub answers with a redirect to a signed codeload URL; follow it here so the token and
      // the signed URL stay outside the sandbox.
      const headers = new Headers({ "user-agent": "teire-sandbox" });
      if (tarball.token) headers.set("authorization", `Bearer ${tarball.token}`);
      return fetch(request.url, { headers, redirect: "follow" });
    }

    if (phase === "install" && read && url.protocol === "https:" && REGISTRY_HOSTS.has(url.hostname)) {
      return fetch(request);
    }

    const event: EgressEvent = {
      at: Date.now(),
      phase,
      method: request.method,
      host: url.hostname,
      path: url.pathname.slice(0, 200),
    };
    this.ctx.waitUntil(sandboxStub(this.env, sid).recordEgress(event));
    return new Response("teire-sandbox: egress denied\n", {
      status: 403,
      headers: { "x-teire-egress": "denied" },
    });
  }
}

export interface StartOptions {
  image?: string;
  instance?: InstanceType;
  /** Repo tarball fetched into /work during start (skipped when starting from a snapshot). */
  tarball?: { url: string; token?: string };
  snapshotId?: string;
}

export interface JobStatus {
  state: "missing" | "starting" | "running" | "exited" | "lost";
  exitCode?: number;
  pid?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
}

const decoder = new TextDecoder();

export class VerifySandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;
  readonly #backups: DirectoryBackup;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw new Error("No container is configured for VerifySandbox");
    this.#container = ctx.container;
    this.#files = new Files(this.#container);
    this.#backups = new DirectoryBackup(this.#container, ctx.exports.DirectoryBackupGateway, {
      binding: "DEP_CACHE",
      prefix: "deps/",
    });
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS egress (at INTEGER, phase TEXT, method TEXT, host TEXT, path TEXT)",
    );
    // A restarted Durable Object forgets the inactivity timeout it set; set it again.
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() => this.#container.setInactivityTimeout(IDLE_MS));
    }
  }

  async start(sid: string, options: StartOptions) {
    if (this.#container.running) {
      // The client's retry of a slow start for the same run: wait for the first start to finish and
      // answer as it would have. Another run's sandbox is a conflict.
      if ((await this.ctx.storage.get<string>("sid")) !== sid)
        throw new Error("conflict: sandbox already running");
      const deadline = Date.now() + START_WAIT_MS;
      while (Date.now() < deadline) {
        const done = await this.ctx.storage.get<{ instance: string; fetchMs: number }>("started");
        if (done) return { sid, instance: done.instance, startMs: 0, fetchMs: done.fetchMs, reused: true };
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error("conflict: sandbox still starting");
    }
    await this.ctx.storage.delete("started");
    const started = Date.now();
    const instance = options.instance ?? "standard-2";
    const labels = { sid };
    if (options.snapshotId) {
      this.#container.start({
        containerSnapshot: { id: options.snapshotId },
        enableInternet: false,
        instance,
        labels,
      });
    } else {
      const image = this.#container.images[options.image ?? "node"];
      if (!image) throw new Error(`unknown image: ${options.image}`);
      this.#container.start({ image, enableInternet: false, instance, labels });
    }
    await this.#container.setInactivityTimeout(IDLE_MS);
    await this.ctx.storage.put("sid", sid);

    // Backup traffic must be routed before the catch-all intercept (DirectoryBackup docs).
    await this.#backups.intercept();
    await this.#routeEgress(sid, "install", options.snapshotId ? undefined : options.tarball);
    const trust = await this.#trustInterceptCa();
    if (trust.exitCode !== 0) throw new Error(`could not trust the intercept CA: ${trust.stderr}`);

    let fetchMs = 0;
    if (!options.snapshotId && options.tarball) {
      const fetched = await this.#run(
        [
          "bash",
          "-c",
          'mkdir -p "$1" && curl -fsSL "$0" | tar -xz --strip-components=1 -C "$1"',
          options.tarball.url,
          WORK_DIR,
        ],
        { timeoutSec: 300 },
      );
      if (fetched.exitCode !== 0) throw new Error(`tarball fetch failed: ${fetched.stderr.slice(0, 500)}`);
      fetchMs = fetched.ms;
      // Drop the tarball grant: from here the token is gone from every handler.
      await this.#routeEgress(sid, "install");
    }
    await this.ctx.storage.put("started", { instance, fetchMs });
    return { sid, instance, startMs: Date.now() - started, fetchMs };
  }

  /** Switches between the install (registries only) and check (nothing) phases without a restart. */
  async setPhase(phase: Phase) {
    const sid = await this.#sid();
    // The checks run as the unprivileged user: hand it the checkout and the caches the install filled.
    if (phase === "check")
      await this.#run(["chown", "-R", `${CHECK_USER}:${CHECK_USER}`, WORK_DIR, CHECK_HOME], {});
    await this.#routeEgress(sid, phase);
    await this.ctx.storage.put("phase", phase);
    return { phase };
  }

  async startJob(
    jobId: string,
    argv: string[],
    options: { cwd?: string; env?: Record<string, string>; timeoutSec?: number },
  ) {
    if (!JOB_ID.test(jobId)) throw new Error("bad request: invalid job id");
    if (argv.length === 0) throw new Error("bad request: empty argv");
    const dir = `${JOBS_DIR}/${jobId}`;
    const made = await this.#run(["mkdir", "-p", JOBS_DIR], {}).then(() => this.#run(["mkdir", dir], {}));
    if (made.exitCode !== 0) throw new Error("conflict: job id already used");
    const timeoutSec = Math.min(options.timeoutSec ?? 600, MAX_JOB_SECONDS);
    // Check-phase commands run unprivileged, as CI runs them; the install phase stays root (it
    // installs toolchains and starts services).
    const check = (await this.ctx.storage.get<Phase>("phase")) === "check";
    const run = check
      ? ["setpriv", `--reuid=${CHECK_USER}`, `--regid=${CHECK_USER}`, "--init-groups", "--", ...argv]
      : argv;
    // Output ignored on purpose: the job outlives this request and writes its own log files.
    await this.#container.exec(
      ["teire-job", dir, String(timeoutSec), options.cwd ?? WORK_DIR, "--", ...run],
      {
        env: {
          ...BASE_ENV,
          ...(check ? { USER: CHECK_USER, LOGNAME: CHECK_USER } : {}),
          ...options.env,
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    let status = await this.jobStatus(jobId);
    for (let i = 0; i < 50 && status.state === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await this.jobStatus(jobId);
    }
    await this.ctx.storage.put(`job:${jobId}`, { startedAt: Date.now(), timeoutSec });
    await this.#ensureAlarm();
    return status;
  }

  async jobStatus(jobId: string): Promise<JobStatus> {
    if (!JOB_ID.test(jobId)) throw new Error("bad request: invalid job id");
    const out = await this.#run(["teire-job-status", `${JOBS_DIR}/${jobId}`], {});
    return JSON.parse(out.stdout.trim() || '{"state":"missing"}') as JobStatus;
  }

  /** Bytes of a job's log from `offset`, at most MAX_LOG_CHUNK_BYTES. */
  async jobLog(jobId: string, stream: "stdout" | "stderr", offset: number) {
    if (!JOB_ID.test(jobId)) throw new Error("bad request: invalid job id");
    const file = `${JOBS_DIR}/${jobId}/${stream}.log`;
    const proc = await this.#container.exec(
      [
        "bash",
        "-c",
        '[ -f "$0" ] || exit 3; tail -c "+$(( $1 + 1 ))" "$0" | head -c "$2"',
        file,
        String(offset),
        String(MAX_LOG_CHUNK_BYTES),
      ],
      { env: BASE_ENV },
    );
    const output = await proc.output();
    return {
      bytes: output.stdout,
      nextOffset: offset + output.stdout.byteLength,
      found: output.exitCode !== 3,
    };
  }

  async stopJob(jobId: string) {
    const status = await this.jobStatus(jobId);
    if (status.state === "running" && status.pid) await this.#run(["kill", "-TERM", `-${status.pid}`], {});
    return this.jobStatus(jobId);
  }

  /** Short buffered command, for small reads such as `git diff` or `cat`. */
  async exec(argv: string[], options: { cwd?: string; env?: Record<string, string>; timeoutSec?: number }) {
    return this.#run(argv, {
      cwd: options.cwd,
      env: options.env,
      timeoutSec: Math.min(options.timeoutSec ?? 60, MAX_EXEC_SECONDS),
    });
  }

  async readFile(path: string) {
    const response = await this.#files.readFile(path);
    return response.arrayBuffer();
  }

  async writeFile(path: string, content: ArrayBuffer) {
    await this.#files.writeFile(path, content);
    // A file the fix loop writes during the checks belongs to the user the checks run as.
    // The file and any folder the write created above it, up to the checkout, not the whole tree.
    if ((await this.ctx.storage.get<Phase>("phase")) === "check" && path.startsWith(`${WORK_DIR}/`))
      await this.#run(
        [
          "sh",
          "-c",
          'p="$1"; while [ "$p" != "$2" ] && [ "$p" != / ]; do chown "$3" "$p"; p=$(dirname "$p"); done',
          "sh",
          path,
          WORK_DIR,
          `${CHECK_USER}:${CHECK_USER}`,
        ],
        {},
      );
    return { path, bytes: content.byteLength };
  }

  async snapshot(name: string) {
    const started = Date.now();
    const snap = await this.#container.snapshotContainer({ name });
    return { ...snap, ms: Date.now() - started };
  }

  async saveCache(name: string, dir: string) {
    const started = Date.now();
    const record = await this.#backups.backup({ dir, name });
    return { record, ms: Date.now() - started };
  }

  async restoreCache(record: DirectoryBackupRecord, dir?: string) {
    const started = Date.now();
    await this.#backups.restore(record, dir ? { dir } : undefined);
    return { ms: Date.now() - started };
  }

  async deleteCache(record: DirectoryBackupRecord) {
    await this.#backups.delete(record);
    return { ok: true as const };
  }

  /** Whether an R2 bucket is bound for the download cache (R21.11): until then every cache route says so. */
  cacheBound() {
    return !!(this.env as { DEP_CACHE?: unknown }).DEP_CACHE;
  }

  async recordEgress(event: EgressEvent) {
    this.ctx.storage.sql.exec(
      "INSERT INTO egress (at, phase, method, host, path) VALUES (?, ?, ?, ?, ?)",
      event.at,
      event.phase,
      event.method,
      event.host,
      event.path,
    );
  }

  async egress(): Promise<EgressEvent[]> {
    return this.ctx.storage.sql
      .exec("SELECT at, phase, method, host, path FROM egress ORDER BY at")
      .toArray() as unknown as EgressEvent[];
  }

  async destroy() {
    if (this.#container.running) await this.#container.destroy();
    await this.ctx.storage.deleteAlarm();
    // The name may be reused by a later run; nothing from this one may leak into it.
    await this.ctx.storage.deleteAll();
    return { destroyed: true };
  }

  /** Keeps the instance alive while jobs run, and forgets jobs that ended. */
  async alarm() {
    if (!this.#container.running) return;
    const jobs = await this.ctx.storage.list<{ startedAt: number }>({ prefix: "job:" });
    let active = false;
    for (const key of jobs.keys()) {
      const status = await this.jobStatus(key.slice(4));
      if (status.state === "running" || status.state === "starting") active = true;
      else await this.ctx.storage.delete(key);
    }
    if (active) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  async #ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  async #sid() {
    const sid = await this.ctx.storage.get<string>("sid");
    if (!sid) throw new Error("conflict: sandbox not started");
    return sid;
  }

  async #routeEgress(sid: string, phase: Phase, tarball?: EgressProps["tarball"]) {
    const egress = this.ctx.exports.Egress({ props: { sid, phase, tarball } });
    // Registering a target again replaces its handler; open connections move to the new one.
    await this.#container.interceptOutboundHttps("*", egress);
    await this.#container.interceptAllOutboundHttp(egress);
  }

  /** The CA file appears after start; add it to the system store so curl, git and npm trust it. */
  #trustInterceptCa() {
    return this.#run(
      [
        "bash",
        "-c",
        'for i in $(seq 1 100); do [ -s "$0" ] && break; sleep 0.1; done; ' +
          'cp "$0" /usr/local/share/ca-certificates/cloudflare-containers.crt && update-ca-certificates >/dev/null',
        INTERCEPT_CA,
      ],
      { timeoutSec: 30 },
    );
  }

  async #run(
    argv: string[],
    options: { cwd?: string; env?: Record<string, string>; timeoutSec?: number },
  ): Promise<ExecResult> {
    const started = Date.now();
    const limit = String(MAX_EXEC_OUTPUT_BYTES);
    const proc = await this.#container.exec(
      [
        "bash",
        "-c",
        // Cap each stream so a chatty command can't exhaust the Durable Object's memory.
        'limit="$0"; t="$1"; shift 1; timeout --kill-after=5 "$t" "$@" > >(head -c "$limit") 2> >(head -c "$limit" >&2)',
        limit,
        String(options.timeoutSec ?? 60),
        ...argv,
      ],
      { cwd: options.cwd, env: { ...BASE_ENV, ...options.env } },
    );
    const output = await proc.output();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      ms: Date.now() - started,
    };
  }
}

function sandboxStub(env: Env, sid: string) {
  return (env.SANDBOX as DurableObjectNamespace<VerifySandbox>).getByName(sid);
}

// ---------------------------------------------------------------------------------------------
// HTTPS API for the Node worker

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Token = `<expiry seconds>.<base64url HMAC-SHA256(key, "<sid>.<expiry>")>`, valid for one sandbox. */
async function authorized(request: Request, env: Env, sid: string) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (\d+)\.([A-Za-z0-9_-]+)$/.exec(header);
  if (!match || !env.TEIRE_SANDBOX_KEY) return false;
  const expiry = Number(match[1]);
  const now = Math.floor(Date.now() / 1000);
  if (expiry < now || expiry > now + MAX_TOKEN_TTL_SECONDS) return false;
  return sameMac(await hmac(env, `${sid}.${expiry}`), match[2] ?? "");
}

async function hmac(env: Env, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.TEIRE_SANDBOX_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function sameMac(expected: string, given: string) {
  const a = encoder.encode(expected);
  const b = encoder.encode(given);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/**
 * A saved cache's seal (R21.11): the sandbox Worker restores or deletes only a record it saved
 * itself, under the name the worker gave it (`<repository id>-<ecosystem>-<root>`), so a record
 * handed in from anywhere else is refused.
 */
type SealedRecord = DirectoryBackupRecord & { seal?: string };
const cacheSeal = (env: Env, r: DirectoryBackupRecord) =>
  hmac(env, `cache.${r.id}.${r.sha256}.${r.name ?? ""}.${r.dir}`);

async function unsealed(env: Env, record: SealedRecord): Promise<DirectoryBackupRecord> {
  const { seal, ...rest } = record;
  if (!env.TEIRE_SANDBOX_KEY || !seal || !sameMac(await cacheSeal(env, rest), seal))
    throw new Error("bad request: a cache record this sandbox Worker didn't save");
  return rest;
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.startsWith("bad request") ? 400 : message.startsWith("conflict") ? 409 : 500;
  return json({ error: message }, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1" || parts[1] !== "sandboxes" || !parts[2]) return json({ error: "not found" }, 404);
    const sid = parts[2];
    if (!SANDBOX_ID.test(sid)) return json({ error: "bad request: invalid sandbox id" }, 400);
    if (!(await authorized(request, env, sid))) return json({ error: "unauthorized" }, 401);

    const sandbox = sandboxStub(env, sid);
    const route = `${request.method} ${parts.slice(3).join("/")}`;
    try {
      if (route === "POST ") return json(await sandbox.start(sid, await request.json<StartOptions>()), 201);
      if (route === "DELETE ") return json(await sandbox.destroy());
      if (route === "PUT phase")
        return json(await sandbox.setPhase((await request.json<{ phase: Phase }>()).phase));
      if (route === "POST exec") {
        const body = await request.json<{
          argv: string[];
          cwd?: string;
          env?: Record<string, string>;
          timeoutSec?: number;
        }>();
        return json(await sandbox.exec(body.argv, body));
      }
      if (route === "POST jobs") {
        const body = await request.json<{
          jobId: string;
          argv: string[];
          cwd?: string;
          env?: Record<string, string>;
          timeoutSec?: number;
        }>();
        return json(await sandbox.startJob(body.jobId, body.argv, body), 201);
      }
      if (parts[3] === "jobs" && parts[4]) {
        const jobId = parts[4];
        if (request.method === "GET" && parts.length === 5) return json(await sandbox.jobStatus(jobId));
        if (request.method === "DELETE" && parts.length === 5) return json(await sandbox.stopJob(jobId));
        if (request.method === "GET" && parts[5] === "log") {
          const stream = url.searchParams.get("stream") === "stderr" ? "stderr" : "stdout";
          const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
          const log = await sandbox.jobLog(jobId, stream, offset);
          if (!log.found) return json({ error: "log not found" }, 404);
          return new Response(log.bytes, {
            headers: { "x-next-offset": String(log.nextOffset), "content-type": "application/octet-stream" },
          });
        }
      }
      if (parts[3] === "files") {
        const path = url.searchParams.get("path") ?? "";
        if (!path.startsWith("/")) return json({ error: "bad request: absolute path required" }, 400);
        if (request.method === "GET") return new Response(await sandbox.readFile(path));
        if (request.method === "PUT") return json(await sandbox.writeFile(path, await request.arrayBuffer()));
      }
      if (route === "POST snapshot")
        return json(await sandbox.snapshot((await request.json<{ name: string }>()).name));
      if (route.startsWith("POST cache/") && !(await sandbox.cacheBound()))
        return json({ error: "no cache bucket is bound (R2 is not enabled)" }, 501);
      if (route === "POST cache/delete") {
        const body = await request.json<{ record: SealedRecord }>();
        return json(await sandbox.deleteCache(await unsealed(env, body.record)));
      }
      if (route === "POST cache/save") {
        const body = await request.json<{ name: string; dir: string }>();
        const saved = await sandbox.saveCache(body.name, body.dir);
        return json({ ...saved, record: { ...saved.record, seal: await cacheSeal(env, saved.record) } });
      }
      if (route === "POST cache/restore") {
        const body = await request.json<{ record: SealedRecord; dir?: string }>();
        return json(await sandbox.restoreCache(await unsealed(env, body.record), body.dir));
      }
      if (route === "GET egress") return json(await sandbox.egress());
      return json({ error: "not found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;
