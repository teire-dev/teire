import type { CallSite } from "@teire/engine/contract";

/** Exact lines a change reaches, each linked to that line at the scanned commit. */
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
    <ul className="overflow-hidden rounded-md border font-mono text-xs">
      {shown.map((s) => {
        const where = `${s.file}:${s.line}`;
        const href = repo && sha ? `https://github.com/${repo}/blob/${sha}/${s.file}#L${s.line}` : null;
        return (
          <li
            key={where}
            className="flex flex-col gap-0.5 border-b px-3 py-2 last:border-0 sm:flex-row sm:items-baseline sm:gap-3"
          >
            {href ? (
              <a href={href} className="shrink-0 text-link hover:underline">
                {where}
              </a>
            ) : (
              <span className="shrink-0">{where}</span>
            )}
            <span className="truncate text-muted-foreground">{s.snippet}</span>
          </li>
        );
      })}
      {sites.length > limit ? (
        <li className="px-3 py-2 text-muted-foreground">… {sites.length - limit} more</li>
      ) : null}
    </ul>
  );
}
