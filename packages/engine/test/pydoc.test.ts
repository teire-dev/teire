import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runPythonHelper } from "../src/python/helper";

// A target wheel as the surface step unpacks it: the package and its dist-info with the README.
const dir = mkdtempSync(join(tmpdir(), "teire-pydoc-"));
mkdirSync(join(dir, "shapes"));
writeFileSync(
  join(dir, "shapes", "__init__.py"),
  `def area(width: float, height: float, *, rounding: int = 2) -> float:
    """The rectangle's area, rounded.

    Args:
        rounding: Digits kept; replaces the old \`precision\` keyword.
    """
    return round(width * height, rounding)


class Box:
    """A box with a label."""

    def __init__(self, label: str, size: int = 1):
        self.label = label
`,
);
mkdirSync(join(dir, "shapes-2.0.0.dist-info"));
writeFileSync(
  join(dir, "shapes-2.0.0.dist-info", "METADATA"),
  `Metadata-Version: 2.1
Name: shapes
Version: 2.0.0

# shapes

Geometry helpers.

## Migrating from 1.x

\`area(precision=...)\` is now \`area(rounding=...)\`.
`,
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface PyDocs {
  objects: { path: string; kind: string; signature: string | null; docstring: string | null }[];
  readme: string[];
}

describe("the target version's own docs for PyPI (R21.5)", () => {
  it("finds the objects a question names, with signature, docstring and the README section", async () => {
    const out = await runPythonHelper<PyDocs>("docs", [dir, "what replaced precision in area()"]);
    const area = out.objects.find((o) => o.path === "shapes.area");
    expect(area?.signature).toBe("def area(width: float, height: float, *, rounding: int = 2) -> float");
    expect(area?.docstring).toContain("replaces the old `precision` keyword");
    expect(out.readme.join("\n")).toContain("area(rounding=...)");
  });

  it("gives a class its constructor's parameters", async () => {
    const out = await runPythonHelper<PyDocs>("docs", [dir, "Box label"]);
    expect(out.objects.find((o) => o.path === "shapes.Box")?.signature).toBe(
      "class Box(label: str, size: int = 1)",
    );
  });

  it("names nothing when the question names nothing in the package", async () => {
    const out = await runPythonHelper<PyDocs>("docs", [dir, "unrelated thing"]);
    expect(out.objects).toEqual([]);
  });
});
