"use client";

import { CONFIG_PR_KEYS, type ConfigPrKey } from "@teire/engine/config-keys";
import { GitPullRequestArrow } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { runAction } from "./run-action";

const SAY: Record<ConfigPrKey, string> = {
  fixes: "Fix mode",
  securityFixes: "Security fixes",
  schedule: "Scan schedule",
  "upgrades.majors": "Major upgrades",
  "upgrades.plainBumps": "Plain bumps",
  "upgrades.cooldownDays": "Cooldown (days)",
  "pullRequests.limit": "Open PRs at most",
  "pullRequests.perHour": "New PRs per hour",
  dashboardIssue: "Dashboard issue",
};

/**
 * "Change a setting" (plan revision 3.3, U3): one `teire.yml` key and its value, sent as a config pull
 * request the repository keeps; the toast follows it to the PR. The values offered are the schema's.
 */
export function ConfigPrForm({ repo }: { repo: string }) {
  const keys = Object.keys(CONFIG_PR_KEYS) as ConfigPrKey[];
  const [key, setKey] = useState<ConfigPrKey>("fixes");
  const spec = CONFIG_PR_KEYS[key];
  const first =
    spec.kind === "enum" ? (spec.values[0] as string) : spec.kind === "boolean" ? "true" : String(spec.min);
  const [value, setValue] = useState(first);
  const [busy, setBusy] = useState(false);
  const field =
    "h-8 rounded-md bg-sheet px-2 text-sm ring-1 ring-rule ring-inset outline-none focus-visible:ring-signal";
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await runAction({ kind: "config-pr", params: { key, value }, repo });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="sr-only" htmlFor="config-key">
        Setting
      </label>
      <select
        id="config-key"
        className={field}
        value={key}
        onChange={(e) => {
          const next = e.target.value as ConfigPrKey;
          const s = CONFIG_PR_KEYS[next];
          setKey(next);
          setValue(
            s.kind === "enum" ? (s.values[0] as string) : s.kind === "boolean" ? "true" : String(s.min),
          );
        }}
      >
        {keys.map((k) => (
          <option key={k} value={k}>
            {SAY[k]} ({k})
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="config-value">
        Value
      </label>
      {spec.kind === "integer" ? (
        <input
          id="config-value"
          type="number"
          min={spec.min}
          max={spec.max}
          className={`${field} w-24`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : (
        <select id="config-value" className={field} value={value} onChange={(e) => setValue(e.target.value)}>
          {(spec.kind === "enum" ? (spec.values as readonly string[]) : ["true", "false"]).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      )}
      <Button size="sm" type="submit" disabled={busy}>
        <GitPullRequestArrow data-icon="inline-start" aria-hidden />
        Open config PR
      </Button>
    </form>
  );
}
