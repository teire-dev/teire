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

export async function cargoSurfaceDiff(name: string, from: string, to: string): Promise<SurfaceDiff> {
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
