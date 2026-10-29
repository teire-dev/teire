import {
  type EffectiveFixMode,
  effectiveFixMode,
  type FixMode,
  type TeireConfig,
} from "@teire/engine/config";

/**
 * A repository's effective fix mode (D118, D124), read the way the worker reads it: the repo's
 * `.github/teire.yml`, the dashboard override, the org file, the installation default, Automatic.
 */
export function repoFixMode(
  repo: { config: unknown; fixMode: FixMode | null; fullName: string },
  installation: { defaultFixMode: FixMode | null; securityFixMode: "auto" | "ask" | null } | null,
): EffectiveFixMode {
  return effectiveFixMode({
    config: (repo.config as TeireConfig | null) ?? null,
    repoOverride: repo.fixMode,
    installationDefault: installation?.defaultFixMode ?? null,
    installationSecurity: installation?.securityFixMode ?? null,
    orgFile: `${repo.fullName.split("/")[0]}/teire-config/teire.yml`,
  });
}

/** Each dashboard-editable `teire.yml` key's value in a resolved config, by dotted path (the Config forms). */
export function configCurrent(config: unknown, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.map((k) => [
      k,
      k
        .split(".")
        .reduce<unknown>(
          (o, part) => (o && typeof o === "object" ? (o as Record<string, unknown>)[part] : undefined),
          config,
        ),
    ]),
  );
}
