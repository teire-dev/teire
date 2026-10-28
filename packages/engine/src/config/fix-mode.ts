import type { TeireConfig } from "./index";

/**
 * Fix mode (plan revision 3.3, D118, D124, D125): Automatic, Ask first or Off, per repository with an
 * installation default. One resolver decides, first match wins:
 *   1. the repository's `.github/teire.yml` `fixes:`;
 *   2. the dashboard's per-repository override (`repos.fix_mode`);
 *   3. the organisation's `teire-config` file's `fixes:`;
 *   4. the installation default (`installations.default_fix_mode`);
 *   5. automatic.
 * Security fixes have their own setting (automatic unless a file or the installation says ask);
 * they never run when fixes are off.
 */
export type FixMode = "auto" | "ask" | "off";
export type FixModeOrigin = "repo-file" | "dashboard" | "org-file" | "installation" | "default";

export interface EffectiveFixMode {
  mode: FixMode;
  origin: FixModeOrigin;
  /** The file that decided, when one did (`.github/teire.yml`, `teire-config/teire.yml`). */
  file: string | null;
  security: { mode: "auto" | "ask"; origin: FixModeOrigin };
}

const FROM_FILE = { automatic: "auto", ask: "ask", off: "off" } as const;

export function effectiveFixMode(input: {
  config: Pick<TeireConfig, "fixes" | "securityFixes" | "origins" | "path"> | null;
  repoOverride: FixMode | null;
  installationDefault: FixMode | null;
  installationSecurity?: "auto" | "ask" | null;
  orgFile?: string;
}): EffectiveFixMode {
  const config = input.config;
  const fileOrigin = config?.fixes ? config.origins.fixes : undefined;
  const pick = (): Omit<EffectiveFixMode, "security"> => {
    if (config?.fixes && fileOrigin === "repo")
      return { mode: FROM_FILE[config.fixes], origin: "repo-file", file: config.path ?? ".github/teire.yml" };
    if (input.repoOverride) return { mode: input.repoOverride, origin: "dashboard", file: null };
    if (config?.fixes && fileOrigin === "org")
      return {
        mode: FROM_FILE[config.fixes],
        origin: "org-file",
        file: input.orgFile ?? "teire-config/teire.yml",
      };
    if (input.installationDefault)
      return { mode: input.installationDefault, origin: "installation", file: null };
    return { mode: "auto", origin: "default", file: null };
  };
  const securityOrigin = config?.securityFixes ? config.origins.securityFixes : undefined;
  const security: EffectiveFixMode["security"] =
    config?.securityFixes && securityOrigin
      ? {
          mode: FROM_FILE[config.securityFixes] as "auto" | "ask",
          origin: securityOrigin === "repo" ? "repo-file" : "org-file",
        }
      : input.installationSecurity
        ? { mode: input.installationSecurity, origin: "installation" }
        : { mode: "auto", origin: "default" };
  return { ...pick(), security };
}

/** Whether Teire may start a run on its own (a scan, a refresh) for a change of this kind. */
export function startsOnItsOwn(mode: EffectiveFixMode, security: boolean) {
  if (mode.mode === "off") return false;
  if (security) return mode.security.mode === "auto";
  return mode.mode === "auto";
}

/** A person asking (Fix now, `@teire fix`) runs unless fixes are off. */
export function personMayStart(mode: EffectiveFixMode) {
  return mode.mode !== "off";
}

/** How the mode is said with its origin: "Off (set in .github/teire.yml)". */
export function describeFixMode(mode: EffectiveFixMode) {
  const name = { auto: "Automatic", ask: "Ask first", off: "Off" }[mode.mode];
  const where = {
    "repo-file": `set in ${mode.file}`,
    dashboard: "set on the dashboard",
    "org-file": `set in ${mode.file}`,
    installation: "the installation's default",
    default: "the default",
  }[mode.origin];
  return `${name} (${where})`;
}
