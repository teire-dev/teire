import { parse as parseToml } from "smol-toml";
import YAML from "yaml";
import { REGISTRY } from "../constants";
import type { TargetPolicy } from "../registry/target";
import { npmScheme } from "../registry/versions";
import type { JsProject } from "./js";
import type { RepoTree } from "./tree";

/**
 * What a JS repo itself says about which versions may be installed, read before Teire picks an
 * upgrade target (plan D71: honour pins). Two kinds:
 *  - release-age gates: the repo's package manager refuses versions younger than this, so a target
 *    inside the gate would fail lockfile regeneration;
 *  - pins: overrides / resolutions that force a package to a range.
 * Setting names and units come from each tool's docs: pnpm `minimumReleaseAge` (minutes,
 * pnpm-workspace.yaml; default 1440 since v11), npm `min-release-age` (days, .npmrc), yarn
 * `npmMinimalAgeGate` (minutes or a duration such as "3d", .yarnrc.yml), bun
 * `install.minimumReleaseAge` (seconds, bunfig.toml).
 */
export interface ReleaseAgeGate {
  minutes: number;
  /** File and key, e.g. `pnpm-workspace.yaml minimumReleaseAge`. */
  source: string;
  /** Names, globs or `name@range` entries exempt from this gate. */
  exclude: string[];
}

export interface Pin {
  name: string;
  /** The forced specifier, as written. */
  value: string;
  source: string;
  /** Version selector in the key (`foo@<2`): the pin applies only when the current version matches. */
  selector?: string;
  /** Parent package the pin is scoped under (`parent>foo`, `parent/foo`, nested npm overrides). */
  parent?: string;
}

export interface JsUpgradePolicy {
  gates: ReleaseAgeGate[];
  pins: Pin[];
  notes: string[];
}

const join = (dir: string, file: string) => (dir === "." || dir === "" ? file : `${dir}/${file}`);

/** `@scope/pkg@^1` → { name: "@scope/pkg", selector: "^1" }. */
function splitKey(key: string) {
  const at = key.lastIndexOf("@");
  if (at > 0) return { name: key.slice(0, at), selector: key.slice(at + 1) };
  return { name: key };
}

function withSelector(pin: Pin, selector?: string): Pin {
  // berry descriptors (`foo@npm:1.2.3`) select one locked descriptor; keep the range part.
  const clean = selector?.replace(/^npm:/, "");
  return clean ? { ...pin, selector: clean } : pin;
}

/** npm `overrides`: plain keys, `name@range` keys, nested objects, `"."` for the package itself. */
function npmOverrides(value: unknown, source: string, parent: string | undefined, out: Pin[]) {
  if (!value || typeof value !== "object") return;
  for (const [key, spec] of Object.entries(value as Record<string, unknown>)) {
    if (key === ".") continue;
    const { name, selector } = splitKey(key);
    if (typeof spec === "string") {
      out.push(withSelector({ name, value: spec, source, ...(parent ? { parent } : {}) }, selector));
    } else if (spec && typeof spec === "object") {
      const self = (spec as Record<string, unknown>)["."];
      if (typeof self === "string")
        out.push(withSelector({ name, value: self, source, ...(parent ? { parent } : {}) }, selector));
      npmOverrides(spec, source, name, out);
    }
  }
}

/** pnpm `overrides`: `foo`, `foo@<2`, `parent>foo`, `parent@1>foo`. */
function pnpmOverrides(value: unknown, source: string, out: Pin[]) {
  if (!value || typeof value !== "object") return;
  for (const [key, spec] of Object.entries(value as Record<string, unknown>)) {
    if (typeof spec !== "string") continue;
    const parts = key.split(">");
    const { name, selector } = splitKey(parts[parts.length - 1] ?? key);
    const parent = parts.length > 1 ? splitKey(parts[parts.length - 2] ?? "").name : undefined;
    out.push(withSelector({ name, value: spec, source, ...(parent ? { parent } : {}) }, selector));
  }
}

