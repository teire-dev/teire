import YAML from "yaml";
import { PULL_REQUESTS, REGISTRY } from "../constants";
import type { RepoTree } from "../inventory/tree";

/**
 * `.github/teire.yml` (card C8): the keys S02b acts on, read leniently. Unknown keys and wrong
 * types fall back to the defaults and are listed in `problems`; the JSON Schema, org-level config
 * and the validation check run come with S09.
 */
export interface TeireConfig {
  present: boolean;
  path: string | null;
  upgrades: { majors: boolean; plainBumps: boolean; cooldownDays: number };
  pullRequests: { limit: number; perHour: number };
  dashboardIssue: boolean;
  ignore: string[];
  problems: string[];
}

export const CONFIG_PATHS = [".github/teire.yml", ".github/teire.yaml"] as const;

export function readTeireConfig(tree: RepoTree): TeireConfig {
  const config: TeireConfig = {
    present: false,
    path: null,
    upgrades: { majors: true, plainBumps: true, cooldownDays: REGISTRY.cooldownDays },
    pullRequests: { limit: PULL_REQUESTS.maxOpenPerRepo, perHour: PULL_REQUESTS.maxNewPerHour },
    dashboardIssue: true,
    ignore: [],
    problems: [],
  };
  const path = CONFIG_PATHS.find((p) => tree.read(p) !== null);
  if (!path) return config;
  config.present = true;
  config.path = path;
  let doc: Record<string, unknown>;
  try {
    doc = (YAML.parse(tree.read(path) ?? "") as Record<string, unknown> | null) ?? {};
  } catch (error) {
    config.problems.push(
      `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
    return config;
  }
  const take = <T>(value: unknown, check: (v: unknown) => v is T, fallback: T, key: string): T => {
    if (value === undefined) return fallback;
    if (check(value)) return value;
    config.problems.push(`${key} has the wrong type; using ${JSON.stringify(fallback)}`);
    return fallback;
  };
  const bool = (v: unknown): v is boolean => typeof v === "boolean";
  const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  const upgrades = (doc.upgrades ?? {}) as Record<string, unknown>;
  const prs = (doc.pullRequests ?? {}) as Record<string, unknown>;
  config.upgrades = {
    majors: take(upgrades.majors, bool, config.upgrades.majors, "upgrades.majors"),
    plainBumps: take(upgrades.plainBumps, bool, config.upgrades.plainBumps, "upgrades.plainBumps"),
    cooldownDays: take(upgrades.cooldownDays, count, config.upgrades.cooldownDays, "upgrades.cooldownDays"),
  };
  config.pullRequests = {
    limit: take(prs.limit, count, config.pullRequests.limit, "pullRequests.limit"),
    perHour: take(prs.perHour, count, config.pullRequests.perHour, "pullRequests.perHour"),
  };
  config.dashboardIssue = take(doc.dashboardIssue, bool, config.dashboardIssue, "dashboardIssue");
  config.ignore = take(
    doc.ignore,
    (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string"),
    [],
    "ignore",
  );
  return config;
}
