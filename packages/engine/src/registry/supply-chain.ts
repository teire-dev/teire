import { gunzipSync } from "node:zlib";
import { JVM, RUBY, RUST } from "../constants";
import { guardedFetch } from "../net/fetch";
import type { RegistryOptions } from "./clients";
import { getPypiIndex, versionFiles } from "./pypi";

/**
 * Supply-chain signals beyond npm (D-14, R21.6): what changed about who published a version and what
 * runs when it installs, installed version → target, read only from what each registry publishes.
 * A field a registry doesn't publish is never guessed: PyPI and RubyGems name only today's owners,
 * so Teire keeps a snapshot from when a scan first saw the installed version and compares today's
 * with it; Maven Central requires a signature on every file, so the signal there is a different
 * signing key; the Go proxy publishes none of this.
 */

/** Entries of an in-memory tar (512-byte headers, ustar prefix for long names). */
function tarEntries(tar: Uint8Array): { name: string; data: Uint8Array }[] {
  const out: { name: string; data: Uint8Array }[] = [];
  const text = (b: Uint8Array) => Buffer.from(b).toString("utf8").replace(/\0.*$/s, "");
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    const name = text(header.subarray(0, 100));
    if (!name) break;
    const prefix = text(header.subarray(345, 500));
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || "0", 8);
    const start = off + 512;
    out.push({ name: prefix ? `${prefix}/${name}` : name, data: tar.subarray(start, start + size) });
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

// --- crates.io ------------------------------------------------------------------------------------

interface CrateVersion {
  publisher: string | null;
  buildScript: boolean | null;
}

async function crateVersion(name: string, version: string): Promise<CrateVersion> {
  const headers = { "user-agent": RUST.userAgent };
  const api = await guardedFetch(`https://crates.io/api/v1/crates/${name}/${version}`, {
    allowHosts: ["crates.io"],
    headers,
  });
  const publisher =
    api.status === 200
      ? (api.json<{ version?: { published_by?: { login?: string } | null } }>().version?.published_by
          ?.login ?? null)
      : null;
  // The published Cargo.toml is normalised by `cargo publish`: a build script is named there.
  let buildScript: boolean | null = null;
  const crate = await guardedFetch(`https://static.crates.io/crates/${name}/${name}-${version}.crate`, {
    allowHosts: ["static.crates.io"],
    headers,
    maxBytes: 32 * 1024 * 1024,
  }).catch(() => null);
  if (crate?.status === 200) {
    const entries = tarEntries(gunzipSync(crate.body, { maxOutputLength: 256 * 1024 * 1024 }));
    const root = `${name}-${version}/`;
    const manifest = entries.find((e) => e.name === `${root}Cargo.toml`);
    const declared = manifest
      ? /^\s*build\s*=\s*"[^"]+"/m.test(Buffer.from(manifest.data).toString("utf8"))
      : false;
    buildScript = declared || entries.some((e) => e.name === `${root}build.rs`);
  }
  return { publisher, buildScript };
}

export async function crateSignals(name: string, from: string, to: string): Promise<string[]> {
  const [a, b] = await Promise.all([crateVersion(name, from), crateVersion(name, to)]);
  const out: string[] = [];
  if (a.buildScript === false && b.buildScript === true)
    out.push(`${to} adds a build script (\`build.rs\`) that runs when the crate compiles`);
  if (a.publisher && b.publisher && a.publisher !== b.publisher)
    out.push(
      `${to} was published by the crates.io account \`${b.publisher}\`; ${from} by \`${a.publisher}\``,
    );
  return out;
}

// --- PyPI -----------------------------------------------------------------------------------------

/** Who published a file through Trusted Publishing (PEP 740), or null for a file with no attestation. */
export async function pypiPublisher(name: string, version: string, filename: string): Promise<string | null> {
  const res = await guardedFetch(
    `https://pypi.org/integrity/${encodeURIComponent(name)}/${encodeURIComponent(version)}/${encodeURIComponent(filename)}/provenance`,
    { allowHosts: ["pypi.org"], headers: { accept: "application/vnd.pypi.integrity.v1+json" } },
  );
  if (res.status !== 200) return null;
  const bundle = res.json<{
    attestation_bundles?: { publisher?: { kind?: string; repository?: string; workflow?: string } }[];
  }>().attestation_bundles?.[0]?.publisher;
  if (!bundle) return null;
  return [bundle.kind, bundle.repository, bundle.workflow].filter(Boolean).join(" ");
}

