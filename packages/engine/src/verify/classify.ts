/**
 * Why checks failed with the network off (research js-ts.md §8, sandbox.md §2): the egress log
 * first (the sandbox denies and records every request in the check phase), then error text.
 *  - a denied request to a non-registry host → the tests need live access;
 *  - a refused connection to localhost on a database or cache port → they need a local service;
 *  - engine or native-binary errors → the environment differs from the repo's own.
 */
export type FailureCause = "needs_live_access" | "needs_local_service" | "environment_mismatch";

export interface Classified {
  cause: FailureCause | null;
  hosts: string[];
  details: string[];
}

const LOCAL_SERVICE_PORTS: Record<string, string> = {
  "5432": "PostgreSQL",
  "3306": "MySQL",
  "6379": "Redis",
  "27017": "MongoDB",
  "9200": "Elasticsearch",
  "5672": "RabbitMQ",
  "11211": "Memcached",
};

const NETWORK =
  /\b(EAI_AGAIN|ENOTFOUND|getaddrinfo|ETIMEDOUT|ECONNRESET|fetch failed|x-teire-egress|403 Forbidden.*denied)\b/;
const ENVIRONMENT = [
  /The engine "node" is incompatible/,
  /Unsupported engine/,
  /was compiled against a different Node\.js version/,
  /NODE_MODULE_VERSION \d+/,
  /Cannot find module '[^']*\/build\/Release\//,
  /prebuild-install|node-gyp rebuild/,
  /Could not locate the bindings file/,
];

export function classifyFailure(output: string, deniedHosts: string[]): Classified {
  const details: string[] = [];
  for (const [port, service] of Object.entries(LOCAL_SERVICE_PORTS)) {
    if (new RegExp(`ECONNREFUSED (127\\.0\\.0\\.1|::1|localhost):${port}\\b`).test(output))
      details.push(service);
  }
  if (details.length) return { cause: "needs_local_service", hosts: [], details };
  const env = ENVIRONMENT.filter((re) => re.test(output)).map((re) => re.source);
  if (env.length) return { cause: "environment_mismatch", hosts: [], details: env };
  if (deniedHosts.length || NETWORK.test(output))
    return {
      cause: "needs_live_access",
      hosts: deniedHosts,
      details: deniedHosts.length ? [] : ["network error in output"],
    };
  return { cause: null, hosts: [], details: [] };
}
