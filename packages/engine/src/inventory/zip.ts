import { inflateRawSync } from "node:zlib";

/**
 * Reads entries of a zip (a jar) in memory: the central directory at the end, then each entry's
 * local header and its stored or deflated bytes. Only the entries `keep` accepts are inflated, and
 * every size is capped, so a hostile archive cannot balloon (research jvm.md: sources jars are read
 * as text, nothing in them runs).
 */
export function readZip(
  buf: Uint8Array,
  keep: (name: string) => boolean,
  limits = { maxEntries: 20_000, maxEntryBytes: 4 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 },
) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map<string, Buffer>();
  // End of central directory: signature 0x06054b50 within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = b.readUInt16LE(eocd + 10);
  let offset = b.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < Math.min(count, limits.maxEntries); n++) {
    if (b.readUInt32LE(offset) !== 0x02014b50) break;
    const method = b.readUInt16LE(offset + 10);
    const compressed = b.readUInt32LE(offset + 20);
    const size = b.readUInt32LE(offset + 24);
    const nameLen = b.readUInt16LE(offset + 28);
    const extraLen = b.readUInt16LE(offset + 30);
    const commentLen = b.readUInt16LE(offset + 32);
    const local = b.readUInt32LE(offset + 42);
    const name = b.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || !keep(name) || size > limits.maxEntryBytes) continue;
    if (b.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + compressed);
    const bytes =
      method === 0
        ? Buffer.from(data)
        : method === 8
          ? inflateRawSync(data, { maxOutputLength: limits.maxEntryBytes })
          : null;
    if (!bytes) continue;
    total += bytes.length;
    if (total > limits.maxTotalBytes) break;
    out.set(name, bytes);
  }
  return out;
}