export async function pypiSignals(
  name: string,
  from: string,
  to: string,
  options: RegistryOptions,
): Promise<string[]> {
  const index = await getPypiIndex(name, options);
  if (!index) return [];
  const files = (v: string) => versionFiles(index, v).filter((f) => !f.yanked);
  const [old, next] = [files(from), files(to)];
  const out: string[] = [];
  const wheel = (fs: typeof old) => fs.some((f) => f.filename.endsWith(".whl"));
  if (wheel(old) && next.length && !wheel(next))
    out.push(`${to} publishes only a source distribution: installing it runs its build backend`);
  const first = (fs: typeof old) => fs.find((f) => f.filename.endsWith(".whl")) ?? fs[0];
  const [fa, fb] = [first(old), first(next)];
  if (fa && fb) {
    const [pa, pb] = await Promise.all([
      pypiPublisher(name, from, fa.filename).catch(() => null),
      pypiPublisher(name, to, fb.filename).catch(() => null),
    ]);
    if (pa && !pb) out.push(`${to} has no provenance attestation, though ${from} had one (${pa})`);
    else if (pa && pb && pa !== pb) out.push(`${to} was published by ${pb}; ${from} by ${pa}`);
  }
  const owners = await ownerChange("pypi", name, from, options).catch(() => null);
  if (owners) out.push(owners);
  return out;
}

// --- RubyGems -------------------------------------------------------------------------------------

/** The gemspec's `extensions` (native code built at install), from the .gem's `metadata.gz`. */
export async function gemExtensions(name: string, version: string): Promise<string[] | null> {
  const res = await guardedFetch(
    `https://rubygems.org/downloads/${encodeURIComponent(name)}-${version}.gem`,
    {
      allowHosts: ["rubygems.org", "index.rubygems.org", ".rubygems.org"],
      maxBytes: RUBY.maxGemBytes,
      timeoutMs: 120_000,
    },
  );
  if (res.status !== 200) return null;
  const metadata = tarEntries(res.body).find((e) => e.name === "metadata.gz");
  if (!metadata) return null;
  return gemspecExtensions(gunzipSync(metadata.data).toString("utf8"));
}

/** A YAML gemspec's `extensions`, inline (`[a, b]`) or as a block list. */
export function gemspecExtensions(spec: string): string[] {
  const inline = /^extensions:\s*\[(.*)\]\s*$/m.exec(spec);
  if (inline)
    return (inline[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const block = /^extensions:\s*\n((?:- .*\n?)+)/m.exec(spec);
  return block
    ? (block[1] ?? "")
        .split("\n")
        .map((l) => l.replace(/^- /, "").trim())
        .filter(Boolean)
    : [];
}

export async function gemSignals(
  name: string,
  from: string,
  to: string,
  options: RegistryOptions,
): Promise<string[]> {
  const [a, b, owners] = await Promise.all([
    gemExtensions(name, from).catch(() => null),
    gemExtensions(name, to).catch(() => null),
    ownerChange("rubygems", name, from, options).catch(() => null),
  ]);
  const added = a && b ? b.filter((e) => !a.includes(e)) : [];
  return [
    ...(added.length
      ? [`${to} adds a native extension (\`${added.join("`, `")}\`) that compiles when the gem installs`]
      : []),
    ...(owners ? [owners] : []),
  ];
}

// --- Owners (PyPI, RubyGems) ----------------------------------------------------------------------

/** Today's owners: PyPI's `ownership` (roles and organisation), RubyGems' `owners.json`. */
export async function packageOwners(ecosystem: "pypi" | "rubygems", name: string): Promise<string[] | null> {
  if (ecosystem === "pypi") {
    const res = await guardedFetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
      allowHosts: ["pypi.org"],
      maxBytes: 64 * 1024 * 1024,
    });
    if (res.status !== 200) return null;
    const own = res.json<{
      ownership?: { organization?: string | null; roles?: { role?: string; user?: string }[] };
    }>().ownership;
    if (!own) return null;
    return [
      ...(own.organization ? [`organization ${own.organization}`] : []),
      ...(own.roles ?? []).flatMap((r) => (r.user ? [r.user] : [])),
    ].sort();
  }
  const res = await guardedFetch(`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}/owners.json`, {
    allowHosts: ["rubygems.org"],
  });
  if (res.status !== 200) return null;
  return res
    .json<{ id?: number; handle?: string | null }[]>()
    .flatMap((o) => (o.handle ? [o.handle] : o.id ? [`account ${o.id}`] : []))
    .sort();
}

const ownersKey = (name: string, version: string) => `owners:${name}@${version}`;

/**
 * Keeps the owners a scan first sees at the installed version (one snapshot per package and
 * version, never overwritten), so a later upgrade compares against who owned it then.
 */
export async function snapshotOwners(
  ecosystem: "pypi" | "rubygems",
  name: string,
  version: string,
  options: RegistryOptions,
) {
  if (await options.cache.get(ecosystem, ownersKey(name, version))) return;
  const owners = await packageOwners(ecosystem, name).catch(() => null);
  if (!owners) return;
  await options.cache.put(ecosystem, ownersKey(name, version), {
    etag: null,
    lastModified: null,
    bodyHash: owners.join(","),
    data: owners,
    fetchedAt: (options.now ?? new Date()).toISOString(),
  });
}

