import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { RUST, SURFACE } from "../constants";
import { guardedFetch } from "../net/fetch";
import { cratesIndexLines } from "../registry/cargo";
import { parseSemverChecks, removedFeatures } from "./cargo";
import type { VerifyBackend } from "../verify/backend";
import type { SurfaceChange, SurfaceDiff } from "./types";

const run = promisify(execFile);

/**
 * Rust API-surface diff (plan S06, D57; research rust.md Job 4). Route A, in the worker: the
 * rustdoc JSON docs.rs built for both published versions, compared by cargo-semver-checks with
 * nothing compiled and no crate code run; both files must share a format version it supports.
 * When they do not, the diff needs Route B (compiling both versions, in the sandbox), and this
 * reports it unanalysable rather than "no change". Removed Cargo features come from the sparse
 * index either way (Job 4b): rustdoc JSON cannot see them.
 */
export function semverChecksBinary() {
  return process.env.TEIRE_CARGO_SEMVER_CHECKS ?? "cargo-semver-checks";
}

async function rustdocJson(name: string, version: string) {
  const res = await guardedFetch(`https://docs.rs/crate/${encodeURIComponent(name)}/${version}/json.gz`, {
    allowHosts: ["docs.rs", "static.docs.rs"],
    maxBytes: RUST.maxRustdocBytes,
    timeoutMs: 120_000,
  });
  if (res.status !== 200) return null;
  const text = gunzipSync(res.body).toString("utf8");
  const format = Number(
    /"format_version"\s*:\s*(\d+)/.exec(text.slice(-4096) + text.slice(0, 4096))?.[1] ?? 0,
  );
  return { text, format };
}

/**
 * Route B (research rust.md Job 4): compile both published versions in the Rust sandbox. The
 * target's `.crate` is the sandbox's starting tree; cargo-semver-checks downloads the baseline and
 * builds both (build scripts and proc-macros run there, never in the worker). ~110 s for a heavy crate.
 */
async function routeB(name: string, from: string, to: string, backend: VerifyBackend, runId: string) {
  const session = await backend.open(`${runId}-semver`, {
    tarball: { url: `https://static.crates.io/crates/${name}/${name}-${to}.crate` },
    image: "rust",
    instance: "standard-3",
  });
  try {
    const result = await session.run(
      "semver-checks",
      ["cargo", "semver-checks", "check-release", "--color", "never", "--baseline-version", from, "--release-type", "minor"],
      { cwd: "/work", env: { RUSTUP_AUTO_INSTALL: "0", CARGO_TERM_COLOR: "never" }, timeoutSec: RUST.routeBTimeoutSec },
    );
    if (result.exitCode !== 0 && result.exitCode !== 100)
      throw new Error(`cargo semver-checks exit ${result.exitCode}: ${(result.stderr || result.stdout).slice(-400)}`);
    return result.stdout + result.stderr;
  } finally {
    await session.close();
  }
}

export async function cargoSurfaceDiff(
  name: string,
  from: string,
  to: string,
  options: { backend?: VerifyBackend; runId?: string } = {},
): Promise<SurfaceDiff> {
  const started = Date.now();
  const notes: string[] = [];
  let changes: SurfaceChange[] = [];
  let unanalyzable = false;

  // Removed features, from the index lines of both versions.
  try {
    const lines = await cratesIndexLines(name);
    const line = (v: string) => lines.find((l) => l.vers === v);
    const a = line(from);
    const b = line(to);
    if (a && b)
      for (const f of removedFeatures({ ...a.features, ...a.features2 }, { ...b.features, ...b.features2 }))
        changes.push({
          path: `feature:${f}`,
          declKey: `feature:${f}`,
          kind: "removed",
          symbolKind: "module",
          severity: "breaking",
          before: null,
          after: null,
          guidance: "feature_missing: package feature removed or renamed (crates.io index)",
        });
  } catch (error) {
    notes.push(`index read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const [base, current] = await Promise.all([rustdocJson(name, from), rustdocJson(name, to)]);
  if (!base || !current) {
    unanalyzable = true;
    notes.push(
      `docs.rs has no rustdoc JSON for ${!base ? from : to}; the compiled comparison (sandbox) is needed`,
    );
  } else if (base.format !== current.format || !RUST.rustdocFormats.includes(base.format)) {
    unanalyzable = true;
    notes.push(
      `rustdoc JSON formats differ or are unsupported (v${base.format} vs v${current.format}; cargo-semver-checks ${RUST.semverChecksVersion} reads ${RUST.rustdocFormats.map((f) => `v${f}`).join(", ")}); the compiled comparison (sandbox) is needed`,
    );
  } else {
    const scratch = await mkdtemp(join(tmpdir(), "teire-rustdoc-"));
    try {
      await writeFile(join(scratch, "base.json"), base.text);
      await writeFile(join(scratch, "current.json"), current.text);
      // `--release-type minor`: otherwise a 0.x bump counts as major and every lint is skipped.
      const args = [
        "semver-checks",
        "check-release",
        "--color",
        "never",
        "--release-type",
        "minor",
        "-b",
        join(scratch, "base.json"),
        "-c",
        join(scratch, "current.json"),
      ];
      let output = "";
      try {
        const out = await run(semverChecksBinary(), args, {
          timeout: RUST.semverChecksTimeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        });
        output = out.stdout + out.stderr;
      } catch (error) {
        // Exit 100: checks failed, which is the normal case for a breaking release.
        const e = error as { code?: number; stdout?: string; stderr?: string };
        if (e.code !== 100) throw error;
        output = (e.stdout ?? "") + (e.stderr ?? "");
      }
      changes = [...changes, ...parseSemverChecks(output)];
      notes.push(
        `cargo-semver-checks ${RUST.semverChecksVersion} on docs.rs rustdoc JSON v${base.format} (all features docs.rs builds)`,
      );
    } catch (error) {
      unanalyzable = true;
      notes.push(
        `cargo-semver-checks failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  if (unanalyzable && options.backend) {
    try {
      changes = [...changes, ...parseSemverChecks(await routeB(name, from, to, options.backend, options.runId ?? `diff-${Date.now().toString(36)}`))];
      unanalyzable = false;
      notes.push(`cargo-semver-checks ${RUST.semverChecksVersion}, both versions compiled in the Rust sandbox (default features)`);
    } catch (error) {
      notes.push(`compiled comparison failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    }
  }
  const counts: SurfaceDiff["counts"] = {};
  for (const c of changes) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  const side = {
    source: { kind: "bundled" as const },
    symbols: 0,
    truncated: false,
    ms: Date.now() - started,
    integrity: "",
  };
  return {
    ecosystem: "cargo",
    name,
    fromVersion: from,
    toVersion: to,
    from: side,
    to: side,
    changes,
    counts,
    moved: {},
    unanalyzable,
    notes,
    tool: {
      name: "cargo-semver-checks",
      version: RUST.semverChecksVersion,
      noiseFilterVersion: SURFACE.noiseFilterVersion,
    },
  };
}
