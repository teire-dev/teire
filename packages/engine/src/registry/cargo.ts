import { RUST } from "../constants";
import { guardedFetch } from "../net/fetch";

/**
 * The crates.io sparse index (research rust.md Job 2): one JSON line per published version with
 * `pubtime`, `yanked`, `rust_version`, `features`/`features2` and dependencies. "No rate limits are
 * required to use data from the sparse crate index" (crates.io data-access policy); responses carry
 * ETags. Versions and yanks for targets come from deps.dev like every other ecosystem; this adds
 * what only the index has.
 */
export interface IndexLine {
  name: string;
  vers: string;
  yanked: boolean;
  pubtime?: string;
  rust_version?: string;
  features: Record<string, string[]>;
  features2?: Record<string, string[]>;
  deps: { name: string; req: string; kind?: string; optional?: boolean; package?: string }[];
}

/** `rand` → `ra/nd/rand`, `cc` → `2/cc`, `syn` → `3/s/syn`. */
export function indexPath(name: string) {
  const n = name.toLowerCase();
  if (n.length <= 2) return `${n.length}/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

const memo = new Map<string, Promise<IndexLine[]>>();

export function cratesIndexLines(name: string): Promise<IndexLine[]> {
  const key = name.toLowerCase();
  const known = memo.get(key);
  if (known) return known;
  const pending = (async () => {
    const res = await guardedFetch(`https://index.crates.io/${indexPath(name)}`, {
      allowHosts: ["index.crates.io"],
      headers: { "user-agent": RUST.userAgent },
      maxBytes: 16 * 1024 * 1024,
    });
    if (res.status === 404) return [];
    if (res.status !== 200) throw new Error(`crates.io index ${res.status} for ${name}`);
    return res
      .text()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as IndexLine);
  })();
  memo.set(key, pending);
  pending.catch(() => memo.delete(key));
  return pending;
}
