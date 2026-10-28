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
 * Limits are read from `whoami`, never assumed; spawns are not retried (no idempotency key).
 */

const BASE = "https://api.tokenfactory.nebius.com/sandboxes/v1";
const POLL_MS = 2_000;
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

/** Shell-quoted argv, run in `cwd` (the API takes one command string when `shell` is on). */
function shellCommand(argv: string[], cwd?: string) {
  const q = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return `${cwd ? `cd ${q(cwd)} && ` : ""}exec ${argv.map(q).join(" ")}`;
}

export class TokenFactorySandboxes {
  readonly #config: TokenFactorySandboxConfig;

  constructor(config: TokenFactorySandboxConfig) {
    this.#config = config;
  }

  async #request(
    method: string,
    path: string,
    body?: Uint8Array | string | object,
    contentType?: string,
  ): Promise<Response> {
    const raw = body instanceof Uint8Array || typeof body === "string";
    const response = await fetch(`${this.#config.baseUrl ?? BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#config.apiKey}`,
        project: this.#config.project,
        ...(body !== undefined
          ? { "content-type": contentType ?? (raw ? "application/octet-stream" : "application/json") }
          : {}),
      },
      ...(body !== undefined ? { body: raw ? (body as Uint8Array | string) : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(
        `Token Factory Sandboxes ${method} ${path} → ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    return response;
  }

  async #json<T>(method: string, path: string, body?: Uint8Array | string | object): Promise<T> {
    return (await (await this.#request(method, path, body)).json()) as T;
  }

  /** Permissions and limits for this project. */
  whoami() {
    return this.#json<{ permissions: Record<string, boolean>; limits: Record<string, number> }>(
      "GET",
      "/whoami",
    );
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
    const { uuid } = await this.#json<{ uuid: string }>("POST", "/images/import", {
      registry: { url },
      ...(tag ? { tag } : {}),
    });
    const op = await this.wait(uuid, 3_600_000);
    if (op.status !== "SUCCESS" || !op.result_image_uuid)
      throw new Error(`import ${url}: ${op.status}${op.error ? `: ${op.error}` : ""}`);
    return op.result_image_uuid;
  }

  async tag(imageUuid: string, tag: string) {
    await this.#request("PATCH", `/images/${imageUuid}/tag`, { tag });
  }

  /** Upload bytes; returns the file's UUID for `files` mounts. */
  async upload(bytes: Uint8Array): Promise<string> {
    const { uuid } = await this.#json<{ uuid: string }>("POST", "/files", bytes);
    return uuid;
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
  }): Promise<{
    op: Operation;
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    ms: number;
  }> {
    const started = Date.now();
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
      timeout: request.timeoutSec,
      truncate_output_at: 4 * 1024 * 1024,
      ...(request.files ? { files: request.files } : {}),
      ...(request.preserveEnv ? { preserve_env: true } : {}),
    });
    const op = await this.wait(uuid, (request.timeoutSec + 300) * 1000);
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

  async wait(operation: string, maxMs: number): Promise<Operation> {
    const deadline = Date.now() + maxMs;
    for (;;) {
      const op = await this.#json<Operation>("GET", `/operations/${operation}`);
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
export async function ensureImage(client: TokenFactorySandboxes, name: string, dockerfileDir: string) {
  const recipe = imageRecipe(dockerfileDir);
  const tag = `teire-${name}:${recipe.hash}`;
  const found = await client.imageByTag(tag);
  if (found) return found;
  const base = await client.importImage(`docker://${recipe.base}`);
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
export function tokenFactoryBackend(
  config: TokenFactorySandboxConfig,
  images: { dir: string },
  fetchTarball: (url: string, token?: string) => Promise<Uint8Array>,
): VerifyBackend {
  const client = new TokenFactorySandboxes(config);
  return {
    name: "tokenfactory",
    async open(id, options) {
      const name = (options.image ?? "teire-node").replace(/^teire-/, "");
      let image = await ensureImage(client, name, join(images.dir, name));
      const tarball = await client.upload(await fetchTarball(options.tarball.url, options.tarball.token));
      const unpack = await client.spawn({
        image,
        command: `mkdir -p ${VERIFY.workDir} && tar -xzf /tmp/repo.tar.gz --strip-components=1 -C ${VERIFY.workDir} && rm -f /tmp/repo.tar.gz`,
        env: ENV,
        disposable: false,
        network: false,
        timeoutSec: 600,
        files: { "/tmp/repo.tar.gz": { uuid: tarball } },
      });
      if (unpack.exitCode !== 0 || !unpack.op.result_image_uuid)
        throw new Error(`unpacking the repository failed: ${unpack.stderr.slice(-400)}`);
      image = unpack.op.result_image_uuid;
      let phase: "install" | "check" = "install";
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
            const chown = await client.spawn({
              image,
              command: `chown -R ${CHECK_UID}:${CHECK_UID} ${VERIFY.workDir} /home/teire`,
              env: ENV,
              disposable: false,
              network: false,
              timeoutSec: 600,
              files: mounts(),
            });
            if (chown.op.result_image_uuid) {
              image = chown.op.result_image_uuid;
              written.clear();
            }
          }
          phase = next;
        },
        async run(_jobId, argv, opts): Promise<JobResult> {
          const install = phase === "install";
          const r = await client.spawn({
            image,
            command: shellCommand(argv, opts.cwd),
            env: { ...ENV, ...(opts.env ?? {}) },
            ...(install ? {} : { uid: CHECK_UID, gid: CHECK_UID }),
            // Every step's result is the image the next one starts from: the install's for the first
            // check, each check's for the one after (generated files, build output, test reports).
            disposable: false,
            network: install,
            timeoutSec: Math.min(opts.timeoutSec ?? VERIFY.checkTimeoutSec, 3_600),
            files: mounts(),
          });
          if (r.op.result_image_uuid && (r.op.status === "SUCCESS" || !install)) {
            image = r.op.result_image_uuid;
            written.clear();
          }
          return {
            state: "exited",
            exitCode: r.timedOut ? 124 : (r.exitCode ?? -1),
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
          written.set(path, { uuid: await client.upload(content), bytes: content });
        },
        // Token Factory keeps no egress log; checks run with no network at all.
        egress: async () => [],
        close: async () => undefined,
      };
      return session;
    },
  };
}
