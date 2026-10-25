import { PROVIDERS } from "@teire/engine/providers";

/** A provider's own mark when Teire has a hand-written reader for it, else the generic API glyph. */
export function providerLogo(slug: string | null | undefined) {
  const p = slug ? PROVIDERS.find((x) => x.slug === slug) : undefined;
  return p
    ? { ...p.logo, name: p.name }
    : { light: "/logos/provider.svg", dark: "/logos/provider.svg", name: slug ?? "API" };
}

export const CURATED = PROVIDERS.map((p) => ({ slug: p.slug, name: p.name, ...p.logo }));
