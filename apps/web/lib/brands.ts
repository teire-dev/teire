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

/** `site`: the registry's own website as a provider slug, so its pages fold into the ecosystem's tile. */
export const ECOSYSTEMS: Record<string, Brand & { reads: string; site: string }> = {
  npm: {
    label: "npm",
    light: "/logos/npm.svg",
    dark: "/logos/npm.svg",
    reads: "TypeScript declarations",
    site: "npmjs-com",
  },
  pypi: {
    label: "PyPI",
    light: "/logos/python.svg",
    dark: "/logos/python.svg",
    reads: "griffe",
    site: "pypi-org",
  },
  go: { label: "Go", light: "/logos/go.svg", dark: "/logos/go.svg", reads: "apidiff", site: "pkg-go-dev" },
  cargo: {
    label: "Cargo",
    light: "/logos/rust-light.svg",
    dark: "/logos/rust-dark.svg",
    reads: "cargo-semver-checks",
    site: "crates-io",
  },
  rubygems: {
    label: "RubyGems",
    light: "/logos/ruby.svg",
    dark: "/logos/ruby.svg",
    reads: "Prism",
    site: "rubygems-org",
  },
  maven: {
    label: "Maven · Gradle",
    light: "/logos/java.svg",
    dark: "/logos/java.svg",
    reads: "japicmp",
    site: "central-sonatype-com",
  },
};

export const SPONSORS = {
  nvidia: { label: "NVIDIA", light: "/logos/nvidia-light.svg", dark: "/logos/nvidia-dark.svg", wide: true },
  nebius: { label: "Nebius", light: "/logos/nebius-light.svg", dark: "/logos/nebius-dark.svg", wide: true },
  tavily: { label: "Tavily", light: "/logos/tavily-light.svg", dark: "/logos/tavily-dark.svg", wide: true },
  github: { label: "GitHub", light: "/logos/github-light.svg", dark: "/logos/github-dark.svg" },
} satisfies Record<string, Brand>;

/**
 * Marks for providers Teire found in someone's code rather than reads with a hand-written reader,
 * keyed by the slug discovery gives them (the host, dots as dashes). Without one a provider keeps
 * the generic API glyph.
 */
export const DISCOVERED: Record<string, Brand> = {
  "github-com": SPONSORS.github,
  "gitlab-com": { label: "GitLab", light: "/logos/gitlab.svg", dark: "/logos/gitlab.svg" },
  "bitbucket-org": { label: "Bitbucket", light: "/logos/bitbucket.svg", dark: "/logos/bitbucket.svg" },
  "groq-com": { label: "Groq", light: "/logos/groq.svg", dark: "/logos/groq.svg" },
  "mistral-ai": { label: "Mistral AI", light: "/logos/mistral.svg", dark: "/logos/mistral.svg" },
  "perplexity-ai": { label: "Perplexity", light: "/logos/perplexity.svg", dark: "/logos/perplexity.svg" },
  "openrouter-ai": {
    label: "OpenRouter",
    light: "/logos/openrouter-light.svg",
    dark: "/logos/openrouter-dark.svg",
  },
  "context7-com": { label: "Context7", light: "/logos/context7-light.svg", dark: "/logos/context7-dark.svg" },
  "tavily-com": { label: "Tavily", light: SPONSORS.tavily.light, dark: SPONSORS.tavily.dark },
  "twitch-tv": { label: "Twitch", light: "/logos/twitch.svg", dark: "/logos/twitch.svg" },
};

/** The package ecosystem whose registry website a provider slug is, if any (`rubygems-org` → rubygems). */
export function ecosystemOfSite(slug: string) {
  return Object.keys(ECOSYSTEMS).find((k) => ECOSYSTEMS[k]?.site === slug);
}

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
