import { dirname, join } from "node:path";
import YAML from "yaml";
import type { RustProject } from "../inventory/rust";
import type { RepoTree } from "../inventory/tree";
import type { CheckPlan, PlannedCheck } from "./commands";

/**
 * What to run for a Cargo workspace (plan S06, research rust.md Job 8): `cargo fetch --locked`
 * online, then with the network off (`--offline`, CARGO_NET_OFFLINE): build and test the
 * workspace, `--locked` so a check never rewrites Cargo.lock. `--all-targets` is not used blindly
 * (nightly-only benches break it on stable). RUSTUP_AUTO_INSTALL=0 keeps a repo's
 * rust-toolchain.toml from installing another toolchain. Compiled ecosystems get `standard-3`.
 */
const OFFLINE_ENV = {
  CARGO_NET_OFFLINE: "true",
  CARGO_TERM_COLOR: "never",
  RUSTUP_AUTO_INSTALL: "0",
  CARGO_INCREMENTAL: "0",
};

function ciFeatures(tree: RepoTree) {
  for (const file of tree.files().filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))) {
    let doc: { jobs?: Record<string, { steps?: { run?: string }[] }> };
    try {
      doc = (YAML.parse(tree.read(file) ?? "") ?? {}) as typeof doc;
    } catch {
      continue;
    }
    for (const job of Object.values(doc.jobs ?? {}))
      for (const step of job.steps ?? []) {
        const m = /\bcargo test\b([^\n&|;]*)/.exec(step.run ?? "");
        if (m && /--all-features\b/.test(m[1] ?? "")) return ["--all-features"];
        const f = /--features[= ]("?)([\w,-]+)\1/.exec(m?.[1] ?? "");
        if (f?.[2]) return ["--features", f[2]];
      }
  }
  return [];
}

export function detectRustChecks(tree: RepoTree, project: RustProject, sandboxRoot = "/work"): CheckPlan {
  const notes = [...project.notes];
  const features = ciFeatures(tree);
  if (features.length) notes.push(`features from CI: ${features.join(" ")}`);
  const checks: PlannedCheck[] = [
    {
      name: "build",
      argv: ["cargo", "build", "--workspace", "--locked", "--offline", ...features],
      source: "default",
    },
    {
      name: "test",
      argv: ["cargo", "test", "--workspace", "--locked", "--offline", "--no-fail-fast", ...features],
      source: "default",
    },
  ];
  const root = dirname(project.manifest);
  return {
    manager: "cargo",
    image: "rust",
    instance: "standard-3",
    cwd: root === "." ? sandboxRoot : join(sandboxRoot, root),
    install: ["cargo", "fetch", "--locked"],
    installEnv: { CARGO_TERM_COLOR: "never", RUSTUP_AUTO_INSTALL: "0" },
    env: OFFLINE_ENV,
    checks,
    provenOffline: true,
    notes,
  };
}
