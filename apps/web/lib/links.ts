import { ECOSYSTEMS } from "./brands";

/**
 * Where each thing Teire names has its own page, so every mention of it can lead there. Null when
 * there is no page: runtimes, and providers a repository declared in its own teire.yml.
 */
export function packageHref(ecosystem: string, name: string) {
  return ECOSYSTEMS[ecosystem]
    ? `/packages/${ecosystem}/${name.split("/").map(encodeURIComponent).join("/")}`
    : null;
}

export function providerHref(slug: string) {
  return slug && !slug.startsWith("declared-") ? `/providers/${slug}` : null;
}

/** A finding group: `models/<provider>`, `api/<provider>`, `<ecosystem>/<package…>/<target>` or `runtime/<name>`. */
export function groupHref(key: string) {
  const [head = "", ...rest] = key.split("/");
  if (head === "models" || head === "api") return providerHref(rest[0] ?? "");
  return rest.length >= 2 ? packageHref(head, rest.slice(0, -1).join("/")) : null;
}
