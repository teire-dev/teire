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
} as const;

export type ConfigPrKey = keyof typeof CONFIG_PR_KEYS;
