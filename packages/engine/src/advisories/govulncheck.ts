import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { GO } from "../constants";
import type { CallSite } from "../contract";
import { goBinary, goEnv, scratchHome } from "../golang/toolchain";

const run = promisify(execFile);

/**
 * Go advisory reachability (plan S05, research go.md Job 9): govulncheck builds the call graph from
 * the repo's own packages and reports, per advisory, the most precise level it can prove:
 *  - called: a path from the repo's code reaches the vulnerable function (with that path);
 *  - imported: the vulnerable package is imported, the function is not reached;
 *  - required: the module is in go.mod, the package is not imported.
 * It type-checks and analyses; it runs nothing (D88 safe mode, `-modfile` on a scratch copy).
 */
export type GoVulnLevel = "called" | "imported" | "required";

export interface GoVulnReach {
  level: GoVulnLevel;
  fixedVersion: string | null;
  /** Where the repo's code calls into the path (called only). */
  sites: CallSite[];
  /** The vulnerable symbol (`language.ParseAcceptLanguage`). */
  symbol: string | null;
}

interface Frame {
  module?: string;
  version?: string;
  package?: string;
  function?: string;
  receiver?: string;
  position?: { filename?: string; line?: number; column?: number };
}

async function binary() {
  if (process.env.TEIRE_GOVULNCHECK) return process.env.TEIRE_GOVULNCHECK;
  const bin = join(homedir(), ".cache", "teire", `govulncheck-${GO.govulncheckVersion}`);
  if (existsSync(bin)) return bin;
  const dir = await mkdtemp(join(tmpdir(), "teire-govulncheck-"));
  try {
    await mkdir(dirname(bin), { recursive: true });
    await run(goBinary(), ["install", `golang.org/x/vuln/cmd/govulncheck@${GO.govulncheckVersion}`], {
      env: { ...goEnv(dir), GOBIN: dir, GOFLAGS: "-modcacherw" },
      timeout: 300_000,
    });
    await copyFile(join(dir, "govulncheck"), bin);
    return bin;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every advisory govulncheck relates to the module, keyed by its OSV id and each alias (GHSA, CVE). */
export async function goVulnReachability(repoDir: string, projectRoot: string, module: string) {
  const dir = join(repoDir, projectRoot);
  const home = await scratchHome();
  const scratch = await mkdtemp(join(tmpdir(), "teire-govuln-"));
  const out = new Map<string, GoVulnReach>();
  try {
    await copyFile(join(dir, "go.mod"), join(scratch, "go.mod"));
    await copyFile(join(dir, "go.sum"), join(scratch, "go.sum")).catch(() => undefined);
    const env = { ...goEnv(home), GOFLAGS: `-mod=mod -modcacherw -modfile=${join(scratch, "go.mod")}` };
    let stdout = "";
    try {
      ({ stdout } = await run(await binary(), ["-json", "./..."], {
        cwd: dir,
        env,
        timeout: GO.helperTimeoutMs,
        maxBuffer: 256 * 1024 * 1024,
      }));
    } catch (error) {
      // JSON mode exits 0 when it ran; a non-zero exit is a load failure, reported as no reachability.
      stdout = (error as { stdout?: string }).stdout ?? "";
      if (!stdout.includes('"config"')) throw error;
    }
    const aliases = new Map<string, string[]>();
    const rank: Record<GoVulnLevel, number> = { called: 0, imported: 1, required: 2 };
    // The output is a stream of indented JSON objects.
    for (const chunk of stdout.split(/\n(?=\{)/)) {
      let msg: {
        osv?: { id: string; aliases?: string[] };
        finding?: { osv: string; fixed_version?: string; trace?: Frame[] };
      };
      try {
        msg = JSON.parse(chunk);
      } catch {
        continue;
      }
      if (msg.osv) aliases.set(msg.osv.id, msg.osv.aliases ?? []);
      const f = msg.finding;
      if (!f?.trace?.length) continue;
      const top = f.trace[0] as Frame;
      const level: GoVulnLevel = top.function ? "called" : top.package ? "imported" : "required";
      const sites: CallSite[] = [];
      if (level === "called")
        for (const frame of f.trace)
          if (frame.module === module && frame.position?.filename && frame.position.line) {
            const file = frame.position.filename.startsWith(dir)
              ? frame.position.filename.slice(dir.length + 1)
              : frame.position.filename;
            sites.push({
              file: projectRoot === "." ? file : `${projectRoot}/${file}`,
              line: frame.position.line,
              column: frame.position.column ?? 1,
              kind: "call",
              snippet: `${frame.receiver ? `${frame.receiver}.` : ""}${frame.function ?? ""}`,
              resolution: "traced",
            });
            break;
          }
      const reach: GoVulnReach = {
        level,
        fixedVersion: f.fixed_version ?? null,
        sites,
        symbol: top.function
          ? `${top.package?.split("/").at(-1) ?? ""}.${top.receiver ? `${top.receiver}.` : ""}${top.function}`
          : null,
      };
      for (const key of [f.osv, ...(aliases.get(f.osv) ?? [])]) {
        const held = out.get(key);
        if (!held || rank[level] < rank[held.level]) out.set(key, reach);
        else if (held.level === "called" && level === "called") held.sites.push(...sites);
      }
    }
    return out;
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}
