import { BrandLogo } from "@/components/brand-logo";
import { ECOSYSTEMS, SPONSORS } from "@/lib/brands";
import { CURATED } from "@/lib/logos";

/** The six ecosystems with the tool each one's API is read with. */
export function EcosystemGrid() {
  return (
    <div className="not-prose my-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-fd-border bg-fd-border sm:grid-cols-3">
      {Object.entries(ECOSYSTEMS).map(([key, e]) => (
        <a
          key={key}
          href={`/docs/ecosystems/${key}`}
          className="flex flex-col gap-2 bg-fd-card p-4 transition-colors hover:bg-fd-accent"
        >
          <BrandLogo light={e.light} dark={e.dark} alt="" className="h-6" />
          <span className="text-sm font-medium">{e.label}</span>
          <span className="font-mono text-xs text-fd-muted-foreground">{e.reads}</span>
        </a>
      ))}
    </div>
  );
}

/** The providers with a reader written for their change pages. */
export function ProviderRow() {
  return (
    <div className="not-prose my-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-fd-border bg-fd-card p-4">
      {CURATED.map((p) => (
        <a
          key={p.slug}
          href={`/providers/${p.slug}`}
          className="flex items-center gap-2 text-sm hover:underline"
        >
          <BrandLogo light={p.light} dark={p.dark} alt="" className="h-5" />
          {p.name}
        </a>
      ))}
    </div>
  );
}

/** The sponsor technology that runs every model call. */
export function BuiltOn() {
  return (
    <div className="not-prose my-6 flex flex-wrap items-center gap-8 rounded-lg border border-fd-border bg-fd-card p-5">
      <BrandLogo light={SPONSORS.nvidia.light} dark={SPONSORS.nvidia.dark} alt="NVIDIA" className="h-6" />
      <BrandLogo light={SPONSORS.nebius.light} dark={SPONSORS.nebius.dark} alt="Nebius" className="h-5" />
    </div>
  );
}
