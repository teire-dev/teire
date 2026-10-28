import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { createGunzip, gunzipSync } from "node:zlib";
import { SCAN } from "../constants";

/**
 * Teire's own tar(.gz) extractor for untrusted archives (repo tarballs, package tarballs; plan D75).
 * Regular files and directories only: symlinks, hard links and devices are skipped and reported.
 * Paths that are absolute or climb out with `..` are refused. Entry count and bytes are capped.
 */
export interface ExtractLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Leading path components to drop (GitHub tarballs wrap everything in `<owner>-<repo>-<sha>/`). */
  stripComponents: number;
}

export interface ExtractReport {
  files: number;
  bytes: number;
  skipped: { path: string; reason: "link" | "special" | "too-large" | "unsafe-path" }[];
  /** Commit id GitHub records in the global pax header (`comment=<sha>`). */
  comment?: string;
}

export class ArchiveLimitError extends Error {}

const BLOCK = 512;

export const DEFAULT_LIMITS: ExtractLimits = {
  maxEntries: SCAN.maxFiles,
  maxFileBytes: SCAN.maxFileBytes,
  maxTotalBytes: SCAN.maxExtractedBytes,
  stripComponents: 1,
};

function readString(buf: Uint8Array, offset: number, length: number) {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

function readOctal(buf: Uint8Array, offset: number, length: number) {
  const text = readString(buf, offset, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

/** Parses pax records `"<len> <key>=<value>\n"`. */
function parsePax(data: Uint8Array) {
  const text = new TextDecoder().decode(data);
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space === -1) break;
    const length = Number(text.slice(i, space));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, i + length - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return out;
}

/** Joins `name` under `root` only if the result stays inside `root`. */
export function safeJoin(root: string, name: string): string | null {
  if (!name || isAbsolute(name) || name.includes("\0")) return null;
  const normalized = normalize(name);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.split(sep).includes(".."))
    return null;
  const full = join(root, normalized);
  return full === root || full.startsWith(root + sep) ? full : null;
}

function strip(path: string, components: number) {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(components).join("/");
}

/** Bytes arriving in chunks, read back by length without copying the whole stream (a tar parser's queue). */
class ByteQueue {
  #chunks: Uint8Array[] = [];
  #length = 0;
  #done = false;
  readonly #source: AsyncIterator<Uint8Array>;
  constructor(source: AsyncIterable<Uint8Array>) {
    this.#source = source[Symbol.asyncIterator]();
  }
  /** Whether `n` bytes are available, reading more from the source as needed. */
  async has(n: number) {
    while (this.#length < n && !this.#done) {
      const next = await this.#source.next();
      if (next.done) this.#done = true;
      else if (next.value.byteLength) {
        this.#chunks.push(next.value);
        this.#length += next.value.byteLength;
      }
    }
    return this.#length >= n;
  }
  /** The next `n` bytes as one array (call `has(n)` first). */
  take(n: number) {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.#chunks[0] as Uint8Array;
      const k = Math.min(n - filled, head.byteLength);
      out.set(head.subarray(0, k), filled);
      filled += k;
      if (k === head.byteLength) this.#chunks.shift();
      else this.#chunks[0] = head.subarray(k);
    }
    this.#length -= n;
    return out;
  }
  /** Drops `n` bytes without keeping them (entries Teire skips). */
  async skip(n: number) {
    let left = n;
    while (left > 0) {
      if (!this.#length && !(await this.has(1))) return;
      const head = this.#chunks[0] as Uint8Array;
      const k = Math.min(left, head.byteLength);
      if (k === head.byteLength) this.#chunks.shift();
      else this.#chunks[0] = head.subarray(k);
      this.#length -= k;
      left -= k;
    }
  }
}

/** Pax, long-name and global headers are small; a bigger one is not a tarball Teire reads. */
const MAX_META_BYTES = 1024 * 1024;

/**
 * Extracts a tar arriving as chunks into `dest` (review R17): only one entry's data is held at a time
 * (at most `maxFileBytes`), skipped entries are read past, never stored.
 */
export async function extractTarStream(
  source: AsyncIterable<Uint8Array>,
  dest: string,
  limitsIn: Partial<ExtractLimits> = {},
): Promise<ExtractReport> {
  const limits = { ...DEFAULT_LIMITS, ...limitsIn };
  const report: ExtractReport = { files: 0, bytes: 0, skipped: [] };
  const queue = new ByteQueue(source);
  let entries = 0;
  let longName: string | null = null;
  let pax: Record<string, string> = {};

  while (await queue.has(BLOCK)) {
    const header = queue.take(BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const read = async () => {
      if (!(await queue.has(padded))) throw new ArchiveLimitError("archive ends inside an entry");
      return queue.take(padded).subarray(0, size);
    };

    if (type === "g" || type === "x" || type === "L") {
      if (size > MAX_META_BYTES) throw new ArchiveLimitError("archive header entry too large");
      const data = await read();
      if (type === "g") {
        const global = parsePax(data);
        if (global.comment) report.comment = global.comment;
      } else if (type === "x") pax = parsePax(data);
      else longName = readString(data, 0, data.length);
      continue;
    }

    const prefix = readString(header, 345, 155);
    const rawName =
      pax.path ??
      longName ??
      (prefix ? `${prefix}/${readString(header, 0, 100)}` : readString(header, 0, 100));
    pax = {};
    longName = null;
    if (++entries > limits.maxEntries)
      throw new ArchiveLimitError(`archive has more than ${limits.maxEntries} entries`);

    const name = strip(rawName, limits.stripComponents);
    const target = name ? safeJoin(dest, name) : null;
    const skip = (reason?: ExtractReport["skipped"][number]["reason"], path = name) => {
      if (reason) report.skipped.push({ path, reason });
      return queue.skip(padded);
    };
    if (!name) {
      await skip();
      continue;
    }
    if (!target) {
      await skip("unsafe-path", rawName);
      continue;
    }
    if (type === "5") {
      await mkdir(target, { recursive: true });
      await skip();
      continue;
    }
    if (type === "1" || type === "2") {
      await skip("link");
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7") {
      await skip("special");
      continue;
    }
    if (size > limits.maxFileBytes) {
      await skip("too-large");
      continue;
    }
    report.bytes += size;
    if (report.bytes > limits.maxTotalBytes)
      throw new ArchiveLimitError(`archive expands past ${limits.maxTotalBytes} bytes`);
    const data = await read();
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { mode: 0o644 });
    report.files++;
  }
  return report;
}

/** Extracts a tar held in memory into `dest` (the streaming extractor, given one chunk). */
export async function extractTar(
  tar: Uint8Array,
  dest: string,
  limitsIn: Partial<ExtractLimits> = {},
): Promise<ExtractReport> {
  return extractTarStream(
    (async function* () {
      yield tar;
    })(),
    dest,
    limitsIn,
  );
}

/** Extracts a gzipped tar held in memory into `dest` (package tarballs, bounded by their own fetch). */
export async function extractTarGz(archive: Uint8Array, dest: string, limits: Partial<ExtractLimits> = {}) {
  const tar = gunzipSync(archive, {
    maxOutputLength: (limits.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes) + 64 * 1024 * 1024,
  });
  return extractTar(tar, dest, limits);
}

/** Extracts a gzipped tar arriving as chunks, decompressing as it goes. */
export async function extractTarGzStream(
  source: AsyncIterable<Uint8Array>,
  dest: string,
  limits: Partial<ExtractLimits> = {},
) {
  const gunzip = createGunzip();
  const input = Readable.from(source);
  input.on("error", (error) => gunzip.destroy(error));
  return extractTarStream(input.pipe(gunzip), dest, limits);
}
