import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gemspecExtensions, signatureKeyId } from "../src/registry/supply-chain";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", "supply-chain", name), "utf8");

describe("supply-chain signals beyond npm (D-14)", () => {
  it("reads the signing key of a Maven Central signature (Guava 33.4.0, recorded)", () => {
    expect(signatureKeyId(fixture("guava-33.4.0-jre.jar.asc"))).toBe("F6D4A1D411E9D1AE");
  });

  it("reads nothing from text that isn't a signature", () => {
    expect(signatureKeyId("not a signature")).toBeNull();
    expect(signatureKeyId("-----BEGIN PGP SIGNATURE-----\n\nAAAA\n-----END PGP SIGNATURE-----")).toBeNull();
  });

  it("reads a gemspec's native extensions in both YAML forms", () => {
    expect(
      gemspecExtensions(
        "--- !ruby/object:Gem::Specification\nname: json\nextensions:\n- ext/json/ext/generator/extconf.rb\n- ext/json/ext/parser/extconf.rb\nfiles:\n- lib/json.rb\n",
      ),
    ).toEqual(["ext/json/ext/generator/extconf.rb", "ext/json/ext/parser/extconf.rb"]);
    expect(gemspecExtensions("name: rack\nextensions: []\n")).toEqual([]);
    expect(gemspecExtensions("name: plain\n")).toEqual([]);
  });
});
