import { dirname, join } from "node:path";
import YAML from "yaml";
import type { RustProject } from "../inventory/rust";
import type { RepoTree } from "../inventory/tree";
import type { CheckPlan, PlannedCheck } from "./commands";
import { rustFor, rustToolchainBin, SANDBOX_PATH } from "./toolchains";

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

/**
 * `cargo fetch --locked`; when the committed Cargo.lock is behind Cargo.toml, Cargo refuses ("cannot
 * update the lock file … because --locked was passed", or in other versions "… needs to be updated but
 * --locked was passed") and the repo's own `cargo build` would bring
 * the lock up to date, so the fetch does that and says so. The checks then run `--locked` against it
 * (live walk on teire-dev/rizzler, 2026-10-28: its lock was behind, and there was no baseline).
 */
const FETCH = `out=$(cargo fetch --locked 2>&1); status=$?; printf '%s\\n' "$out"; if [ "$status" -ne 0 ] && printf '%s' "$out" | grep -q -e '--locked was passed'; then echo 'teire: Cargo.lock is behind Cargo.toml; fetching as cargo build does, which brings it up to date'; cargo fetch; else exit "$status"; fi`;

/**
 * Where rustup and cargo keep toolchains and the crates the install fetched. exec() does not pass
 * the image's ENV, so both phases name them: the offline checks must read the cache the install
 * filled (a fetch into one home and a build from another finds no crates). Cargo's home is the
 * check user's (the checks run unprivileged and cargo locks its cache even offline); toolchains
 * stay in the image's rustup home, read-only to the checks.
 */
const HOMES = { RUSTUP_HOME: "/usr/local/rustup", CARGO_HOME: "/home/teire/.cargo" };

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
  // A rust-toolchain pin is fetched with rustup during the install, then put first on PATH (D-47).
  const toolchain = rustFor(tree, root);
  const rustPath: Record<string, string> = toolchain
    ? { PATH: `${rustToolchainBin(toolchain.version)}:${SANDBOX_PATH}` }
    : {};
  if (toolchain) notes.push(`Rust ${toolchain.version} from ${toolchain.source}`);
  return {
    manager: "cargo",
    image: "rust",
    instance: "standard-3",
    cwd: root === "." ? sandboxRoot : join(sandboxRoot, root),
    install: [
      "sh",
      "-c",
      toolchain
        ? `rustup toolchain install ${toolchain.version} --profile minimal || exit $?; ${FETCH}`
        : FETCH,
    ],
    installEnv: { CARGO_TERM_COLOR: "never", RUSTUP_AUTO_INSTALL: "0", ...HOMES, ...rustPath },
    env: { ...OFFLINE_ENV, ...HOMES, ...rustPath },
    checks,
    provenOffline: true,
    notes,
  };
}
