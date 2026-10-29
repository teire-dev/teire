"use client";

import { CONFIG_PR_KEYS, type ConfigPrKey, configValue } from "@teire/engine/config-keys";
import { GitPullRequestArrow, Info } from "lucide-react";
import { useState } from "react";
import { StaticFlow } from "@/components/flow/static-flow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FlowGraph } from "@/lib/flow/model";
import { runAction } from "./run-action";

/** What confirming does: a pull request, your merge, then the next scan reads the new value. */
const AFTER: FlowGraph = {
  tiles: [
    { id: "pr", entity: "outcome", state: "pending", label: "Pull request", meta: "opens now" },
    { id: "m", entity: "review", state: "pending", label: "You merge", meta: "nothing before" },
    { id: "s", entity: "check", state: "pending", label: "Next scan", meta: "reads it" },
  ],
  links: [
    { from: "pr", to: "m", state: "pending" },
    { from: "m", to: "s", state: "pending" },
  ],
};

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
  ignore: "Ignored changes and packages",
  "upgrades.allow": "Only upgrade these",
  "upgrades.deny": "Never upgrade these",
  paths: "Only scan these paths",
  ignorePaths: "Never scan these paths",
};

/** What saving a key does, before it is saved (the plan's settings callout). */
const EFFECT: Partial<Record<ConfigPrKey, string>> = {
  fixes: "A fix mode set in teire.yml wins over the dashboard's and locks its control.",
  schedule: "Changes when Teire scans this repository on its own.",
  ignore: "Ignored changes stop being reported, and their open PRs close at the next scan.",
  "upgrades.deny": "Denied packages get no upgrade PRs; open ones close at the next scan.",
  paths: "Only these paths are scanned; findings elsewhere go away at the next scan.",
};

/** The resolved value as the form shows it: a list one entry per line. */
const shown = (v: unknown) =>
  Array.isArray(v) ? v.join("\n") : v === undefined || v === null ? "" : String(v);

/**
 * "Change a setting" (plan revision 3.3, U3, the settings grammar): one `teire.yml` key with its value
 * now, an editor for its kind (choices, a number, or a list one entry per line), checked as it is typed
 * with the worker's own rule; Save stays off until the value changes, and says what it will do. Saving
 * opens a config pull request the repository keeps; the toast follows it to the PR.
 */
export function ConfigPrForm({
  repo,
  current = {},
  initialKey = "fixes",
}: {
  repo: string;
  current?: Record<string, unknown>;
  /** The key a board cell picked (the parent remounts the form when it changes). */
  initialKey?: ConfigPrKey;
}) {
  const keys = Object.keys(CONFIG_PR_KEYS) as ConfigPrKey[];
  const [key, setKey] = useState<ConfigPrKey>(initialKey);
  const start = (k: ConfigPrKey) => {
    const s = CONFIG_PR_KEYS[k];
    const now = shown(current[k]);
    if (now) return now;
    return s.kind === "enum"
      ? (s.values[0] as string)
      : s.kind === "boolean"
        ? "true"
        : s.kind === "list"
          ? ""
          : String(s.min);
  };
  const [value, setValue] = useState(() => start(initialKey));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const spec = CONFIG_PR_KEYS[key];
  const checked = configValue(key, value);
  const now = shown(current[key]);
  // Unchanged when the value reads the same as what the file says now (a list in any order of lines).
  const before = configValue(key, now);
  // A list's order doesn't change what it does, so lines only reordered are no change.
  const same = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v);
  const changed = "error" in checked || same(checked.value) !== same("error" in before ? null : before.value);
  const field =
    "rounded-md bg-sheet px-2 text-sm ring-1 ring-rule ring-inset outline-none focus-visible:ring-signal";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        // The PR opens only after its diff is seen: before → after, and what merging it does.
        if ("error" in checked || !changed) return;
        setConfirming(true);
      }}
    >
      <div className="flex flex-wrap items-start gap-2">
        <label className="sr-only" htmlFor="config-key">
          Setting
        </label>
        <select
          id="config-key"
          className={`${field} h-8`}
          value={key}
          onChange={(e) => {
            const next = e.target.value as ConfigPrKey;
            setKey(next);
            setValue(start(next));
          }}
        >
          {keys.map((k) => (
            <option key={k} value={k}>
              {SAY[k]}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="config-value">
          Value
        </label>
        {spec.kind === "list" ? (
          <textarea
            id="config-value"
            rows={4}
            className={`${field} w-72 py-1.5 font-mono text-xs`}
            placeholder="one entry per line"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={"error" in checked}
          />
        ) : spec.kind === "integer" ? (
          <input
            id="config-value"
            type="number"
            min={spec.min}
            max={spec.max}
            className={`${field} h-8 w-24`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={"error" in checked}
          />
        ) : (
          <select
            id="config-value"
            className={`${field} h-8`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          >
            {(spec.kind === "enum" ? (spec.values as readonly string[]) : ["true", "false"]).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" type="submit" disabled={busy || "error" in checked || !changed}>
          <GitPullRequestArrow data-icon="inline-start" aria-hidden />
          Open config PR
        </Button>
      </div>
      {"error" in checked ? (
        <p className="text-xs text-broke">{checked.error}</p>
      ) : (
        // The change as a diff of the file's value: before → after, and what saving does on hover.
        <p className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span
            className={
              changed
                ? "rounded bg-broke-soft px-1.5 py-0.5 text-broke line-through decoration-broke/50"
                : "rounded bg-sunken px-1.5 py-0.5 text-ink-2"
            }
          >
            {now ? now.replace(/\n/g, ", ") : "unset"}
          </span>
          <span className="text-ink-3" aria-hidden>
            →
          </span>
          <span
            className={
              changed
                ? "rounded bg-proven-soft px-1.5 py-0.5 text-proven"
                : "rounded bg-sunken px-1.5 py-0.5 text-ink-3"
            }
          >
            {changed ? String(value).replace(/\n/g, ", ") || "empty" : "no change"}
          </span>
        </p>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{SAY[key]}</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {repo} · .github/teire.yml · {key}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-sunken p-3 font-mono text-xs">
            <span className="rounded bg-broke-soft px-1.5 py-0.5 text-broke line-through decoration-broke/50">
              {now ? now.replace(/\n/g, ", ") : "unset"}
            </span>
            <span className="text-ink-3" aria-hidden>
              →
            </span>
            <span className="rounded bg-proven-soft px-1.5 py-0.5 text-proven">
              {String(value).replace(/\n/g, ", ") || "empty"}
            </span>
          </div>
          <StaticFlow
            graph={AFTER}
            size="sm"
            label="A pull request, your merge, then the next scan reads it."
          />
          {EFFECT[key] ? (
            <p className="flex gap-2 text-xs text-ink-2">
              <Info className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
              {EFFECT[key]}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await runAction({ kind: "config-pr", params: { key, value }, repo });
                  setConfirming(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <GitPullRequestArrow data-icon="inline-start" aria-hidden />
              Open the PR
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
