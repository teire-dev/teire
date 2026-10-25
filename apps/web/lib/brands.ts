/**
 * Logos used nominatively: to name the ecosystem or provider a change belongs to, never as
 * partners. Self-hosted SVGs (public/logos), light and dark variants where the mark needs one.
 */
export interface Brand {
  label: string;
  light: string;
  dark: string;
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
  nvidia: { label: "NVIDIA", light: "/logos/nvidia-light.svg", dark: "/logos/nvidia-dark.svg" },
  nebius: { label: "Nebius", light: "/logos/nebius-light.svg", dark: "/logos/nebius-dark.svg" },
  tavily: { label: "Tavily", light: "/logos/tavily-light.svg", dark: "/logos/tavily-dark.svg" },
  github: { label: "GitHub", light: "/logos/github-light.svg", dark: "/logos/github-dark.svg" },
} satisfies Record<string, Brand>;

export function ecosystemOf(key: string | null | undefined) {
  return key ? ECOSYSTEMS[key] : undefined;
}
