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

/**
 * A finding group's subject in a tile's words: `zod` with `→ 4.6.6`, `OpenAI` with `models`, `node`
 * with `runtime`. Keys are `<ecosystem>/<package…>/<target>`, `models|api/<provider>`, `runtime/<name>`.
 */
export function subjectOfKey(key: string): { name: string; meta?: string } {
  const [head = "", ...rest] = key.split("/");
  if (head === "models" || head === "api")
    return { name: providerLogo(rest[0]).name, meta: head === "models" ? "models" : "API" };
  if (head === "runtime") return { name: rest[0] ?? head, meta: "runtime" };
  if (head === "advisory") return { name: rest.slice(1, -1).join("/") || head, meta: "advisory" };
  const full = rest.length >= 2 ? rest.slice(0, -1).join("/") : rest.join("/") || head;
  // A tile's name fits under its square: Maven's artifact (not group:artifact), then clipped.
  const short = head === "maven" ? (full.split(":").at(-1) ?? full) : full;
  const name = short.length > 18 ? `${short.slice(0, 17)}…` : short;
  return rest.length >= 2 ? { name, meta: `→ ${rest.at(-1)}` } : { name };
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
