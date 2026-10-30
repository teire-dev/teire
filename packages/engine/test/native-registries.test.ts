import { describe, expect, it } from "vitest";
import { fromNativeRegistry, mavenRepositories, parseMavenMetadata } from "../src/registry/native";

// Live: each registry as it answers today (S18.2).
const now = new Date();

describe("each ecosystem's own registry as a version source (S18.2)", () => {
  it("reads Google's Maven for androidx, with recent versions dated", async () => {
    const info = await fromNativeRegistry("maven", "androidx.core:core-ktx", now);
    expect(info?.source.name).toBe("Google Maven");
    expect(info?.versions.some((v) => v.version === "1.13.1")).toBe(true);
    expect(info?.versions.at(-1)?.publishedAt).toMatch(/^\d{4}-/);
    expect(info?.defaultVersion).toBeTruthy();
  }, 60_000);

  it("reads a Gradle plugin marker from the Plugin Portal, and Central for the rest", async () => {
    const plugin = await fromNativeRegistry(
      "maven",
      "com.github.ben-manes.versions:com.github.ben-manes.versions.gradle.plugin",
      now,
    );
    expect(plugin?.source.name).toBe("Gradle Plugin Portal");
    expect(plugin?.versions.some((v) => v.version === "0.51.0")).toBe(true);
    const guava = await fromNativeRegistry("maven", "com.google.guava:guava", now);
    expect(guava?.source.name).toBe("Maven Central");
    expect(mavenRepositories("androidx.compose.ui")[0]?.name).toBe("Google Maven");
  }, 90_000);

  it("reads the Go proxy, the crates.io index, PyPI yanks and RubyGems", async () => {
    const go = await fromNativeRegistry("go", "github.com/google/uuid", now);
    expect(go?.versions.find((v) => v.version === "v1.6.0")?.publishedAt).toBe("2024-01-23T18:54:04Z");
    const crate = await fromNativeRegistry("cargo", "serde", now);
    expect(crate?.versions.at(-1)?.publishedAt).toMatch(/^\d{4}-/);
    const pypi = await fromNativeRegistry("pypi", "requests", now);
    expect(pypi?.versions.find((v) => v.version === "2.32.0")?.deprecated).toContain("CVE-2024-35195");
    const gem = await fromNativeRegistry("rubygems", "rack", now);
    expect(gem?.defaultVersion).toMatch(/^\d+\.\d+/);
    expect(await fromNativeRegistry("pypi", "teire-no-such-package-0x1", now)).toBeNull();
  }, 90_000);

  it("parses maven-metadata.xml", () => {
    expect(
      parseMavenMetadata(
        "<metadata><versioning><release>2.1</release><versions><version>1.0</version><version> 2.1 </version></versions></versioning></metadata>",
      ),
    ).toEqual({ versions: ["1.0", "2.1"], release: "2.1" });
  });
});
