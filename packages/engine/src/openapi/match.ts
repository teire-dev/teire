/**
 * Which operation of a spec a call reaches (research cross-cutting.md §6, prototyped on Stripe's
 * spec): strip the server's base path, match the remaining path against each operation's template
 * (`{param}` matches one segment), most specific first. Query strings in spec keys are ignored
 * (OpenAI: `/responses/compact?beta=true`).
 */
export interface SpecOperation {
  method: string;
  path: string;
  operationId?: string;
}

export interface SpecIndex {
  hosts: string[];
  basePaths: string[];
  operations: SpecOperation[];
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

export function indexSpec(spec: {
  servers?: { url?: string }[];
  host?: string;
  basePath?: string;
  paths?: Record<string, Record<string, { operationId?: string }>>;
}): SpecIndex {
  const hosts = new Set<string>();
  const basePaths = new Set<string>([""]);
  for (const s of spec.servers ?? []) {
    try {
      const u = new URL((s.url ?? "").replace(/\{[^}]+\}/g, "x"));
      hosts.add(u.hostname);
      basePaths.add(u.pathname.replace(/\/+$/, ""));
    } catch {
      // A relative server URL names no host.
    }
  }
  if (spec.host) hosts.add(spec.host);
  if (spec.basePath) basePaths.add(spec.basePath.replace(/\/+$/, ""));
  const operations: SpecOperation[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {}))
    for (const method of METHODS)
      if (item?.[method])
        operations.push({
          method: method.toUpperCase(),
          path: path.replace(/\?.*$/, ""),
          ...(item[method]?.operationId ? { operationId: item[method].operationId } : {}),
        });
  return { hosts: [...hosts], basePaths: [...basePaths].sort((a, b) => b.length - a.length), operations };
}

function templateRegex(path: string) {
  const escaped = path
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${escaped}/?$`);
}

/** Operations a call to `path` (any method when `method` is unknown) reaches, most specific first. */
export function matchOperations(index: SpecIndex, path: string, method?: string): SpecOperation[] {
  const clean = path.replace(/[?#].*$/, "").replace(/\/{2,}/g, "/");
  for (const base of index.basePaths) {
    if (base && !clean.startsWith(base)) continue;
    const rest = clean.slice(base.length) || "/";
    const hits = index.operations
      .filter((op) => (!method || op.method === method.toUpperCase()) && templateRegex(op.path).test(rest))
      .sort((a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0));
    if (hits.length) {
      const best = hits[0]?.path.match(/\{/g)?.length ?? 0;
      return hits.filter((h) => (h.path.match(/\{/g)?.length ?? 0) === best);
    }
  }
  return [];
}
