import Link from "next/link";
import type { ReactNode } from "react";
import { CallSites } from "@/components/findings/call-sites";
import { VerdictBadge } from "@/components/findings/verdict-badge";
import { ProofGlyphs } from "@/components/teire/proof-glyphs";
import type { FindingGroup } from "@/lib/findings";
import { groupHref } from "@/lib/links";
import type { Proof } from "@/lib/proof";

/** One PR's worth of findings: what changed, where it reaches this repo, and why Teire says so. */
export function FindingGroupCard({
  group,
  repo,
  sha,
  action,
  proof,
}: {
  group: FindingGroup;
  repo: string | null;
  sha: string | null;
  action?: ReactNode;
  /** The proof chain for this group: its run's, or the finding's own when nothing ran yet. */
  proof?: Proof;
}) {
  const changeHref = group.changeIds[0] ? `/changes/${group.changeIds[0]}` : null;
  const subjectHref = groupHref(group.key);
  return (
    <article className="flex flex-col gap-3 rounded-lg bg-card p-4 shadow-card">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          {changeHref ? (
            <Link href={changeHref} className="font-medium entity-link">
              {group.title}
            </Link>
          ) : (
            <span className="font-medium">{group.title}</span>
          )}
          {subjectHref ? (
            <Link
              href={subjectHref}
              className="mt-0.5 block w-fit font-mono text-xs text-muted-foreground entity-link"
            >
              {group.key}
            </Link>
          ) : (
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{group.key}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {group.deadline ? (
            <span className="font-mono text-xs text-human">{group.deadline.slice(0, 10)}</span>
          ) : null}
          <VerdictBadge verdict={group.verdict} />
        </div>
        {proof ? <ProofGlyphs proof={proof} className="basis-full" /> : null}
      </header>
      <CallSites sites={group.sites} repo={repo} sha={sha} />
      {group.reason && group.verdict !== "affected" ? (
        <p className="text-sm text-muted-foreground">{group.reason}</p>
      ) : null}
      {group.changeIds.length > 1 || group.others || group.priority !== null ? (
        <p className="text-xs text-muted-foreground">
          {[
            group.changeIds.length > 1 ? `${group.changeIds.length} changes` : null,
            group.others ? `${group.others} more mention${group.others === 1 ? "" : "s"} checked` : null,
            group.priority !== null ? `PR priority ${group.priority}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {action ? <div className="flex flex-wrap gap-2 border-t pt-3">{action}</div> : null}
    </article>
  );
}
