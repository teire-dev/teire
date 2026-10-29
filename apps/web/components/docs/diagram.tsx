import { StaticFlow } from "@/components/flow/static-flow";
import { DOC_FLOWS } from "./doc-flows";

/**
 * An architecture diagram as a live flow (plan revision 3.4, V6): the app's own tiles in Teire's
 * colours, light and dark by the tokens, one lane per path. It renders on the server, so it reads
 * without JavaScript; on phones each lane becomes a vertical timeline.
 */
export function Diagram({ name, alt, caption }: { name: string; alt: string; caption?: string }) {
  const lanes = DOC_FLOWS[name];
  if (!lanes) return null;
  return (
    <figure className="not-prose my-8">
      <div className="flex flex-col gap-6 rounded-card bg-sheet p-5 shadow-card sm:p-6">
        {lanes.map((l) => (
          <div key={l.title} className="flex flex-col gap-3">
            {lanes.length > 1 ? <span className="eyebrow">{l.title}</span> : null}
            <StaticFlow graph={l.graph} size="sm" label={`${l.title}. ${alt}`} />
          </div>
        ))}
      </div>
      {caption ? <figcaption className="mt-2.5 text-[13px] text-ink-3">{caption}</figcaption> : null}
    </figure>
  );
}
