import { PROVIDERS } from "@teire/engine/providers";
import { DISCOVERED } from "./brands";

/** A provider's own mark: its hand-written reader's, a known discovered provider's, else the generic API glyph. */
export function providerLogo(slug: string | null | undefined) {
  const p = slug ? PROVIDERS.find((x) => x.slug === slug) : undefined;
  if (p) return { ...p.logo, name: p.name };
  const d = slug ? DISCOVERED[slug] : undefined;
  return d
    ? { light: d.light, dark: d.dark, name: d.label }
    : { light: "/logos/provider.svg", dark: "/logos/provider.svg", name: slug ?? "API" };
}

export const CURATED = PROVIDERS.map((p) => ({ slug: p.slug, name: p.name, ...p.logo }));
