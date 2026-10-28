import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERIFY } from "../constants";
import type { VerifyBackend, VerifySession } from "./backend";
import type { JobResult } from "./cloudflare";

/**
 * Token Factory Sandboxes (Contree) as a verification backend (plan S17, D107): public repositories
 * and dry runs. Each command is a microVM spawned from an image; a non-disposable spawn saves its
 * result as a new image. So the session keeps a current image: the checkout and the install are
 * steps that each produce the next image (network on). The checks run with the network off and are
 * chained the same way: each starts from the image the previous check left, so a build's output
 * reaches the tests, as it does in the Cloudflare backend's single container. Files Teire writes
 * between steps (the agent's edits) are uploaded and mounted into each later spawn.
 *
 * Limits are read from `whoami`, never assumed, and shared by every session in the process (review
 * R24): spawns and imports wait for a slot under the project's concurrency, and timeouts stay under
 * its maximum. Each command runs under GNU `timeout`, so a hung check ends with 124 inside the VM.
 * Output streams from the operation's server-sent events while it runs; state polling is the
 * fallback. Spawns are not retried (no idempotency key); `close` cancels what is still running.
 */

const BASE = "https://api.tokenfactory.nebius.com/sandboxes/v1";
const POLL_MS = 2_000;
/** Consecutive failed status reads tolerated before an operation counts as lost. */
const TOKEN_FACTORY_POLL_RETRIES = 8;
/** A quiet event stream is checked against the operation's state this often. */
const FOLLOW_IDLE_MS = 20_000;

/** A frame's JSON, or null when the service sent something else. */
function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Plain paths only: Token Factory has no egress interception, so no intercept CA is set. */
const ENV: Record<string, string> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/home/teire",
  CI: "1",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
};
/** The unprivileged user every image creates (uid 10001), as the checks run on CI. */
const CHECK_UID = 10001;
/** GNU `timeout`'s grace before KILL, and the margin the platform's own timeout keeps above it. */
const KILL_AFTER_SEC = 10;
const PLATFORM_MARGIN_SEC = 30;

/** A counting semaphore: callers wait for a free slot. */
class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];
  constructor(size: number) {
    this.#free = Math.max(1, size);
  }
  async take() {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }
  give() {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free++;
  }
}

interface Limits {
  maxTimeoutSec: number;
  spawns: Slots;
  imports: Slots;
}

/** Per project, read once from `whoami`; a failed read is not kept, so the next call asks again. */
const limitsByProject = new Map<string, Promise<Limits>>();

export interface TokenFactorySandboxConfig {
  apiKey: string;
  project: string;
  baseUrl?: string;
}

export function tokenFactorySandboxConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TokenFactorySandboxConfig | null {
  return env.TOKENFACTORY_API_KEY && env.NEBIUS_PROJECT_ID
    ? { apiKey: env.TOKENFACTORY_API_KEY, project: env.NEBIUS_PROJECT_ID }
    : null;
}

interface Stream {
  value: string;
  encoding: "ascii" | "base64";
  truncated?: boolean;
}

interface Operation {
  uuid: string;
  status: "PENDING" | "ASSIGNED" | "EXECUTING" | "SUCCESS" | "FAILED" | "CANCELLED";
  error?: string | null;
  duration?: number | null;
  result_image_uuid?: string | null;
  metadata?: {
    result?: {
      state?: { exit_code?: number | null; timed_out?: boolean };
      stdout?: Stream;
      stderr?: Stream;
    };
  };
}

const text = (s?: Stream) =>
  !s ? "" : s.encoding === "base64" ? Buffer.from(s.value, "base64").toString("utf8") : s.value;

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** Shell-quoted argv, run in `cwd` (the API takes one command string when `shell` is on). */
function shellCommand(argv: string[], cwd?: string) {
  return `${cwd ? `cd ${quote(cwd)} && ` : ""}exec ${argv.map(quote).join(" ")}`;
}

/** The command under GNU `timeout` (review R24): TERM at `seconds`, KILL a little later, exit 124. */
export function underTimeout(command: string, seconds: number) {
  return `timeout -k ${KILL_AFTER_SEC} ${seconds} sh -c ${quote(command)}`;
}

