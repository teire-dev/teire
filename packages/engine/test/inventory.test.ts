import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { ArchiveLimitError, extractTar, extractTarGz, safeJoin } from "../src/inventory/archive";
import { readJsInventory } from "../src/inventory/js";
import { directoryTree } from "../src/inventory/tree";

const fixtures = resolve(import.meta.dirname, "../../../fixtures/js");

/** The same monorepo locked by every package manager generation (fixtures/js/*). */
const EXPECTED = [
  ".|dev|typescript=5.9.3",
  ".|prod|openai=4.104.0",
  ".|prod|strip-ansi-cjs->strip-ansi=6.0.1",
  ".|prod|zod=3.25.76",
  "packages/a|prod|stripe=17.7.0",
  "packages/b|prod|@fx/a=ws:packages/a",
  "packages/b|prod|lodash=4.17.20",
];

function table(variant: string) {
  const [project] = readJsInventory(directoryTree(join(fixtures, variant)));
  const rows = (project?.instances ?? [])
    .filter((i) => i.direct)
    .map(
      (i) =>
        `${i.workspace}|${i.scope}|${i.aliasName ? `${i.aliasName}->` : ""}${i.name}=${i.version ?? (i.source === "workspace" ? `ws:${i.sourceRef}` : "UNRESOLVED")}`,
    )
    .sort();
  return { project, rows };
}

describe("JS inventory", () => {
  for (const variant of ["npm3", "npm2", "pnpm9", "pnpm6", "pnpm54", "yarn1", "berry", "bun"]) {
    it(`reads ${variant} into the same table`, () => {
      const { project, rows } = table(variant);
      expect(rows).toEqual(EXPECTED);
      expect(project?.instances.some((i) => !i.direct)).toBe(true);
    });
  }

  it("reads npm lockfile v1 for the root importer", () => {
    expect(table("npm1").rows).toEqual(EXPECTED.filter((r) => r.startsWith(".|")));
  });

  it("reports every dependency unresolved when there is no lockfile, never guessing", () => {
    const tree = {
      files: () => ["package.json"],
      read: (p: string) => (p === "package.json" ? '{"dependencies":{"openai":"^4.0.0"}}' : null),
    };
    const [project] = readJsInventory(tree);
    expect(project?.instances).toEqual([
      expect.objectContaining({
        name: "openai",
        version: null,
        resolvedBy: "unresolved",
        unresolvedReason: "no lockfile",
      }),
    ]);
  });
});

/** Builds one ustar header + data block. */
function tarEntry(name: string, body: string, type = "0", linkname = "") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${Buffer.byteLength(body).toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write(type, 156);
  header.write(linkname, 157, 100);
  header.write("ustar\0", 257);
  header.write("        ", 148);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  data.write(body);
  return Buffer.concat([header, data]);
}

describe("safe extraction", () => {
  const dest = mkdtempSync(join(tmpdir(), "teire-extract-"));
  afterAll(() => rmSync(dest, { recursive: true, force: true }));

  it("strips the wrapper dir, writes files, and refuses links and escapes", async () => {
    const archive = gzipSync(
      Buffer.concat([
        tarEntry("repo-abc123/package.json", '{"name":"x"}'),
        tarEntry("repo-abc123/../evil.txt", "nope"),
        tarEntry("repo-abc123/link", "", "2", "/etc/passwd"),
        Buffer.alloc(1024),
      ]),
    );
    const report = await extractTarGz(archive, dest);
    expect(report.files).toBe(1);
    expect(report.skipped.map((s) => s.reason).sort()).toEqual(["link", "unsafe-path"]);
    expect(directoryTree(dest).read("package.json")).toBe('{"name":"x"}');
  });

  // Review round 2: metadata and skipped bytes count, a truncated skip fails, absolute names are refused.
  it("counts metadata entries and every expanded byte against the limits", async () => {
    const pax = (i: number) =>
      tarEntry(`PaxHeaders/${i}`, `20 comment=x${String(i).padStart(4, "0")}\n`, "x");
    const many = Buffer.concat([...Array.from({ length: 8 }, (_, i) => pax(i)), Buffer.alloc(1024)]);
    await expect(extractTar(many, dest, { maxEntries: 5 })).rejects.toThrow(/header entries/);
    const big = Buffer.concat([tarEntry("repo/big.bin", "x".repeat(4000)), Buffer.alloc(1024)]);
    await expect(extractTar(big, dest, { maxFileBytes: 1000, maxExpandedBytes: 2048 })).rejects.toThrow(
      ArchiveLimitError,
    );
  });

  it("refuses an archive that ends inside a skipped entry, and absolute names", async () => {
    const truncated = tarEntry("repo/big.bin", "x".repeat(4000)).subarray(0, 512 + 600);
    await expect(extractTar(truncated, dest, { maxFileBytes: 1000 })).rejects.toThrow(/ends inside an entry/);
    const report = await extractTar(
      Buffer.concat([tarEntry("/etc/passwd", "root"), tarEntry("../up/x", "y"), Buffer.alloc(1024)]),
      dest,
    );
    expect(report.files).toBe(0);
    expect(report.skipped.map((s) => s.reason)).toEqual(["unsafe-path", "unsafe-path"]);
  });

  it("joins only inside the root", () => {
    expect(safeJoin("/tmp/r", "a/b.txt")).toBe("/tmp/r/a/b.txt");
    expect(safeJoin("/tmp/r", "../x")).toBeNull();
    expect(safeJoin("/tmp/r", "/etc/passwd")).toBeNull();
    expect(safeJoin("/tmp/r", "a/../../x")).toBeNull();
  });
});
