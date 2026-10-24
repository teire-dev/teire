import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FetchedSource } from "../src/catalog/source";
import { sha256 } from "../src/catalog/source";

export function fixture(name: string) {
  return readFileSync(resolve(import.meta.dirname, "../../../fixtures", name), "utf8");
}

/** A FetchedSource as the ingest step would produce it, from a captured file. */
export function source(name: string, url: string): FetchedSource {
  const body = fixture(name);
  return {
    url,
    body,
    contentHash: sha256(body),
    checkedAt: "2026-10-24T12:00:00.000Z",
    etag: null,
    lastModified: null,
  };
}
