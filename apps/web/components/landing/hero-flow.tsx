import { StaticFlow } from "@/components/flow/static-flow";
import { runFlow } from "@/lib/flow/model";
import hero from "@/lib/landing/hero-run.json";
import { subjectMark } from "@/lib/marks";

/**
 * The landing's real run (zod #30, `lib/landing/hero-run.json`) as one static flow: the docs' worked
 * example and anywhere else the whole fix should be seen at once (plan revision 3.4, A10).
 */
export function HeroFlow({ className }: { className?: string }) {
  return (
    <StaticFlow
      className={className}
      label={`How Teire fixed ${hero.run.package} in ${hero.repo}`}
      graph={runFlow({
        kind: "fix",
        status: "succeeded",
        step: null,
        evidenceKind: hero.pr.verified ? "verified" : null,
        prMode: hero.pr.mode,
        sites: hero.reach.sites,
        advisory: hero.reach.advisory,
        artifact: { kind: "pr", url: hero.pr.url, number: hero.pr.number },
        subject: subjectMark(hero.run.groupKey),
        subjectLabel: hero.run.package,
        repo: { fullName: hero.repo },
        agent: { calls: hero.fix.calls },
        backend: hero.run.backend,
        checksFigure: `${hero.checks.tests.before} → ${hero.checks.tests.after}`,
      })}
    />
  );
}
