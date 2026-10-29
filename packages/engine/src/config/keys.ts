/**
 * The `teire.yml` settings a person can change from the dashboard through a pull request (U3, the
 * Config tab and Settings): scalar keys only, each with how its value is read.
 */
export const CONFIG_PR_KEYS = {
  fixes: { kind: "enum", values: ["automatic", "ask", "off"] },
  securityFixes: { kind: "enum", values: ["automatic", "ask"] },
  schedule: { kind: "enum", values: ["daily", "weekly", "push", "off"] },
  "upgrades.majors": { kind: "boolean" },
  "upgrades.plainBumps": { kind: "boolean" },
  "upgrades.cooldownDays": { kind: "integer", min: 0, max: 90 },
  "pullRequests.limit": { kind: "integer", min: 0, max: 50 },
  "pullRequests.perHour": { kind: "integer", min: 0, max: 20 },
  dashboardIssue: { kind: "boolean" },
  ignore: { kind: "list" },
  "upgrades.allow": { kind: "list" },
  "upgrades.deny": { kind: "list" },
  paths: { kind: "list" },
  ignorePaths: { kind: "list" },
} as const;

export type ConfigPrKey = keyof typeof CONFIG_PR_KEYS;

/** Most entries a list setting takes from the dashboard, and how long each may be. */
const LIST_MAX = 50;
const ITEM_MAX = 200;

/**
 * The value as YAML wants it, or why it isn't one this key takes (shared by the page's inline check
 * and the worker). A list is one entry per line or comma; an empty list clears the key's entries.
 */
export function configValue(
  key: ConfigPrKey,
  raw: string,
): { value: string | number | boolean | string[] } | { error: string } {
  const spec = CONFIG_PR_KEYS[key];
  const text = raw.trim();
  if (spec.kind === "list") {
    const items = text
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (items.length > LIST_MAX) return { error: `${key} takes at most ${LIST_MAX} entries here` };
    if (items.some((x) => x.length > ITEM_MAX))
      return { error: `each ${key} entry is at most ${ITEM_MAX} characters` };
    return { value: [...new Set(items)] };
  }
  if (spec.kind === "enum")
    return (spec.values as readonly string[]).includes(text)
      ? { value: text }
      : { error: `${key} takes ${spec.values.join(", ")}` };
  if (spec.kind === "boolean")
    return text === "true" || text === "false"
      ? { value: text === "true" }
      : { error: `${key} takes true or false` };
  const n = Number(text);
  return Number.isInteger(n) && n >= spec.min && n <= spec.max
    ? { value: n }
    : { error: `${key} takes a whole number from ${spec.min} to ${spec.max}` };
}
