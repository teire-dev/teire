import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallSite } from "../contract";
import { runGoHelper, scratchHome } from "../golang/toolchain";
import type { Hit, LocateResult } from "./ts";

/**
 * Go uses of a module's API, type-resolved (plan S05, research go.md Job 5): Teire's helper loads
 * the repo's packages (tests included) with go/packages and walks `types.Info.Uses`, naming each
 * object the way apidiff does, so a use joins a change on the same key (`StandardClaims`,
 * `(*Client).CreateChatCompletion`, `./request.ParseFromRequest`). It type-checks; it runs nothing
 * (D88: the same Go safe mode as the diff). go.mod is read through `-modfile` on a scratch copy.
 */
interface HelperUse {
  file: string;
  line: number;
  col: number;
  module: string;
  pkg: string;
  symbol: string;
  kind: "func" | "method" | "field" | "var" | "const" | "type";
  constValue?: string;
  /** Arguments at the call this use names; -1 for `f(xs...)`. */
  argCount?: number;
}

const KIND: Record<HelperUse["kind"], CallSite["kind"]> = {
  func: "call",
  method: "call",
  field: "property",
  var: "property",
  const: "property",
  type: "type-ref",
};

export async function locateGo(input: {
  repoDir: string;
  projectRoot: string;
  /** The module path the repo imports today (`github.com/golang-jwt/jwt/v4`). */
  modulePath: string;
  declKeys: ReadonlySet<string>;
}): Promise<LocateResult & { constants: { file: string; line: number; symbol: string; value: string }[] }> {
  const started = Date.now();
  const home = await scratchHome();
  const scratch = await mkdtemp(join(tmpdir(), "teire-golocate-"));
  const dir = join(input.repoDir, input.projectRoot);
  try {
    await copyFile(join(dir, "go.mod"), join(scratch, "go.mod"));
    await copyFile(join(dir, "go.sum"), join(scratch, "go.sum")).catch(() => undefined);
    // `-modfile`: the module's own go.mod and go.sum are never rewritten (they would join a fix's diff).
    const result = await runGoHelper<{
      uses: HelperUse[];
      files: number;
      errors: string[];
      unresolved?: number;
      errorPackages?: number;
      /** Files build constraints leave out on the worker's platform that import a target. */
      constrained?: number;
    }>("locate", ["-dir", dir, "-targets", input.modulePath, "-modfile", join(scratch, "go.mod")], dir, home);
    const hits: Hit[] = [];
    const lines = new Map<string, string[]>();
    const snippet = async (file: string, line: number) => {
      if (!lines.has(file)) {
        lines.set(file, (await readFile(join(dir, file), "utf8").catch(() => "")).split("\n"));
      }
      return (lines.get(file)?.[line - 1] ?? "").trim().slice(0, 200);
    };
    const uses = result.uses ?? [];
    const errors = result.errors ?? [];
    for (const u of uses) {
      if (!input.declKeys.has(u.symbol)) continue;
      const file = input.projectRoot === "." ? u.file : `${input.projectRoot}/${u.file}`;
      hits.push({
        file,
        line: u.line,
        column: u.col,
        kind: /_test\.go$/.test(u.file) ? "test" : KIND[u.kind],
        snippet: await snippet(u.file, u.line),
        resolution: "type",
        declKey: u.symbol,
        ...(u.argCount !== undefined && u.argCount >= 0 ? { argCount: u.argCount } : {}),
      });
    }
    return {
      hits,
      imports: [],
      constants: uses.flatMap((u) =>
        u.constValue !== undefined
          ? [{ file: u.file, line: u.line, symbol: u.symbol, value: u.constValue }]
          : [],
      ),
      ms: Date.now() - started,
      coverage: {
        filesScanned: result.files,
        filesSkipped: [
          ...(result.errorPackages
            ? [
                {
                  reason: `${result.errorPackages} package(s) did not type-check`,
                  count: result.errorPackages,
                },
              ]
            : []),
          ...(errors.length ? [{ reason: "type errors while loading", count: errors.length }] : []),
          ...(result.constrained
            ? [{ reason: "files other platforms' build constraints select", count: result.constrained }]
            : []),
        ],
        languages: ["go"],
        resolutionLevel: "type",
        // What the type checker couldn't resolve keeps the verdict from "not affected" (S19).
        unresolvedSites: (result.unresolved ?? 0) + (result.errorPackages ?? 0) + (result.constrained ?? 0),
        transitiveAnalysed: false,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}
