import {
  constants,
  createCipheriv,
  createDecipheriv,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";

/**
 * Private-registry credentials, sealed for the worker (S-P20). The web seals each secret with the
 * worker's public key: a one-time AES-256-GCM key encrypts it and RSA-OAEP-256 wraps that key, as
 * GitHub seals Dependabot secrets with a repository's public key. The database and the web hold
 * only ciphertext; only the worker's private key opens it. The installation and host are bound in
 * as associated data, so a sealed value copied to another row doesn't open.
 */
const VERSION = "v1";

const b64 = (b: Buffer) => b.toString("base64url");

export function sealSecret(publicKeyPem: string, secret: string, context: string): string {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const wrapped = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    key,
  );
  return [VERSION, b64(wrapped), b64(iv), b64(cipher.getAuthTag()), b64(body)].join(".");
}

export function openSecret(privateKeyPem: string, sealed: string, context: string): string {
  const [version, wrapped, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !wrapped || !iv || !tag || body === undefined)
    throw new Error("not a sealed credential");
  const key = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(wrapped, "base64url"),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

/** What a sealed value is bound to: one installation's credential for one host. */
export const credentialContext = (installationId: number, host: string) =>
  `teire-registry|${installationId}|${host}`;

/** A registry a repo installs from other than its ecosystem's public one (D-36). */
export interface DiscoveredRegistry {
  ecosystem: "npm" | "pypi" | "cargo" | "rubygems" | "maven" | "go";
  /** The base URL as the repo names it, with any credentials in it removed. */
  url: string;
  host: string;
  /** The npm scope (`@acme`) or Cargo registry name it serves, when it serves only that. */
  scope?: string;
  /** A PyPI index that replaces pypi.org (`--index-url`) rather than adding to it (`--extra-index-url`). */
  replacesBase?: boolean;
  /** The file that names it. */
  file: string;
}

/** A registry credential as the worker uses it, once opened. */
export interface RegistryCredential {
  ecosystem: "npm" | "pypi" | "cargo" | "rubygems" | "maven" | "go";
  host: string;
  /** The registry's base URL, when the repo named one (`https://npm.pkg.github.com/acme`). */
  url: string | null;
  kind: "token" | "basic";
  username: string | null;
  secret: string;
}

/** The `Authorization` header a credential sends. */
export function authorizationOf(c: Pick<RegistryCredential, "kind" | "username" | "secret">) {
  return c.kind === "basic"
    ? `Basic ${Buffer.from(`${c.username ?? ""}:${c.secret}`).toString("base64")}`
    : `Bearer ${c.secret}`;
}

/** A PEM key from the environment, stored as the PEM itself or base64 of it (one line for env files). */
export function keyFromEnv(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (v.startsWith("-----BEGIN")) return v;
  const pem = Buffer.from(v, "base64").toString("utf8");
  return pem.startsWith("-----BEGIN") ? pem : null;
}
