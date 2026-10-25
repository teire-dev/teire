import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OPENAPI } from "../constants";

const execFileAsync = promisify(execFile);

/** One item of `oasdiff breaking -f json` (shape seen on Stripe and OpenAI specs, v1.34.1). */
export interface OasdiffItem {
  id: string;
  text: string;
  /** 1 INFO, 2 WARN, 3 ERR. */
  level: number;
  operation?: string;
  path?: string;
  operationId?: string;
  section?: string;
}

/** `TEIRE_OASDIFF`, or `oasdiff` on PATH (the worker image installs the pinned release). */
export function oasdiffBinary() {
  return process.env.TEIRE_OASDIFF ?? "oasdiff";
}

/**
 * Breaking changes between two spec files, read by code. External `$ref`s are never fetched (an
 * untrusted spec could point them anywhere), `--open` and `--fetch` are never used, and the checks
 * that repeat one change through every expansion path are silenced.
 */
export async function oasdiffBreaking(basePath: string, revisionPath: string): Promise<OasdiffItem[]> {
  const scratch = await mkdtemp(join(tmpdir(), "teire-oasdiff-"));
  try {
    const levels = join(scratch, "levels.txt");
    await writeFile(levels, `${OPENAPI.silenced.map((id) => `${id} none`).join("\n")}\n`);
    const { stdout } = await execFileAsync(
      oasdiffBinary(),
      [
        "breaking",
        basePath,
        revisionPath,
        "-f",
        "json",
        "--allow-external-refs=false",
        "--flatten-allof",
        "--severity-levels",
        levels,
      ],
      { maxBuffer: 256 * 1024 * 1024, timeout: OPENAPI.timeoutMs },
    );
    const items = JSON.parse(stdout || "[]") as OasdiffItem[] | null;
    return (items ?? []).filter((i) => i.level >= OPENAPI.minLevel);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
