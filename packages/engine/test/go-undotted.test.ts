import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readGoInventory } from "../src/inventory/go";
import { directoryTree } from "../src/inventory/tree";

describe("a Go module path with no dot (D-33)", () => {
  const dir = mkdtempSync(join(tmpdir(), "teire-go-undotted-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("marks it local and still resolves the rest with the toolchain", async () => {
    writeFileSync(
      join(dir, "go.mod"),
      "module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/google/uuid v1.6.0\n\tmycorp/internal/auth v1.2.0\n)\n",
    );
    writeFileSync(
      join(dir, "go.sum"),
      "github.com/google/uuid v1.6.0 h1:NIvaJDMOsjHA8n1jAhLSgzrAzy1Hgr+hNrb57e+94F0=\ngithub.com/google/uuid v1.6.0/go.mod h1:TIyPZe4MgqvfeYDBFedMoGGpEw/LqOeaOT+nhxU+yHo=\n",
    );
    const [project] = await readGoInventory(dir, directoryTree(dir));
    const of = (name: string) => project?.instances.find((i) => i.name === name);
    expect(of("mycorp/internal/auth")).toMatchObject({
      version: null,
      source: "unknown",
      resolvedBy: "unresolved",
    });
    expect(of("github.com/google/uuid")).toMatchObject({ version: "v1.6.0", resolvedBy: "toolchain" });
    expect(project?.notes.some((n) => n.startsWith("go list -m all failed"))).toBe(false);
  }, 60_000);
});
