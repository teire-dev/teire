import { CONFIG_PR_KEYS } from "@teire/engine/config-keys";
import {
  CalendarClock,
  Check,
  GitPullRequest,
  type LucideIcon,
  Minus,
  Package,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { ECOSYSTEMS } from "@/lib/brands";
import { cn } from "@/lib/utils";

/**
 * A repository's resolved teire.yml as a board (plan revision 3.4, V4; the owner: "config looks like
 * too much text"): the settings grouped as cells (a label, the value, a dot for where it was set), the
 * ecosystems as logos on or off. Only what this repository (or its organisation) changed is marked; a
 * cell Teire can change opens it in the form above.
 */
type Cell = { key: string; label: string; suffix?: string };

const GROUPS: { title: string; icon: LucideIcon; cells: Cell[] }[] = [
  {
    title: "Fixes",
    icon: ShieldCheck,
    cells: [
      { key: "fixes", label: "Fix mode" },
      { key: "securityFixes", label: "Security fixes" },
    ],
  },
  {
    title: "Scans",
    icon: CalendarClock,
    cells: [
      { key: "schedule", label: "Schedule" },
      { key: "paths", label: "Only these paths" },
      { key: "ignorePaths", label: "Skipped paths" },
      { key: "sources", label: "Extra sources" },
    ],
  },
  {
    title: "Upgrades",
    icon: Package,
    cells: [
      { key: "upgrades.majors", label: "Majors" },
      { key: "upgrades.plainBumps", label: "Plain bumps" },
      { key: "upgrades.cooldownDays", label: "Cooldown", suffix: " days" },
      { key: "upgrades.allow", label: "Only these" },
      { key: "upgrades.deny", label: "Never these" },
      { key: "ignore", label: "Ignored" },
    ],
  },
  {
    title: "Pull requests",
    icon: GitPullRequest,
    cells: [
      { key: "pullRequests.limit", label: "Open at most" },
      { key: "pullRequests.perHour", label: "New per hour" },
      { key: "pullRequests.labels", label: "Labels" },
      { key: "pullRequests.targetBranch", label: "Into" },
      { key: "dashboardIssue", label: "Dashboard issue" },
      { key: "verify", label: "Extra checks" },
    ],
  },
];

function get(config: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined),
      config,
    );
}

/** Where a value came from: this repository's file, the organisation's, or the default. */
function originOf(origins: Record<string, string>, key: string) {
  const o = origins[key] ?? origins[key.split(".")[0] as string] ?? "default";
  return /org|teire-config/.test(o) ? "org" : /repo|teire\.ya?ml/.test(o) ? "repo" : "default";
}

function Value({ value, suffix }: { value: unknown; suffix?: string | undefined }) {
  if (value === true) return <Check className="size-4 text-proven" strokeWidth={2.5} aria-label="on" />;
  if (value === false) return <Minus className="size-4 text-ink-3" strokeWidth={2.5} aria-label="off" />;
  if (Array.isArray(value))
    return value.length ? (
      <span title={value.join("\n")}>{value.length}</span>
    ) : (
      <span className="text-ink-3">none</span>
    );
  if (value === null || value === undefined || value === "")
    return <span className="text-ink-3">{value === null ? "default branch" : "unset"}</span>;
  return (
    <span className="truncate">
      {String(value)}
      {suffix ?? ""}
    </span>
  );
}

export function ConfigBoard({
  config,
  base,
  picked,
}: {
  config: Record<string, unknown>;
  /** The Config tab's URL: an editable cell links to `?key=…` there. */
  base: string;
  picked?: string | null;
}) {
  const origins = (config.origins as Record<string, string> | undefined) ?? {};
  const ecosystems = (config.ecosystems as Record<string, boolean> | undefined) ?? {};
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-4 font-mono text-[11px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-signal" aria-hidden /> teire.yml
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-attention" aria-hidden /> organisation
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full ring-1 ring-ink-3" aria-hidden /> default
        </span>
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {GROUPS.map((g) => (
          <section key={g.title} className="flex flex-col gap-2 rounded-xl bg-sheet p-3 shadow-card">
            <h3 className="flex items-center gap-2 px-1 text-xs font-medium text-ink-2">
              <g.icon className="size-3.5" aria-hidden />
              {g.title}
            </h3>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {g.cells.map((c) => {
                const value = get(config, c.key);
                const from = originOf(origins, c.key);
                const editable = c.key in CONFIG_PR_KEYS;
                const body = (
                  <>
                    <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          from === "repo"
                            ? "bg-signal"
                            : from === "org"
                              ? "bg-attention"
                              : "ring-1 ring-ink-3/60",
                        )}
                      />
                      <span className="truncate">{c.label}</span>
                    </span>
                    <span className="flex h-5 items-center font-mono text-sm text-ink">
                      <Value value={value} suffix={c.suffix} />
                    </span>
                  </>
                );
                const cls = cn(
                  "flex min-w-0 flex-col gap-1 rounded-lg px-2.5 py-2 ring-1 ring-inset",
                  from === "default"
                    ? "ring-rule"
                    : from === "org"
                      ? "bg-attention-soft/40 ring-attention/30"
                      : "bg-signal-soft/40 ring-signal/30",
                  picked === c.key && "ring-2 ring-ink",
                );
                return editable ? (
                  <Link
                    key={c.key}
                    href={`${base}?key=${encodeURIComponent(c.key)}#change`}
                    scroll={false}
                    className={cn(cls, "hover:ring-rule-strong")}
                    title={`${c.key}: change it`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div key={c.key} className={cls} title={c.key}>
                    {body}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <section className="flex flex-col gap-2 rounded-xl bg-sheet p-3 shadow-card">
        <h3 className="flex items-center gap-2 px-1 text-xs font-medium text-ink-2">
          <SlidersHorizontal className="size-3.5" aria-hidden />
          Ecosystems
        </h3>
        <ul className="flex flex-wrap gap-2">
          {Object.entries(ecosystems).map(([k, on]) => {
            const eco = ECOSYSTEMS[k];
            return (
              <li
                key={k}
                title={`ecosystems.${k}: ${on ? "on" : "off"}`}
                className={cn(
                  "flex items-center gap-2 rounded-full bg-sheet py-1 pr-3 pl-1.5 text-xs shadow-tile ring-1 ring-rule",
                  !on && "opacity-40 grayscale",
                )}
              >
                <span className="flex size-6 items-center justify-center rounded-full bg-sunken">
                  {eco ? (
                    <BrandLogo light={eco.light} dark={eco.dark} alt="" className="h-3.5 w-auto" />
                  ) : (
                    <SlidersHorizontal className="size-3 text-ink-2" aria-hidden />
                  )}
                </span>
                <span className="text-ink">{eco?.label ?? (k === "apis" ? "APIs and models" : k)}</span>
                {on ? <Check className="size-3 text-proven" strokeWidth={3} aria-hidden /> : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
