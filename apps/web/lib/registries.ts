import "server-only";
import { eq, registryCredentials, sql } from "@teire/db";
import {
  credentialContext,
  type DiscoveredRegistry,
  keyFromEnv,
  sealSecret,
} from "@teire/engine/credentials";
import { database } from "./db";
import { type Scope, scopeRaw } from "./workspace";

/** A registry the repositories name, with where, and whether a credential is saved for it. */
export interface RegistryRow {
  ecosystem: DiscoveredRegistry["ecosystem"];
  host: string;
  url: string | null;
  scopes: string[];
  /** `owner/repo: file` for each place it is named. */
  namedIn: { repo: string; file: string }[];
  credential: {
    kind: "token" | "basic";
    username: string | null;
    updatedAt: string;
    lastUsedAt: string | null;
  } | null;
}

/** Whether this deployment can seal credentials (the worker's public key is set). */
export function credentialsReady() {
  return Boolean(keyFromEnv(process.env.TEIRE_CREDENTIALS_PUBLIC_KEY));
}

/**
 * Settings → Private registries (S18.7): every registry the installation's repositories name, from
 * each one's latest scan (D-36), joined with the credentials saved for them, and saved ones no scan
 * names any more. The sealed value is never selected (the web role can't read it).
 */
export async function registriesOf(scope: Scope & { installationId: number }) {
  const db = database();
  const [scans, saved] = await Promise.all([
    db.execute<{
      full_name: string;
      registries: DiscoveredRegistry[] | null;
      go_private: string[] | null;
    }>(sql`
      select distinct on (r.id) r.full_name, s.coverage->'registries' as registries, s.coverage->'goPrivate' as go_private
      from scans s join repos r on r.id = s.repo_id join installations i on i.id = r.installation_id
      where ${scopeRaw(scope, "r", "i")} and s.status = 'done' and s.coverage is not null
      order by r.id, s.created_at desc`),
    db
      .select({
        ecosystem: registryCredentials.ecosystem,
        host: registryCredentials.host,
        url: registryCredentials.url,
        kind: registryCredentials.kind,
        username: registryCredentials.username,
        updatedAt: registryCredentials.updatedAt,
        lastUsedAt: registryCredentials.lastUsedAt,
      })
      .from(registryCredentials)
      .where(eq(registryCredentials.installationId, scope.installationId)),
  ]);
  const rows = new Map<string, RegistryRow>();
  const key = (ecosystem: string, host: string) => `${ecosystem}|${host}`;
  for (const scan of scans.rows)
    for (const r of scan.registries ?? []) {
      const row = rows.get(key(r.ecosystem, r.host)) ?? {
        ecosystem: r.ecosystem,
        host: r.host,
        url: r.url,
        scopes: [],
        namedIn: [],
        credential: null,
      };
      if (r.scope && !row.scopes.includes(r.scope)) row.scopes.push(r.scope);
      if (!row.namedIn.some((n) => n.repo === scan.full_name && n.file === r.file))
        row.namedIn.push({ repo: scan.full_name, file: r.file });
      rows.set(key(r.ecosystem, r.host), row);
    }
  for (const c of saved) {
    const row = rows.get(key(c.ecosystem, c.host)) ?? {
      ecosystem: c.ecosystem,
      host: c.host,
      url: c.url,
      scopes: [],
      namedIn: [],
      credential: null,
    };
    row.credential = {
      kind: c.kind,
      username: c.username,
      updatedAt: c.updatedAt.toISOString(),
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    };
    rows.set(key(c.ecosystem, c.host), row);
  }
  const goPrivate = [...new Set(scans.rows.flatMap((s) => s.go_private ?? []))];
  return {
    rows: [...rows.values()].sort(
      (a, b) => Number(!!a.credential) - Number(!!b.credential) || a.host.localeCompare(b.host),
    ),
    goPrivate,
  };
}

/**
 * A credential's plaintext sealed for the worker before it is recorded (S-P20): the request carries
 * `secret`; what is recorded carries only `sealed`, bound to this installation and host.
 */
export function sealCredentialParams(
  params: Record<string, unknown>,
  installationId: number | undefined,
): Record<string, unknown> | { error: string } {
  const key = keyFromEnv(process.env.TEIRE_CREDENTIALS_PUBLIC_KEY);
  if (!key) return { error: "Private registries aren't set up on this Teire deployment yet" };
  if (!installationId) return { error: "no installation" };
  const { secret, ...rest } = params;
  if (typeof secret !== "string" || !secret.trim() || secret.length > 4096)
    return { error: "Enter the token or password" };
  const host = String(rest.host ?? "")
    .trim()
    .toLowerCase();
  return { ...rest, host, sealed: sealSecret(key, secret.trim(), credentialContext(installationId, host)) };
}
