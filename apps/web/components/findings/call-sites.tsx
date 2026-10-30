import type { CallSite } from "@teire/engine/contract";
import { ArrowUpRight } from "lucide-react";

/** How a line was tied to the change, in words a developer weighs (`CallSite.resolution`). */
const FOUND_BY: Record<CallSite["resolution"], string> = {
  type: "by type",
  import: "by import",
  traced: "traced",
  "name-only": "by name",
  literal: "literal",
};

/**
 * Exact lines a change reaches, each linked to that line at the scanned commit, with the code itself
 * and how Teire tied it to the change (by type, by import, by name).
 */
export function CallSites({
  sites,
  repo,
  sha,
  limit = 6,
}: {
  sites: CallSite[];
  repo: string | null;
  sha: string | null;
  limit?: number;
}) {
  if (!sites.length) return null;
  const shown = sites.slice(0, limit);
  return (
    <ul className="overflow-hidden rounded-card bg-sheet font-mono text-[11.5px] ring-1 ring-rule">
      {shown.map((s) => {
        const where = `${s.file}:${s.line}`;
        const href =
          repo && sha
            ? `https://github.com/${repo}/blob/${sha}/${s.file.split("/").map(encodeURIComponent).join("/")}#L${s.line}`
            : null;
        return (
          <li key={where} className="flex flex-col border-b border-rule last:border-0">
            <div className="flex items-center gap-2 bg-sunken px-3 py-1">
              {href ? (
                <a href={href} className="group flex min-w-0 items-center gap-1 text-link hover:underline">
                  <span className="truncate" title={where}>
                    {where}
                  </span>
                  <ArrowUpRight className="size-3 shrink-0" aria-hidden />
                </a>
              ) : (
                <span className="truncate text-ink-2">{where}</span>
              )}
              <span className="ml-auto shrink-0 text-[10.5px] text-ink-3">
                {FOUND_BY[s.resolution] ?? s.resolution}
              </span>
            </div>
            <code className="overflow-x-auto px-3 py-1.5 whitespace-pre text-ink">
              {s.snippet.trim() || " "}
            </code>
          </li>
        );
      })}
      {sites.length > limit ? (
        <li className="bg-sunken px-3 py-1.5 text-ink-3">+{sites.length - limit} more lines</li>
      ) : null}
    </ul>
  );
}