/** yarn `resolutions`: `foo`, `parent/foo`, globstar parents, `@s/parent/@s/foo`, `foo@npm:1.0.0`. */
function yarnResolutions(value: unknown, source: string, out: Pin[]) {
  if (!value || typeof value !== "object") return;
  for (const [key, spec] of Object.entries(value as Record<string, unknown>)) {
    if (typeof spec !== "string") continue;
    const raw = key.split("/");
    const segments: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const part = raw[i] ?? "";
      if (part.startsWith("@") && i + 1 < raw.length) segments.push(`${part}/${raw[++i]}`);
      else segments.push(part);
    }
    const { name, selector } = splitKey(segments[segments.length - 1] ?? key);
    const parents = segments.slice(0, -1).filter((s) => s !== "**");
    const parent = parents.length ? splitKey(parents[parents.length - 1] ?? "").name : undefined;
    out.push(withSelector({ name, value: spec, source, ...(parent ? { parent } : {}) }, selector));
  }
}

/** `.npmrc` is ini: `key=value`, `;` and `#` comments. */
function readIni(text: string) {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

const DURATION_MINUTES: Record<string, number> = {
  ms: 1 / 60_000,
  s: 1 / 60,
  m: 1,
  h: 60,
  d: 1440,
  w: 10_080,
};

/** yarn duration: a number of minutes, or `"<n><unit>"` with ms|s|m|h|d|w (yarn's own grammar). */
function yarnDurationMinutes(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const match = /^(\d*\.?\d+)(ms|s|m|h|d|w)?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * (DURATION_MINUTES[match[2] ?? "m"] ?? 1);
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function majorOf(version: string | undefined) {
  const n = Number.parseInt(version ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

export function readJsUpgradePolicy(tree: RepoTree, project: JsProject): JsUpgradePolicy {
  const { root } = project;
  const policy: JsUpgradePolicy = { gates: [], pins: [], notes: [] };
  const readYaml = (file: string) => {
    const text = tree.read(join(root, file));
    if (text === null) return null;
    try {
      return YAML.parse(text) as Record<string, unknown> | null;
    } catch {
      policy.notes.push(`unreadable ${file}`);
      return null;
    }
  };

  const manifestText = tree.read(join(root, "package.json"));
  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = manifestText ? (JSON.parse(manifestText) as Record<string, unknown>) : null;
  } catch {
    policy.notes.push("unreadable package.json");
  }
  if (manifest) {
    npmOverrides(manifest.overrides, "package.json overrides", undefined, policy.pins);
    pnpmOverrides(
      (manifest.pnpm as Record<string, unknown> | undefined)?.overrides,
      "package.json pnpm.overrides",
      policy.pins,
    );
    yarnResolutions(manifest.resolutions, "package.json resolutions", policy.pins);
  }

  const workspace = readYaml("pnpm-workspace.yaml");
  if (workspace) {
    pnpmOverrides(workspace.overrides, "pnpm-workspace.yaml overrides", policy.pins);
    if (typeof workspace.minimumReleaseAge === "number")
      policy.gates.push({
        minutes: workspace.minimumReleaseAge,
        source: "pnpm-workspace.yaml minimumReleaseAge",
        exclude: strings(workspace.minimumReleaseAgeExclude),
      });
  }
  if (
    project.manager === "pnpm" &&
    !policy.gates.some((g) => g.source.startsWith("pnpm")) &&
    (majorOf(project.managerVersion) ?? 0) >= 11
  ) {
    policy.gates.push({
      minutes: 1440,
      source: `pnpm ${project.managerVersion} default minimumReleaseAge`,
      exclude: strings(workspace?.minimumReleaseAgeExclude),
    });
  }

  for (const dir of new Set([root, "."])) {
    const npmrc = tree.read(join(dir, ".npmrc"));
    if (npmrc === null) continue;
    const ini = readIni(npmrc);
    const days = Number(ini.get("min-release-age"));
    if (Number.isFinite(days) && days > 0)
      policy.gates.push({
        minutes: days * 1440,
        source: `${join(dir, ".npmrc")} min-release-age`,
        exclude: [],
      });
    const minutes = Number(ini.get("minimum-release-age"));
    if (Number.isFinite(minutes) && minutes > 0)
      policy.gates.push({ minutes, source: `${join(dir, ".npmrc")} minimum-release-age`, exclude: [] });
  }

  const yarnrc = readYaml(".yarnrc.yml");
  if (yarnrc && yarnrc.npmMinimalAgeGate !== undefined) {
    const minutes = yarnDurationMinutes(yarnrc.npmMinimalAgeGate);
    if (minutes !== null)
      policy.gates.push({
        minutes,
        source: ".yarnrc.yml npmMinimalAgeGate",
        exclude: strings(yarnrc.npmPreapprovedPackages),
      });
    else policy.notes.push(`unreadable npmMinimalAgeGate: ${String(yarnrc.npmMinimalAgeGate)}`);
  }

  const bunfig = tree.read(join(root, "bunfig.toml"));
  if (bunfig !== null) {
    try {
      const install = (parseToml(bunfig) as { install?: Record<string, unknown> }).install;
      if (typeof install?.minimumReleaseAge === "number")
        policy.gates.push({
          minutes: install.minimumReleaseAge / 60,
          source: "bunfig.toml install.minimumReleaseAge",
          exclude: strings(install.minimumReleaseAgeExcludes),
        });
    } catch {
      policy.notes.push("unreadable bunfig.toml");
    }
  }
  return policy;
}

// --- target policy ----------------------------------------------------------------------------

function globMatch(pattern: string, name: string) {
  if (!pattern.includes("*")) return pattern === name;
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(name);
}

/** Gate exclusions: a name, a glob (`@scope/*`), or `name@range` exempting matching versions only (bun). */
function exempt(entry: string, name: string, version: string) {
  const { name: pattern, selector } = splitKey(entry);
  if (!globMatch(pattern, name)) return false;
  if (!selector) return true;
  const range = selector.replace(/^npm:/, "");
  return npmScheme.isRange(range) && npmScheme.satisfies(version, range);
}

export interface JsTargetOptions {
  now?: Date;
  /** Teire's own cooldown (`upgrades.cooldownDays` in teire.yml); defaults to `REGISTRY.cooldownDays`. */
  cooldownDays?: number;
  fallbackMajors?: number;
}

/**
 * Turns the repo's gates and pins into the policy for one direct dependency. Teire's cooldown always
 * applies; a repo gate applies on top unless it exempts the package. Pins scoped under a parent
 * package and `$name` references do not constrain a direct upgrade.
 */
export function jsTargetPolicy(
  policy: JsUpgradePolicy,
  name: string,
  current: string,
  options: JsTargetOptions = {},
): TargetPolicy {
  const teireMinutes = (options.cooldownDays ?? REGISTRY.cooldownDays) * 1440;
  const pins = policy.pins
    .filter(
      (p) =>
        p.name === name &&
        !p.parent &&
        !p.value.startsWith("$") &&
        p.value !== "-" &&
        (!p.selector || (npmScheme.isRange(p.selector) && npmScheme.satisfies(current, p.selector))),
    )
    .map((p) => ({ value: p.value, source: p.source }));
  return {
    now: options.now ?? new Date(),
    minAgeMinutes: (version) =>
      Math.max(
        teireMinutes,
        ...policy.gates.filter((g) => !g.exclude.some((e) => exempt(e, name, version))).map((g) => g.minutes),
      ),
    pins,
    allowPrerelease: npmScheme.valid(current) && npmScheme.isPrerelease(current),
    fallbackMajors: options.fallbackMajors ?? 0,
  };
}
