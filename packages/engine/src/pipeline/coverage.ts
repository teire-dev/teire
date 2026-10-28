import type { AdvisoryCoverage } from "../advisories";

/**
 * What a scan could not check, so "nothing found" is never read as "all checked" (D96): advisory
 * lookups that were partial or failed, packages whose registry did not answer, and parts of an
 * inventory the reader does not cover. Each pipeline writes into the scan's one collector.
 */
export interface ScanCoverage {
  advisories: { ecosystem: string; root: string; status: AdvisoryCoverage["status"]; notes: string[] }[];
  lookupsFailed: { ecosystem: string; name: string }[];
  notes: string[];
  /**
   * Ecosystems Teire can't upgrade (rule 8): their packages and OSV advisories are reported, never
   * "clean". `advisories` is null when OSV didn't answer.
   */
  detectOnly: {
    ecosystem: string;
    packages: number;
    advisories: { name: string; version: string; ids: string[] }[] | null;
  }[];
}

export function newScanCoverage(): ScanCoverage {
  return { advisories: [], lookupsFailed: [], notes: [], detectOnly: [] };
}

/** The scan's overall advisory status: the worst of its lookups (no lookup ran → "complete"). */
export function advisoryStatus(c: ScanCoverage): AdvisoryCoverage["status"] {
  const statuses = c.advisories.map((a) => a.status);
  return statuses.includes("unavailable")
    ? "unavailable"
    : statuses.includes("partial")
      ? "partial"
      : "complete";
}

/** Plain lines for the onboarding PR, the Dashboard issue and PRs; empty when everything was checked. */
export function coverageLines(c: ScanCoverage): string[] {
  const out: string[] = [];
  for (const a of c.advisories.filter((x) => x.status !== "complete"))
    out.push(
      a.status === "unavailable"
        ? `Security advisories for ${a.ecosystem}${a.root && a.root !== "." ? ` in \`${a.root}\`` : ""} could not be checked (${a.notes.join("; ")}). This is not the same as "no advisories".`
        : `Security advisories for ${a.ecosystem}${a.root && a.root !== "." ? ` in \`${a.root}\`` : ""} were checked in part: ${a.notes.slice(0, 3).join("; ")}${a.notes.length > 3 ? `; and ${a.notes.length - 3} more` : ""}.`,
    );
  if (c.lookupsFailed.length) {
    const names = [...new Set(c.lookupsFailed.map((l) => `${l.ecosystem}:${l.name}`))];
    out.push(
      `${names.length} package${names.length === 1 ? "" : "s"} could not be looked up in ${names.length === 1 ? "its" : "their"} registry, so newer versions are unknown, not "up to date": ${names
        .slice(0, 8)
        .map((n) => `\`${n}\``)
        .join(", ")}${names.length > 8 ? ` and ${names.length - 8} more` : ""}.`,
    );
  }
  for (const d of c.detectOnly)
    out.push(
      `${d.packages} ${d.ecosystem} package${d.packages === 1 ? "" : "s"}: Teire reports ${d.packages === 1 ? "it" : "them"} but doesn't upgrade ${d.ecosystem} yet. ${
        d.advisories === null
          ? "Advisories could not be checked (OSV did not answer)."
          : d.advisories.length
            ? `Advisories: ${d.advisories
                .slice(0, 6)
                .map((a) => `\`${a.name}@${a.version}\` (${a.ids.slice(0, 3).join(", ")})`)
                .join(", ")}${d.advisories.length > 6 ? ` and ${d.advisories.length - 6} more` : ""}.`
            : "No advisory matches the locked versions."
      }`,
    );
  out.push(...new Set(c.notes));
  return out;
}
