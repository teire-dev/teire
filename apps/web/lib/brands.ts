/**
 * Logos used nominatively: to name the ecosystem or provider a change belongs to, never as
 * partners. Self-hosted SVGs (public/logos), light and dark variants where the mark needs one.
 */
export interface Brand {
  label: string;
  light: string;
  dark: string;
  /** A wordmark (NVIDIA, Nebius, Tavily): its tile widens instead of shrinking to a square. */
  wide?: boolean;
}

export const ECOSYSTEMS: Record<string, Brand & { reads: string }> = {
  npm: { label: "npm", light: "/logos/npm.svg", dark: "/logos/npm.svg", reads: "TypeScript declarations" },
  pypi: { label: "PyPI", light: "/logos/python.svg", dark: "/logos/python.svg", reads: "griffe" },
  go: { label: "Go", light: "/logos/go.svg", dark: "/logos/go.svg", reads: "apidiff" },
  cargo: {
    label: "Cargo",
    light: "/logos/rust-light.svg",
    dark: "/logos/rust-dark.svg",
    reads: "cargo-semver-checks",
  },
  rubygems: { label: "RubyGems", light: "/logos/ruby.svg", dark: "/logos/ruby.svg", reads: "Prism" },
  maven: { label: "Maven · Gradle", light: "/logos/java.svg", dark: "/logos/java.svg", reads: "japicmp" },
};

export const SPONSORS = {
  nvidia: { label: "NVIDIA", light: "/logos/nvidia-light.svg", dark: "/logos/nvidia-dark.svg", wide: true },
  nebius: { label: "Nebius", light: "/logos/nebius-light.svg", dark: "/logos/nebius-dark.svg", wide: true },
  tavily: { label: "Tavily", light: "/logos/tavily-light.svg", dark: "/logos/tavily-dark.svg", wide: true },
  github: { label: "GitHub", light: "/logos/github-light.svg", dark: "/logos/github-dark.svg" },
} satisfies Record<string, Brand>;

/** Teire's own mark as a brand, for the tile that is Teire in a flow (served from app/icon.svg). */
export const TEIRE: Brand = { label: "Teire", light: "/icon.svg", dark: "/icon.svg" };

/** What a run is built on, drawn on its tiles: the updater, the sandboxes, the model (plan 3.4). */
export const STACK = {
  dependabot: {
    label: "dependabot-core",
    light: "/logos/dependabot-light.svg",
    dark: "/logos/dependabot-dark.svg",
  },
  cloudflare: { label: "Cloudflare", light: "/logos/cloudflare.svg", dark: "/logos/cloudflare.svg" },
  nemotron: {
    label: "Nemotron 3 Ultra",
    light: "/logos/nvidia-icon-light.svg",
    dark: "/logos/nvidia-icon-dark.svg",
  },
  tokenFactory: {
    label: "Token Factory",
    light: "/logos/nebius-light.svg",
    dark: "/logos/nebius-dark.svg",
    wide: true,
  },
} satisfies Record<string, Brand>;

export function ecosystemOf(key: string | null | undefined) {
  return key ? ECOSYSTEMS[key] : undefined;
}
