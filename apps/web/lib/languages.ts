import { ECOSYSTEMS } from "./brands";

/** `repos.languages` (what a scan found) → the ecosystem whose logo stands for it. */
const ECOSYSTEM_OF: Record<string, string> = {
  javascript: "npm",
  python: "pypi",
  go: "go",
  rust: "cargo",
  ruby: "rubygems",
  jvm: "maven",
};

export function languageBrands(languages: string[] | null | undefined) {
  return (languages ?? []).flatMap((l) => {
    const e = ECOSYSTEMS[ECOSYSTEM_OF[l] ?? l];
    return e ? [{ key: l, ...e }] : [];
  });
}

export const ago = (d: Date | string | null | undefined) => {
  if (!d) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
};
