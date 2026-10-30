/** The part of a scan's coverage that says it had nothing to work on (card C1, the install journeys). */
export interface OutcomeCoverage {
  skipped?: "archived" | "empty";
  nothingReadable?: boolean;
  /** What the scan looked for when it found none of it. */
  searched?: string[];
}

/**
 * A repository no onboarding PR will come to says why by name, never "Onboarding" or "Waiting for
 * GitHub": archived (read-only), no commits yet, or nothing in it Teire reads. Each clears itself:
 * unarchiving, the first push, or a push that adds a manifest scans it again.
 */
export function installOutcome(
  coverage: OutcomeCoverage | null | undefined,
  repo: { status: string; pausedReason: string | null },
) {
  if (repo.status === "disabled") return null;
  if ((repo.status === "paused" && repo.pausedReason === "archived") || coverage?.skipped === "archived")
    return {
      label: "Archived on GitHub",
      why: "Read-only, so no PR can open. Unarchive it and Teire scans it.",
    };
  if (repo.status !== "detected") return null;
  if (coverage?.skipped === "empty")
    return { label: "No commits yet", why: "Teire scans it on the first push." };
  if (coverage?.nothingReadable)
    return {
      label: "Nothing Teire reads",
      why: "No package manifest, API URL or model ID in it, so no PR. A push that adds one scans it again.",
    };
  return null;
}
