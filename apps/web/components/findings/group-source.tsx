import { ArrowUpRight } from "lucide-react";
import type { FindingGroup, GroupSource } from "@/lib/findings";
import { TRUST_BASIS } from "@/lib/trust";

const host = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\.|^api\./, "");
  } catch {
    return url;
  }
};

/** What changed upstream in its source's own words, linked, with how far to trust it (revamp S2). */
export function GroupSourceQuote({ source }: { source: GroupSource }) {
  return (
    <figure className="flex flex-col gap-1">
      {source.quote ? (
        <blockquote className="line-clamp-3 border-l-2 border-signal/60 pl-2.5 text-[12.5px] leading-relaxed text-ink-2">
          {source.quote}
        </blockquote>
      ) : null}
      <figcaption className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-ink-3">
        {source.url ? (
          <a
            href={source.url}
            rel="noreferrer noopener"
            target="_blank"
            className="inline-flex items-center gap-1 text-link hover:underline"
          >
            {host(source.url)}
            <ArrowUpRight className="size-3" aria-hidden />
          </a>
        ) : null}
        {source.basis ? <span>{TRUST_BASIS[source.basis] ?? source.basis}</span> : null}
      </figcaption>
    </figure>
  );
}

const VERDICT: Record<string, string> = {
  affected: "affects this code",
  needs_human: "needs a person",
  check_by_hand: "check by hand",
  inconclusive: "inconclusive",
  not_affected: "not affected",
  not_applicable: "not applicable",
};

/** The finding's standing in a line: verdict, urgency, and the weaker mentions Teire also checked. */
export function GroupMeta({ group }: { group: FindingGroup }) {
  const bits = [
    VERDICT[group.verdict] ?? group.verdict,
    group.priority !== null ? `priority ${group.priority}` : null,
    group.others ? `${group.others} more mention${group.others === 1 ? "" : "s"} checked` : null,
  ].filter(Boolean);
  return <p className="font-mono text-[11px] text-ink-3">{bits.join(" · ")}</p>;
}
