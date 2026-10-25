import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PYTHON } from "../constants";

const run = promisify(execFile);

/**
 * Runs Teire's Python helper (`packages/helpers/python/teire_py.py`) and parses its JSON (plan S03).
 * In the worker image the helper has its own venv (`TEIRE_PYTHON`, packaging + griffe + jedi
 * pinned); in development uv supplies the same pins. `-I` keeps the interpreter from importing
 * anything from the current directory or the code it reads.
 */
export const HELPER_PATH =
  process.env.TEIRE_PY_HELPER ?? resolve(import.meta.dirname, "../../../helpers/python/teire_py.py");

function command(): [string, string[]] {
  const python = process.env.TEIRE_PYTHON;
  if (python) return [python, ["-I", HELPER_PATH]];
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
}

export async function runPythonHelper<T>(
  subcommand: string,
  args: string[],
  timeoutMs = PYTHON.helperTimeoutMs,
): Promise<T> {
  const [bin, base] = command();
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
