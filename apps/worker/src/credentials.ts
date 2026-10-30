import { and, type Database, eq, inArray, registryCredentials, sql } from "@teire/db";
import {
  authorizationOf,
  credentialContext,
  type DiscoveredRegistry,
  keyFromEnv,
  openSecret,
} from "@teire/engine/credentials";
import type { AuthorizedRegistry } from "@teire/engine/registry";

/**
 * The private registries a repository names that its installation has a credential for (S18.7),
 * opened with the worker's key: for version lookups, the resolver's proxy and the sandbox's egress.
 * A credential that no longer opens (the key changed) is left out and said in the notes.
 */
export async function authorizedRegistries(
  db: Database,
  installationId: number,
  discovered: DiscoveredRegistry[],
  notes: string[] = [],
): Promise<AuthorizedRegistry[]> {
  const key = keyFromEnv(process.env.TEIRE_CREDENTIALS_PRIVATE_KEY);
  if (!key || !discovered.length) return [];
  const rows = await db
    .select()
    .from(registryCredentials)
    .where(
      and(
        eq(registryCredentials.installationId, installationId),
        inArray(registryCredentials.host, [...new Set(discovered.map((d) => d.host))]),
      ),
    );
  const out: AuthorizedRegistry[] = [];
  const used: string[] = [];
  for (const d of discovered) {
    const row = rows.find((r) => r.host === d.host && r.ecosystem === d.ecosystem);
    if (!row) continue;
    // A URL the repo wrote with a token in it is redacted: only a saved full URL can be used.
    if (!row.url && d.url.includes("***")) {
      notes.push(
        `${d.host}: the repository's registry URL holds a token; save the full URL with the credential`,
      );
      continue;
    }
    // A saved URL on another host (only possible before the save check existed) is never used.
    if (row.url && new URL(row.url).hostname !== row.host) {
      notes.push(`the saved credential for ${row.host} names another host's URL: save it again`);
      continue;
    }
    try {
      const secret = openSecret(key, row.sealed, credentialContext(installationId, row.host));
      // Cargo sends its token as the header itself; everything else as Bearer or Basic.
      const authorization =
        d.ecosystem === "cargo" && row.kind === "token"
          ? secret
          : authorizationOf({ kind: row.kind, username: row.username, secret });
      out.push({
        ecosystem: d.ecosystem,
        url: row.url ?? d.url,
        host: d.host,
        ...(d.scope ? { scope: d.scope } : {}),
        ...(d.replacesBase !== undefined ? { replacesBase: d.replacesBase } : {}),
        authorization,
        secret: { kind: row.kind, username: row.username, value: secret },
      });
      used.push(row.id);
    } catch {
      notes.push(
        `the saved credential for ${row.host} no longer opens: save it again in Settings → Private registries`,
      );
    }
  }
  if (used.length)
    await db
      .update(registryCredentials)
      .set({ lastUsedAt: sql`now()` })
      .where(inArray(registryCredentials.id, used));
  return out;
}
