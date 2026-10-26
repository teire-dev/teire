import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PYTHON } from "../constants";

const run = promisify(execFile);

/**
 * Runs Teire's Python helper (`packages/helpers/python/teire_py.py`) and parses its JSON (plan S03).
 * In the worker image the helper has its own venv (`TEIRE_PYTHON`, packaging + griffe + jedi
 * pinned). Elsewhere uv supplies the same pins; without uv, a Python 3.11+ already on the machine
 * gets a venv with the same pins, once, in the user's cache. `-I` keeps the interpreter from
 * importing anything from the current directory or the code it reads.
 */
export const HELPER_PATH =
  process.env.TEIRE_PY_HELPER ?? resolve(import.meta.dirname, "../../../helpers/python/teire_py.py");

const works = (bin: string, args: string[]) =>
  run(bin, args, { timeout: 15_000 }).then(
    () => true,
    () => false,
  );

/** griffe 2.4 needs Python 3.11 or newer. */
const PYTHON_OK = "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)";

async function pinnedVenv(): Promise<string | null> {
  const found = await Promise.all(
    ["python3.13", "python3.12", "python3.11", "python3", "python"].map(async (bin) =>
      (await works(bin, ["-c", PYTHON_OK])) ? bin : null,
    ),
  );
  const pythons = [...new Set(found.filter((b): b is string => Boolean(b)))];
  if (!pythons.length) return null;
  const pins = createHash("sha256").update(PYTHON.packages.join(" ")).digest("hex").slice(0, 12);
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "teire", `python-${pins}`);
  const bin = join(dir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const ready = join(dir, ".teire-ready");
  if (existsSync(ready)) return bin;
  // A Python that runs can still fail to make a venv (a broken install, no ensurepip): try the next.
  let failure = "";
  for (const python of pythons) {
    try {
      await run(python, ["-m", "venv", "--clear", dir], { timeout: 120_000 });
      await run(bin, ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", ...PYTHON.packages], {
        timeout: 300_000,
      });
      writeFileSync(ready, PYTHON.packages.join("\n"));
      return bin;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error);
      failure = `${python}: ${stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? "failed"}`;
    }
  }
  throw new Error(
    `could not set up a Python environment for the helper (${failure}). Install uv (https://docs.astral.sh/uv), or set TEIRE_PYTHON to a Python 3.11+ with ${PYTHON.packages.join(", ")}`,
  );
}

let chosen: Promise<[string, string[]]> | null = null;
function command(): Promise<[string, string[]]> {
  chosen ??= (async (): Promise<[string, string[]]> => {
    const python = process.env.TEIRE_PYTHON;
    if (python) return [python, ["-I", HELPER_PATH]];
    if (await works("uv", ["--version"]))
      return [
        "uv",
        [
          "run",
          "--no-project",
          "--python",
          PYTHON.version,
          ...PYTHON.packages.flatMap((p) => ["--with", p]),
          "python",
          "-I",
          HELPER_PATH,
        ],
      ];
    const venv = await pinnedVenv();
    if (venv) return [venv, ["-I", HELPER_PATH]];
    throw new Error(
      "Python projects need uv (https://docs.astral.sh/uv) or Python 3.11 or newer, and neither is installed",
    );
  })();
  chosen.catch(() => {
    chosen = null;
  });
  return chosen;
}

export async function runPythonHelper<T>(
  subcommand: string,
  args: string[],
  timeoutMs = PYTHON.helperTimeoutMs,
): Promise<T> {
  const [bin, base] = await command();
  const { stdout } = await run(bin, [...base, subcommand, ...args], {
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      ...(process.env.UV_CACHE_DIR ? { UV_CACHE_DIR: process.env.UV_CACHE_DIR } : {}),
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  const last = stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(last) as T;
}
