import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { gunzipSync } from "node:zlib";
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

/** Extracts a gzipped tar held in memory into `dest`. */
export async function extractTarGz(archive: Uint8Array, dest: string, limits: Partial<ExtractLimits> = {}) {
  const tar = gunzipSync(archive, {
    maxOutputLength: (limits.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes) + 64 * 1024 * 1024,
  });
  return extractTar(tar, dest, limits);
}

export async function extractTar(
  tar: Uint8Array,
  dest: string,
  limitsIn: Partial<ExtractLimits> = {},
): Promise<ExtractReport> {
  const limits = { ...DEFAULT_LIMITS, ...limitsIn };
  const report: ExtractReport = { files: 0, bytes: 0, skipped: [] };
  let entries = 0;
  let longName: string | null = null;
  let pax: Record<string, string> = {};
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "g") {
      const global = parsePax(data);
      if (global.comment) report.comment = global.comment;
      continue;
    }
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "L") {
      longName = readString(data, 0, data.length);
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
    if (!name) continue;
    const target = safeJoin(dest, name);
    if (!target) {
      report.skipped.push({ path: rawName, reason: "unsafe-path" });
      continue;
    }
    if (type === "5") {
      await mkdir(target, { recursive: true });
      continue;
    }
    if (type === "1" || type === "2") {
      report.skipped.push({ path: name, reason: "link" });
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7") {
      report.skipped.push({ path: name, reason: "special" });
      continue;
    }
    if (size > limits.maxFileBytes) {
      report.skipped.push({ path: name, reason: "too-large" });
      continue;
    }
    report.bytes += size;
    if (report.bytes > limits.maxTotalBytes)
      throw new ArchiveLimitError(`archive expands past ${limits.maxTotalBytes} bytes`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { mode: 0o644 });
    report.files++;
  }
  return report;
}
