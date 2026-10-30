import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CallSite } from "../src/contract";
import type { MigrationNote } from "../src/fix/codemods";
import { noteRenames, planRenames, targetDefinitions } from "../src/fix/renames";

const note = (quote: string, extra: Partial<MigrationNote> = {}): MigrationNote => ({
  summary: "",
  apis: [],
  replacement: null,
  quote,
  url: "https://example.org/changelog",
  ...extra,
});

describe("rename pairs a quoted note states (S15.4)", () => {
  it("reads each wording, by last name", () => {
    expect(noteRenames(note("`rand::thread_rng` has been renamed to `rand::rng`"))).toEqual([
      ["thread_rng", "rng"],
    ]);
    expect(noteRenames(note("We renamed `update_attributes` to `update`."))).toEqual([
      ["update_attributes", "update"],
    ]);
    expect(noteRenames(note("`Matchers.any()` → `ArgumentMatchers.any()`"))).toEqual([
      ["Matchers", "ArgumentMatchers"],
    ]);
    expect(noteRenames(note("`regex` is removed. Use `pattern` instead of `regex`."))).toEqual([
      ["regex", "pattern"],
    ]);
    expect(noteRenames(note("", { apis: ["pgxpool.Connect"], replacement: "pgxpool.New" }))).toEqual([
      ["Connect", "New"],
    ]);
  });

  it("reads no pair from prose or a replacement that is a sentence", () => {
    expect(
      noteRenames(note("The pool was rewritten.", { apis: ["x"], replacement: "use the new builder" })),
    ).toEqual([]);
  });
});

describe("the target's own definitions, per language", () => {
  const rust = targetDefinitions("rust", [
    { text: "pub fn rng() -> ThreadRng {}\n#[deprecated]\npub struct ThreadRng;" },
  ]);
  const ruby = targetDefinitions("ruby", [
    { text: "  def update(attributes)\n  end\n  alias_method :save, :create" },
  ]);
  const python = targetDefinitions("python", [
    { text: "def Field(\n    default=None,\n    pattern: str | None = None,\n):" },
  ]);
  const go = targetDefinitions("go", [
    { text: "func New(ctx context.Context, conn string) (*Pool, error) {" },
  ]);
  const java = targetDefinitions("java", [
    { text: "public class ArgumentMatchers {\n  public static <T> T any() {" },
  ]);

  it("finds declarations, and keyword parameters when asked", () => {
    expect(rust("rng")).toBe(true);
    expect(rust("thread_rng")).toBe(false);
    expect(ruby("update")).toBe(true);
    expect(ruby("update_attributes")).toBe(false);
    expect(python("Field")).toBe(true);
    expect(python("pattern", true)).toBe(true);
    expect(python("regex", true)).toBe(false);
    expect(go("New")).toBe(true);
    expect(go("Connect")).toBe(false);
    expect(java("ArgumentMatchers")).toBe(true);
    expect(java("Matchers")).toBe(false);
  });
});

describe("renames at located sites", () => {
  const dir = mkdtempSync(join(tmpdir(), "teire-renames-"));
  writeFileSync(
    join(dir, "lib.rs"),
    "use rand::thread_rng;\nfn roll() -> u8 {\n    let mut r = thread_rng();\n    r.gen_range(1..7)\n}\n",
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const site = (line: number, column: number, kind: CallSite["kind"] = "call") =>
    ({ file: "lib.rs", line, column, kind, snippet: "" }) as CallSite;
  const defines = targetDefinitions("rust", [{ text: "pub fn rng() -> ThreadRng {}" }]);
  const notes = [note("`thread_rng` was renamed to `rng`")];

  it("edits the old name at each site, the import included", () => {
    const edits = planRenames({ repoDir: dir, sites: [site(1, 11, "import"), site(3, 17)], notes, defines });
    expect(edits.map((e) => e.after)).toEqual(["use rand::rng;", "    let mut r = rng();"]);
    expect(edits[0]?.reason).toBe("thread_rng → rng");
  });

  it("edits nothing when the target still defines the old name or lacks the new one", () => {
    const both = targetDefinitions("rust", [{ text: "pub fn rng() {}\npub fn thread_rng() {}" }]);
    expect(planRenames({ repoDir: dir, sites: [site(3, 17)], notes, defines: both })).toEqual([]);
    const neither = targetDefinitions("rust", [{ text: "pub fn other() {}" }]);
    expect(planRenames({ repoDir: dir, sites: [site(3, 17)], notes, defines: neither })).toEqual([]);
  });

  it("leaves a site found by its name alone to the agent", () => {
    const loose = { ...site(3, 17), resolution: "name-only" } as CallSite;
    expect(planRenames({ repoDir: dir, sites: [loose], notes, defines })).toEqual([]);
  });
});
