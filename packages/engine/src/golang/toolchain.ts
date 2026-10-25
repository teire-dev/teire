import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { GO } from "../constants";

const run = promisify(execFile);

/**
 * Every Go command the worker runs goes through here (plan D58, D75, D88): the go command reads
 * modules and type-checks; it never runs their code once these are set.
 *  - GOTOOLCHAIN=local: a repo's `toolchain` line cannot make it download and run another Go;
 *  - CGO_ENABLED=0: no C compiler on package sources;
 *  - GOENV=off, GOWORK=off: no settings from a user env file or a workspace file in the repo;
 *  - GOPROXY=proxy.golang.org only and GOVCS=*:off: modules come as zips from the proxy, never by
 *    running git, hg or svn against hosts a go.mod names;
 *  - a scratch HOME with no credentials; one shared module and build cache.
 * Private modules therefore fail to resolve, and the verdict says so.
 */
export function goBinary() {
  return process.env.TEIRE_GO ?? "go";
}

export function goEnv(home: string): NodeJS.ProcessEnv {
  const cache = process.env.TEIRE_GO_CACHE ?? join(tmpdir(), "teire-go-cache");
  return {
    PATH: `${dirname(goBinary())}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    GOPATH: join(cache, "gopath"),
    GOMODCACHE: join(cache, "gopath", "pkg", "mod"),
    GOCACHE: join(cache, "build"),
    GOTOOLCHAIN: "local",
    CGO_ENABLED: "0",
    GOENV: "off",
    GOWORK: "off",
    GOFLAGS: "-mod=mod -modcacherw",
    GOPROXY: GO.proxy,
    GOVCS: "*:off",
    GONOSUMDB: "",
    GOPRIVATE: "",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function scratchHome() {
  return mkdtemp(join(tmpdir(), "teire-go-home-"));
}

export async function runGo(args: string[], cwd: string, home: string, timeoutMs = GO.commandTimeoutMs) {
  const { stdout, stderr } = await run(goBinary(), args, {
    cwd,
    env: goEnv(home),
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/**
 * Teire's Go helper (`packages/helpers/go`): the worker image ships it built (`TEIRE_GO_HELPER`);
 * in development it is built once into the user cache with the same pinned modules.
 */
async function helperBinary() {
  if (process.env.TEIRE_GO_HELPER) return process.env.TEIRE_GO_HELPER;
  const out = join(homedir(), ".cache", "teire", `teire-go-${GO.helperVersion}`);
  if (existsSync(out)) return out;
  await mkdir(dirname(out), { recursive: true });
  const source = resolve(import.meta.dirname, "../../../helpers/go");
  await run(goBinary(), ["build", "-o", out, "."], {
    cwd: source,
    env: { ...process.env, CGO_ENABLED: "0", GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod" },
    timeout: 300_000,
  });
  return out;
}

export async function runGoHelper<T>(
  subcommand: string,
  args: string[],
  cwd: string,
  home: string,
): Promise<T> {
  const bin = await helperBinary();
  try {
    const { stdout } = await run(bin, [subcommand, ...args], {
      cwd,
      env: goEnv(home),
      timeout: GO.helperTimeoutMs,
      maxBuffer: 256 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as T;
  } catch (error) {
    // The helper prints {"error": …} and exits 1; surface that message.
    const stdout = (error as { stdout?: string }).stdout ?? "";
    const parsed = (() => {
      try {
        return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { error?: string };
      } catch {
        return null;
      }
    })();
    throw new Error(parsed?.error ?? (error instanceof Error ? error.message : String(error)));
  }
}