/** Owners added or removed since the snapshot at the installed version; null without one. */
export async function ownerChange(
  ecosystem: "pypi" | "rubygems",
  name: string,
  from: string,
  options: RegistryOptions,
): Promise<string | null> {
  const snapshot = await options.cache.get(ecosystem, ownersKey(name, from));
  if (!snapshot || !Array.isArray(snapshot.data)) return null;
  const now = await packageOwners(ecosystem, name).catch(() => null);
  if (!now) return null;
  const before = snapshot.data as string[];
  const added = now.filter((o) => !before.includes(o));
  const removed = before.filter((o) => !now.includes(o));
  if (!added.length && !removed.length) return null;
  const list = (xs: string[]) => xs.map((x) => `\`${x}\``).join(", ");
  return `${name}'s owners changed since ${snapshot.fetchedAt.slice(0, 10)}, when Teire first saw ${from} here: ${[
    added.length ? `added ${list(added)}` : "",
    removed.length ? `removed ${list(removed)}` : "",
  ]
    .filter(Boolean)
    .join("; ")}`;
}

// --- Maven Central --------------------------------------------------------------------------------

/**
 * The issuer of an OpenPGP v4 signature (RFC 9580 §5.2.3): the issuer fingerprint subpacket (33) or
 * the issuer key ID (16), as the key ID's hex. Null for anything else.
 */
export function signatureKeyId(armored: string): string | null {
  const body = armored
    .replace(/-----BEGIN PGP SIGNATURE-----/, "")
    .replace(/-----END PGP SIGNATURE-----[\s\S]*/, "")
    .split("\n")
    .filter((l) => l && !/^[A-Za-z-]+: /.test(l) && !l.startsWith("="))
    .join("");
  const bytes = Buffer.from(body, "base64");
  if (bytes.length < 8) return null;
  let i = 0;
  const tag = bytes[i++] as number;
  if (!(tag & 0x80)) return null;
  // Packet length: new format (0x40) or old format; only the signature packet (tag 2) is read.
  if (tag & 0x40) {
    if ((tag & 0x3f) !== 2) return null;
    const first = bytes[i++] as number;
    i += first < 192 ? 0 : first < 224 ? 1 : 4;
  } else {
    if (((tag >> 2) & 0x0f) !== 2) return null;
    i += [1, 2, 4][tag & 0x03] ?? 0;
  }
  if (bytes[i] !== 4) return null;
  i += 4; // version, type, public-key and hash algorithms
  const areas: Uint8Array[] = [];
  for (let n = 0; n < 2 && i + 2 <= bytes.length; n++) {
    const len = ((bytes[i] as number) << 8) | (bytes[i + 1] as number);
    areas.push(bytes.subarray(i + 2, i + 2 + len));
    i += 2 + len;
  }
  for (const area of areas) {
    let j = 0;
    while (j < area.length) {
      let len = area[j++] as number;
      if (len >= 192 && len < 255) len = ((len - 192) << 8) + (area[j++] as number) + 192;
      else if (len === 255) {
        len =
          ((area[j] as number) << 24) |
          ((area[j + 1] as number) << 16) |
          ((area[j + 2] as number) << 8) |
          (area[j + 3] as number);
        j += 4;
      }
      const type = (area[j] as number) & 0x7f;
      const data = area.subarray(j + 1, j + len);
      if (type === 33 && data.length >= 21)
        return Buffer.from(data.subarray(-8)).toString("hex").toUpperCase();
      if (type === 16 && data.length === 8) return Buffer.from(data).toString("hex").toUpperCase();
      j += len;
    }
  }
  return null;
}

async function mavenKeyId(coordinate: string, version: string): Promise<string | null> {
  const [group, artifact] = coordinate.split(":");
  if (!group || !artifact) return null;
  const base = `${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}`;
  for (const mirror of JVM.mavenMirrors)
    for (const ext of ["jar", "pom"]) {
      const res = await guardedFetch(`${mirror}/${base}.${ext}.asc`, {
        allowHosts: [new URL(mirror).hostname],
      }).catch(() => null);
      if (res?.status === 200) return signatureKeyId(res.text());
    }
  return null;
}

export async function mavenSignals(coordinate: string, from: string, to: string): Promise<string[]> {
  const [a, b] = await Promise.all([mavenKeyId(coordinate, from), mavenKeyId(coordinate, to)]);
  return a && b && a !== b ? [`${to} is signed with a different key (\`${b}\`) than ${from} (\`${a}\`)`] : [];
}

// --- Go -------------------------------------------------------------------------------------------

/** Said instead of an empty section: the module proxy publishes no publisher or provenance data. */
export const GO_SUPPLY_CHAIN_NOTE =
  "The Go module proxy publishes no publisher, signing or install-script data to compare; go.sum checks the module's content against the checksum database.";
