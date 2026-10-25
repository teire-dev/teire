import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPythonHelper } from "../python/helper";
import type { Hit, LocateResult } from "./ts";

/**
 * Python call sites (plan S03, research python.md §6): jedi in worker-safe mode (the installed
 * version's unpacked wheel on `added_sys_path`, no venv interpreter, no compiled modules imported)
 * resolves each identifier a change names to its canonical definition, which is griffe's path. Each
 * call also reports the keyword arguments it passes, so a removed keyword only flags calls that use
 * it. Look-alikes resolve to the repo's own code and are dropped.
 */
interface HelperHit {
  file: string;
  line: number;
  column: number;
  name: string;
  fullNames: string[];
  snippet: string;
  kind: "call" | "import" | "property";
  argCount?: number;
  kwargs?: string[];
}

export async function locatePython(input: {
  repoDir: string;
  projectRoot: string;
  /** Import names the package provides (`anthropic`, `google.genai`). */
  packages: string[];
  siteDirs: string[];
  declKeys: ReadonlySet<string>;
  names: ReadonlySet<string>;
}): Promise<LocateResult> {
  const started = Date.now();
  const scratch = await mkdtemp(join(tmpdir(), "teire-refs-"));
  try {
    const namesFile = join(scratch, "names.json");
    await writeFile(namesFile, JSON.stringify({ names: [...input.names], packages: input.packages }));
    const result = await runPythonHelper<{
      hits: HelperHit[];
      unresolved: number;
      filesScanned: number;
      filesSkipped: number;
    }>("resolve-refs", [input.repoDir, input.projectRoot, namesFile, ...input.siteDirs]);
    const hits: Hit[] = [];
    const seen = new Set<string>();
    for (const h of result.hits) {
      const declKey = h.fullNames.find((f) => input.declKeys.has(f));
      if (!declKey) continue;
      const key = `${h.file}:${h.line}:${declKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        file: h.file,
        line: h.line,
        column: h.column,
        kind: h.kind,
        snippet: h.snippet,
        resolution: "type",
        declKey,
        ...(h.argCount !== undefined ? { argCount: h.argCount } : {}),
        ...(h.kwargs ? { kwargs: h.kwargs } : {}),
      });
    }
    return {
      hits,
      imports: [],
      ms: Date.now() - started,
      coverage: {
        filesScanned: result.filesScanned,
        filesSkipped: result.filesSkipped
          ? [{ reason: "unreadable or not valid Python", count: result.filesSkipped }]
          : [],
        languages: ["python"],
        resolutionLevel: "type",
        unresolvedSites: result.unresolved,
        transitiveAnalysed: false,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