export class TokenFactorySandboxes {
  readonly #config: TokenFactorySandboxConfig;

  constructor(config: TokenFactorySandboxConfig) {
    this.#config = config;
  }

  async #request(
    method: string,
    path: string,
    body?: Uint8Array | string | ReadableStream<Uint8Array> | object,
    contentType?: string,
  ): Promise<Response> {
    const stream = body instanceof ReadableStream;
    const raw = stream || body instanceof Uint8Array || typeof body === "string";
    const response = await fetch(`${this.#config.baseUrl ?? BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#config.apiKey}`,
        project: this.#config.project,
        ...(body !== undefined
          ? { "content-type": contentType ?? (raw ? "application/octet-stream" : "application/json") }
          : {}),
      },
      // A stream goes up chunked as it arrives (`duplex: "half"`); Token Factory accepts that (R17).
      ...(body !== undefined
        ? {
            body: raw ? (body as RequestInit["body"]) : JSON.stringify(body),
            ...(stream ? { duplex: "half" } : {}),
          }
        : {}),
      signal: AbortSignal.timeout(stream ? VERIFY.uploadTimeoutMs : 120_000),
    });
    if (!response.ok)
      throw new Error(
        `Token Factory Sandboxes ${method} ${path} → ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    return response;
  }

  async #json<T>(
    method: string,
    path: string,
    body?: Uint8Array | string | ReadableStream<Uint8Array> | object,
  ): Promise<T> {
    return (await (await this.#request(method, path, body)).json()) as T;
  }

  /** Permissions and limits for this project. */
  whoami() {
    return this.#json<{ permissions: Record<string, boolean>; limits: Record<string, number> }>(
      "GET",
      "/whoami",
    );
  }

  /** The project's limits from `whoami` (`instance_max_concurrency`, `instance_max_timeout`, …). */
  limits(): Promise<Limits> {
    const key = `${this.#config.baseUrl ?? BASE}|${this.#config.project}`;
    let pending = limitsByProject.get(key);
    if (!pending) {
      pending = this.whoami().then(({ limits }) => {
        const need = (name: string) => {
          const value = limits[name];
          if (typeof value !== "number" || value <= 0) throw new Error(`whoami has no ${name}`);
          return value;
        };
        return {
          maxTimeoutSec: need("instance_max_timeout"),
          spawns: new Slots(need("instance_max_concurrency")),
          imports: new Slots(need("images_import_max_concurrency")),
        };
      });
      pending.catch(() => limitsByProject.delete(key));
      limitsByProject.set(key, pending);
    }
    return pending;
  }

  /** Asks Token Factory to stop an operation; one already finished or gone is fine. */
  async cancel(operation: string) {
    await this.#request("DELETE", `/operations/${operation}`).catch(() => undefined);
  }

  /** An image by tag, if this project or the public catalog has it. */
  async imageByTag(tag: string): Promise<string | null> {
    const { images } = await this.#json<{ images: { uuid: string; tag?: string | null }[] }>(
      "GET",
      `/images?tag=${encodeURIComponent(tag)}&limit=5`,
    );
    return images.find((i) => i.tag === tag)?.uuid ?? null;
  }

  /** Import a public registry image; the same unchanged image returns the same UUID. */
  async importImage(url: string, tag?: string): Promise<string> {
    const limits = await this.limits();
    await limits.imports.take();
    let op: Operation;
    try {
      const { uuid } = await this.#json<{ uuid: string }>("POST", "/images/import", {
        registry: { url },
        ...(tag ? { tag } : {}),
      });
      op = await this.wait(uuid, 3_600_000);
    } finally {
      limits.imports.give();
    }
    if (op.status !== "SUCCESS" || !op.result_image_uuid)
      throw new Error(`import ${url}: ${op.status}${op.error ? `: ${op.error}` : ""}`);
    return op.result_image_uuid;
  }

  async tag(imageUuid: string, tag: string) {
    await this.#request("PATCH", `/images/${imageUuid}/tag`, { tag });
  }

  /** Upload bytes or a stream of them; returns the file's UUID for `files` mounts. */
  async upload(bytes: Uint8Array | ReadableStream<Uint8Array>): Promise<string> {
    try {
      const { uuid } = await this.#json<{ uuid: string }>("POST", "/files", bytes);
      return uuid;
    } catch (error) {
      // Node's fetch reports a failed request body as "fetch failed" with the reason in `cause`
      // (the tarball's size cap, say): the reason is what the run should say (stage R review).
      const cause = (error as { cause?: unknown }).cause;
      // A size cap keeps its type, so the run doesn't try the same upload again.
      if (cause instanceof TarballTooLargeError) throw cause;
      throw cause instanceof Error ? new Error(`upload failed: ${cause.message}`) : error;
    }
  }

  /** A file's bytes from an image (null when it isn't there). */
  async download(imageUuid: string, path: string): Promise<Uint8Array | null> {
    const response = await fetch(
      `${this.#config.baseUrl ?? BASE}/inspect/${imageUuid}/download?path=${encodeURIComponent(path)}`,
      {
        headers: { authorization: `Bearer ${this.#config.apiKey}`, project: this.#config.project },
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`download ${path} → ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** One microVM; not retried (spawns carry no idempotency key). */
  async spawn(request: {
    image: string;
    command: string;
    env?: Record<string, string>;
    cwd?: string;
    uid?: number;
    gid?: number;
    disposable: boolean;
    network: boolean;
    timeoutSec: number;
    files?: Record<string, { uuid: string; mode?: string; uid?: number; gid?: number }>;
    preserveEnv?: boolean;
    /** Output as the command writes it (the operation's server-sent events). */
    onLog?: (chunk: string) => void;
    /** The operation's id once it exists, so a session can cancel it. */
    onStart?: (operation: string) => void;
  }): Promise<{
    op: Operation;
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    ms: number;
  }> {
    const limits = await this.limits();
    const timeoutSec = Math.min(request.timeoutSec, limits.maxTimeoutSec);
    await limits.spawns.take();
    // Timed from the spawn itself, not the wait for a slot: "137 at the limit" compares with it.
    const started = Date.now();
    let op: Operation;
    try {
      const { uuid } = await this.#json<{ uuid: string }>("POST", "/instances", {
        image: request.image,
        command: request.command,
        shell: true,
        env: request.env ?? {},
        ...(request.cwd ? { cwd: request.cwd } : {}),
        uid: request.uid ?? 0,
        gid: request.gid ?? 0,
        disposable: request.disposable,
        networking: { enabled: request.network },
        timeout: timeoutSec,
        truncate_output_at: 4 * 1024 * 1024,
        ...(request.files ? { files: request.files } : {}),
        ...(request.preserveEnv ? { preserve_env: true } : {}),
      });
      request.onStart?.(uuid);
      // One deadline for the whole wait: following the events and the polling that confirms the end.
      const maxMs = (timeoutSec + 300) * 1000;
      const deadline = Date.now() + maxMs;
      await this.follow(uuid, maxMs, request.onLog);
      op = await this.wait(uuid, Math.max(10_000, deadline - Date.now()));
    } finally {
      limits.spawns.give();
    }
    const result = op.metadata?.result;
    return {
      op,
      exitCode: result?.state?.exit_code ?? null,
      timedOut: !!result?.state?.timed_out,
      stdout: text(result?.stdout),
      stderr: text(result?.stderr) + (op.status === "FAILED" && op.error ? `\n${op.error}` : ""),
      ms: Date.now() - started,
    };
  }

  /**
   * Follows an operation's server-sent events until its `completion` event, passing `stdout` and
   * `stderr` chunks to `onLog`. A dropped stream resumes from the last event id; when the stream
   * can't be had at all it returns, and `wait`'s state polling decides (review R24).
   */
  async follow(operation: string, maxMs: number, onLog?: (chunk: string) => void): Promise<void> {
    const deadline = Date.now() + maxMs;
    let since = 0;
    for (let attempt = 0; attempt <= TOKEN_FACTORY_POLL_RETRIES && Date.now() < deadline; attempt++) {
      const response = await fetch(
        `${this.#config.baseUrl ?? BASE}/operations/${operation}/events?follow=1${since ? `&since=${since}` : ""}`,
        {
          headers: {
            authorization: `Bearer ${this.#config.apiKey}`,
            project: this.#config.project,
            accept: "text/event-stream",
          },
          signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
        },
      ).catch(() => null);
      if (!response || response.status === 410 || response.status === 425 || response.status >= 500) {
        const after = Number(response?.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : POLL_MS));
        continue;
      }
      if (!response.ok || !response.body) return;
      let buffer = "";
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      // One read is pending at a time: a quiet spell keeps waiting on the same read, so no frame is
      // taken by a read whose answer was abandoned (review round 2).
      let pending: ReturnType<typeof reader.read> | null = null;
      try {
        for (;;) {
          // A stream that goes quiet is checked against the operation's state, so one that never
          // sends `completion` can't hold the command past its end.
          pending ??= reader.read();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const idle = new Promise<"idle">((r) => {
            timer = setTimeout(() => r("idle"), FOLLOW_IDLE_MS);
          });
          const next = await Promise.race([pending, idle]);
          clearTimeout(timer);
          if (next === "idle") {
            const op = await this.#json<Operation>("GET", `/operations/${operation}`).catch(() => null);
            if (op && (op.status === "SUCCESS" || op.status === "FAILED" || op.status === "CANCELLED")) {
              void reader.cancel().catch(() => undefined);
              return;
            }
            continue;
          }
          pending = null;
          if (next.done) break;
          // CRLF can split across chunks: normalise after joining.
          buffer = (buffer + next.value).replace(/\r\n/g, "\n");
          for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const field = (name: string) =>
              frame
                .split("\n")
                .filter((l) => l.startsWith(`${name}:`))
                .map((l) => l.slice(name.length + 1).replace(/^ /, ""))
                .join("\n");
            const type = field("event");
            if (type === "completion") {
              void reader.cancel().catch(() => undefined);
              return;
            }
            if (onLog && (type === "stdout" || type === "stderr")) {
              // A frame that isn't JSON is skipped, not retried: its id still advances below.
              const event = safeJson<{ data?: Stream }>(field("data") || "{}");
              const out = text(event?.data);
              if (out) onLog(out);
            }
            // The id advances only once the frame was read, so a resume never skips it.
            const id = Number(field("id"));
            if (Number.isFinite(id) && id > since) since = id;
          }
        }
      } catch {
        // A broken stream resumes from `since` on the next attempt.
      }
    }
  }

  async wait(operation: string, maxMs: number): Promise<Operation> {
    const deadline = Date.now() + maxMs;
    let misses = 0;
    for (;;) {
      // One failed status read (a reset, a 502) must not fail a 25-minute install (review R10): reads
      // retry with backoff, and only a run of failures past the deadline gives up.
      let op: Operation;
      try {
        op = await this.#json<Operation>("GET", `/operations/${operation}`);
        misses = 0;
      } catch (error) {
        misses++;
        if (Date.now() > deadline || misses > TOKEN_FACTORY_POLL_RETRIES) throw error;
        await new Promise((r) => setTimeout(r, POLL_MS * 2 ** Math.min(misses, 5)));
        continue;
      }
      if (op.status === "SUCCESS" || op.status === "FAILED" || op.status === "CANCELLED") return op;
      if (Date.now() > deadline) throw new Error(`operation ${operation} still ${op.status}`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

/**
 * The sandbox images, built inside Token Factory from the same Dockerfiles the Cloudflare images
 * use: the final stage's public base image is imported, then one non-disposable VM runs every RUN
 * line with the COPY'd scripts mounted, and the result is tagged by the recipe's hash, so each
 * image is built once. Cloudflare's shim (COPY --from=shim) has no role here and is skipped; a
 * COPY from another image stage is not supported and stops the build with its line.
 */
export function imageRecipe(dockerfileDir: string) {
  const dockerfile = readFileSync(join(dockerfileDir, "Dockerfile"), "utf8").replace(/\\\n/g, " ");
  const lines = dockerfile
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const finalFrom = lines
    .map((l, i) => [l, i] as const)
    .filter(([l]) => /^FROM\s/i.test(l))
    .at(-1);
  // Stages named `AS x`, so a COPY --from=x of a Temurin JDK can be fetched instead of copied.
  const stages = new Map(
    lines
      .map((l) => /^FROM\s+(\S+)\s+AS\s+(\S+)/i.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[2] as string, (m[1] as string).replace(/^docker\.io\/library\//, "")]),
  );
  if (!finalFrom) throw new Error(`${dockerfileDir}: no FROM`);
  // As a registry resolves it: `node:24` is docker.io/library/node:24; a host-qualified ref is kept.
  const ref = finalFrom[0].split(/\s+/)[1] ?? "";
  const base = /^[^/]+[.:][^/]*\//.test(ref)
    ? ref
    : `docker.io/${ref.includes("/") ? ref : `library/${ref}`}`;
  const args: Record<string, string> = {};
  const env: Record<string, string> = {};
  const runs: string[] = [];
  const copies: { from: string; to: string }[] = [];
  for (const line of lines.slice(finalFrom[1] + 1)) {
    const [word = "", ...rest] = line.split(/\s+/);
    const body = rest.join(" ");
    const expand = (s: string) => s.replace(/\$\{?(\w+)\}?/g, (m, k: string) => args[k] ?? env[k] ?? m);
    switch (word.toUpperCase()) {
      case "ARG": {
        const [k, v = ""] = body.split("=");
        if (k) args[k] = v;
        break;
      }
      case "ENV":
        for (const m of body.matchAll(/(\w+)=("[^"]*"|\S+)/g))
          if (m[1]) env[m[1]] = expand((m[2] ?? "").replace(/^"|"$/g, ""));
        break;
      case "RUN":
        runs.push(expand(body));
        break;
      case "COPY": {
        if (/--from=shim\b/.test(body)) break;
        const from = /--from=(\S+)/.exec(body)?.[1];
        if (from) {
          // A Temurin stage's JDK: the same major's latest GA build from Adoptium, unpacked in place.
          const jdk = /^eclipse-temurin:(\d+)-jdk/.exec(stages.get(from) ?? "")?.[1];
          const [, src, dest] = body.split(/\s+/);
          if (!jdk || src !== "/opt/java/openjdk" || !dest)
            throw new Error(`${dockerfileDir}: ${line} copies from another image`);
          runs.push(
            `mkdir -p ${dest} && curl -fsSL https://api.adoptium.net/v3/binary/latest/${jdk}/ga/linux/x64/jdk/hotspot/normal/eclipse | tar -xz --strip-components=1 -C ${dest}`,
          );
          break;
        }
        const parts = body.split(/\s+/);
        const to = parts.at(-1) ?? "";
        for (const from of parts.slice(0, -1))
          copies.push({
            from: join(dockerfileDir, from),
            to: to.endsWith("/") ? `${to}${from.split("/").at(-1)}` : to,
          });
        break;
      }
      default:
        break;
    }
  }
  const hash = createHash("sha256")
    .update(
      JSON.stringify({ base, env, runs, copies: copies.map((c) => [c.to, readFileSync(c.from, "utf8")]) }),
    )
    .digest("hex")
    .slice(0, 16);
  return { base, env, runs, copies, hash };
}

/** The recipe's image in Token Factory: found by tag, else built once and tagged. */
/** One build per recipe at a time in this process (review R11): every session waiting shares it. */
const building = new Map<string, Promise<string>>();

/** Each base image's imported UUID, read again daily: a base tag that moved (node:24) builds anew. */
const bases = new Map<string, { uuid: string; at: number }>();
const BASE_REFRESH_MS = 24 * 60 * 60 * 1000;

async function baseImage(client: TokenFactorySandboxes, ref: string) {
  const hit = bases.get(ref);
  if (hit && Date.now() - hit.at < BASE_REFRESH_MS) return hit.uuid;
  const uuid = await client.importImage(`docker://${ref}`);
  bases.set(ref, { uuid, at: Date.now() });
  return uuid;
}

export function ensureImage(client: TokenFactorySandboxes, name: string, dockerfileDir: string) {
  const recipe = imageRecipe(dockerfileDir);
  const key = `teire-${name}:${recipe.hash}`;
  const pending = building.get(key);
  if (pending) return pending;
  // The tag names the recipe and the base it was built on (stage R review: a moved base tag reused
  // the old image), so the same recipe on a new base is a new image.
  const job = baseImage(client, recipe.base)
    .then((base) => buildImage(client, `${key}-${base.slice(0, 8)}`, recipe, base))
    .finally(() => building.delete(key));
  building.set(key, job);
  return job;
}

async function buildImage(
  client: TokenFactorySandboxes,
  tag: string,
  recipe: ReturnType<typeof imageRecipe>,
  base: string,
) {
  const found = await client.imageByTag(tag);
  if (found) return found;
  const files: Record<string, { uuid: string; mode: string }> = {};
  for (const c of recipe.copies)
    files[c.to] = { uuid: await client.upload(readFileSync(c.from)), mode: "0755" };
  const built = await client.spawn({
    image: base,
    command: ["set -e", ...recipe.runs].join(" && "),
    env: { PATH: ENV.PATH as string, DEBIAN_FRONTEND: "noninteractive", ...recipe.env },
    disposable: false,
    network: true,
    timeoutSec: 3_000,
    files,
    preserveEnv: true,
  });
  const image = built.op.result_image_uuid;
  if (built.exitCode !== 0 || !image)
    throw new Error(
      `building ${tag} failed (${built.exitCode}): ${(built.stderr || built.stdout).slice(-800)}`,
    );
  await client.tag(image, tag);
  return image;
}

/**
 * A verification session on Token Factory Sandboxes. The checkout is the first step: the tarball
 * is uploaded once and unpacked into /work in a non-disposable VM.
 */
/** The repository is no longer confirmed public: nothing of it goes to Token Factory. */
/** A tarball over the size Teire sends to a sandbox: a result, not something to try again. */
export class TarballTooLargeError extends Error {}

export class RepositoryNotPublicError extends Error {
  constructor() {
    super("the repository is no longer confirmed public, so it isn't sent to Token Factory Sandboxes");
  }
}

export function tokenFactoryBackend(
  config: TokenFactorySandboxConfig,
  images: { dir: string },
  fetchTarball: (url: string, token?: string) => Promise<ReadableStream<Uint8Array>>,
  /**
   * Asked before every upload (review R1): a repository that went private during the run never
   * reaches Token Factory, whose images keep code for 180 days. Unknown counts as private.
   */
  stillPublic?: () => Promise<boolean>,
): VerifyBackend {
  const client = new TokenFactorySandboxes(config);
  return {
    name: "tokenfactory",
    async open(id, options) {
      const name = (options.image ?? "teire-node").replace(/^teire-/, "");
      let image = await ensureImage(client, name, join(images.dir, name));
      if (stillPublic && !(await stillPublic().catch(() => false))) throw new RepositoryNotPublicError();
      const tarball = await client.upload(await fetchTarball(options.tarball.url, options.tarball.token));
      // Operations this session started that may still run, cancelled on close. An operation leaves
      // the set only once it finished; one whose wait failed stays, so close can still cancel it.
      const live = new Set<string>();
      const track = { onStart: (uuid: string) => void live.add(uuid) };
      const done = <T extends { op: Operation }>(r: T) => {
        live.delete(r.op.uuid);
        return r;
      };
      // A session that fails to open is never returned, so nothing else could cancel its unpack: it is
      // cancelled here (review round 2).
      const unpack = await client
        .spawn({
          ...track,
          image,
          command: `mkdir -p ${VERIFY.workDir} && tar -xzf /tmp/repo.tar.gz --strip-components=1 -C ${VERIFY.workDir} && rm -f /tmp/repo.tar.gz`,
          env: ENV,
          disposable: false,
          network: false,
          timeoutSec: 600,
          files: { "/tmp/repo.tar.gz": { uuid: tarball } },
        })
        .then(done)
        .catch(async (error: unknown) => {
          await Promise.all([...live].map((uuid) => client.cancel(uuid).catch(() => undefined)));
          throw error;
        });
      if (unpack.exitCode !== 0 || !unpack.op.result_image_uuid)
        throw new Error(`unpacking the repository failed: ${unpack.stderr.slice(-400)}`);
      image = unpack.op.result_image_uuid;
      let phase: "install" | "check" = "install";
      const { maxTimeoutSec } = await client.limits();
      // Files Teire wrote since the last saved image, mounted into every later spawn.
      const written = new Map<string, { uuid: string; bytes: Uint8Array }>();
      const mounts = () =>
        Object.fromEntries(
          [...written].map(([path, f]) => [
            path,
            { uuid: f.uuid, uid: phase === "check" ? CHECK_UID : 0, gid: phase === "check" ? CHECK_UID : 0 },
          ]),
        );
      const session: VerifySession = {
        id,
        async setPhase(next) {
          if (next === "check" && phase !== "check") {
            // The checks run as the unprivileged user: hand it the checkout and the caches.
            const chown = await client
              .spawn({
                ...track,
                image,
                command: `chown -R ${CHECK_UID}:${CHECK_UID} ${VERIFY.workDir} /home/teire`,
                env: ENV,
                disposable: false,
                network: false,
                timeoutSec: 600,
                files: mounts(),
              })
              .then(done);
            if (chown.op.result_image_uuid) {
              image = chown.op.result_image_uuid;
              written.clear();
            }
          }
          phase = next;
        },
        async run(_jobId, argv, opts): Promise<JobResult> {
          const install = phase === "install";
          // GNU `timeout` ends the command inside the VM; the platform's timeout stays above it.
          const seconds = Math.min(
            opts.timeoutSec ?? VERIFY.checkTimeoutSec,
            maxTimeoutSec - KILL_AFTER_SEC - PLATFORM_MARGIN_SEC,
          );
          const r = await client
            .spawn({
              ...track,
              image,
              command: underTimeout(shellCommand(argv, opts.cwd), seconds),
              env: { ...ENV, ...(opts.env ?? {}) },
              ...(install ? {} : { uid: CHECK_UID, gid: CHECK_UID }),
              // Every step's result is the image the next one starts from: the install's for the first
              // check, each check's for the one after (generated files, build output, test reports).
              disposable: false,
              network: install,
              timeoutSec: seconds + KILL_AFTER_SEC + PLATFORM_MARGIN_SEC,
              files: mounts(),
              ...(opts.onLog ? { onLog: opts.onLog } : {}),
            })
            .then(done);
          if (r.op.result_image_uuid && (r.op.status === "SUCCESS" || !install)) {
            image = r.op.result_image_uuid;
            written.clear();
          }
          return {
            state: "exited",
            // GNU timeout exits 124 on TERM and 137 when it had to KILL: both are the time limit.
            exitCode: r.timedOut || (r.exitCode === 137 && r.ms >= seconds * 1000) ? 124 : (r.exitCode ?? -1),
            stdout: r.stdout,
            stderr: r.stderr,
            ms: r.ms,
          };
        },
        async readFile(path) {
          const mine = written.get(path);
          if (mine) return mine.bytes;
          return client.download(image, path).catch(() => null);
        },
        async writeFile(path, content) {
          if (stillPublic && !(await stillPublic().catch(() => false))) throw new RepositoryNotPublicError();
          written.set(path, { uuid: await client.upload(content), bytes: content });
        },
        // Token Factory keeps no egress log; checks run with no network at all.
        egress: async () => [],
        // What can be released is released: operations still running are cancelled. Saved images and
        // uploaded files have no delete in the API; images keep code 180 days, hence public repos only.
        close: async () => {
          await Promise.all([...live].map((uuid) => client.cancel(uuid)));
          live.clear();
        },
      };
      return session;
    },
  };
}
