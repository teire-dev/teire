import { type Brand, ECOSYSTEMS } from "./brands";
import { providerLogo } from "./logos";

/** The mark for a change: its provider for model and API changes, its ecosystem for packages. */
export function subjectMark(groupKey: string | null | undefined): Brand {
  const [head = "", second = ""] = (groupKey ?? "").split("/");
  if (head === "advisory" && ECOSYSTEMS[second]) return ECOSYSTEMS[second] as Brand;
  if (head === "models" || head === "api") {
    const p = providerLogo(second);
    return { label: p.name, light: p.light, dark: p.dark };
  }
  return (
    (ECOSYSTEMS[head] as Brand | undefined) ?? {
      label: head,
      light: "/logos/provider.svg",
      dark: "/logos/provider.svg",
    }
  );
}

const LANGUAGE_ECOSYSTEM: Record<string, string> = {
  javascript: "npm",
  typescript: "npm",
  js: "npm",
  ts: "npm",
  python: "pypi",
  go: "go",
  rust: "cargo",
  ruby: "rubygems",
  jvm: "maven",
  java: "maven",
  kotlin: "maven",
};

/** A repository's ecosystems as marks, from the languages its scan found. */
export function languageMarks(languages: unknown): Brand[] {
  const list = Array.isArray(languages) ? (languages as string[]) : [];
  const keys = [
    ...new Set(list.map((l) => LANGUAGE_ECOSYSTEM[l.toLowerCase()]).filter((k): k is string => !!k)),
  ];
  return keys.map((k) => ECOSYSTEMS[k] as Brand);
}
