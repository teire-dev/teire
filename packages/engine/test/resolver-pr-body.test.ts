import { describe, expect, it } from "vitest";
import { upstreamFromPrBody } from "../src/resolver/pr-body";

// The shape dependabot-core's npm updater writes (redirect.github.com links, a compare item).
const body = `Bumps [minimatch](https://github.com/isaacs/minimatch) from 3.1.5 to 10.2.6.
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://redirect.github.com/isaacs/minimatch/commit/0123456789abcdef0123456789abcdef01234567"><code>0123456</code></a> 10.2.6</li>
<li><a href="https://redirect.github.com/isaacs/minimatch/commit/89abcdef0123456789abcdef0123456789abcdef"><code>89abcde</code></a> fix: avoid &lt;script&gt; in @someone's #42 glob</li>
<li>Additional commits viewable in <a href="https://redirect.github.com/isaacs/minimatch/compare/v3.1.5...v10.2.6">compare view</a></li>
</ul>
</details>
<br />`;

describe("upstream commits from the updater's PR body (D-13)", () => {
  it("reads commits and the compare link as data, with github.com links", () => {
    const u = upstreamFromPrBody(body);
    expect(u?.commits).toHaveLength(2);
    expect(u?.commits[0]).toEqual({
      sha: "0123456",
      url: "https://github.com/isaacs/minimatch/commit/0123456789abcdef0123456789abcdef01234567",
      message: "10.2.6",
    });
    expect(u?.commits[1]?.message).toBe("fix: avoid <script> in @someone's #42 glob");
    expect(u?.compare).toBe("https://github.com/isaacs/minimatch/compare/v3.1.5...v10.2.6");
  });

  it("returns nothing without a Commits block, and drops links that aren't GitHub's", () => {
    expect(upstreamFromPrBody("Bumps x from 1 to 2.")).toBeNull();
    const odd = body.replace(/https:\/\/redirect\.github\.com/g, "https://evil.example");
    expect(upstreamFromPrBody(odd)).toBeNull();
  });
});

import { isDependencyFile, wrapperRaiseOnly } from "../src/resolver/events";

describe("files the updater may return (untrusted events)", () => {
  it("takes manifests, lockfiles, vendored folders and wrapper files", () => {
    for (const p of [
      "package.json",
      "web/yarn.lock",
      ".yarn/cache/x.zip",
      "py/uv.lock",
      "requirements/dev.txt",
      "go.sum",
      "Cargo.lock",
      "coal.gemspec",
      "gradle/libs.versions.toml",
      "gradle.lockfile",
      "pom.xml",
    ])
      expect(isDependencyFile(p), p).toBe(true);
  });
  it("takes vendor/ and wrapper files only for what the change moved (stage R review)", () => {
    const go = { ecosystem: "go", moved: ["golang.org/x/sys"] };
    expect(isDependencyFile("vendor/golang.org/x/sys/unix/asm_linux_amd64.s", go)).toBe(true);
    expect(isDependencyFile("vendor/modules.txt", go)).toBe(true);
    expect(isDependencyFile("vendor/evil.go", go)).toBe(false);
    expect(
      isDependencyFile("vendor/golang.org/x/sys/unix/a.go", {
        ecosystem: "npm",
        moved: ["golang.org/x/sys"],
      }),
    ).toBe(false);
    const ruby = { ecosystem: "rubygems", moved: ["faraday"] };
    expect(isDependencyFile("vendor/cache/faraday-2.14.0.gem", ruby)).toBe(true);
    expect(isDependencyFile("vendor/cache/evil-1.0.gem", ruby)).toBe(false);
    expect(
      isDependencyFile("gradle/wrapper/gradle-wrapper.properties", { ecosystem: "maven", moved: ["gradle"] }),
    ).toBe(true);
    expect(
      isDependencyFile("gradle/wrapper/gradle-wrapper.jar", {
        ecosystem: "maven",
        moved: ["com.google.guava:guava"],
      }),
    ).toBe(false);
  });
  it("takes only the job's own ecosystem's files, and the wrapper only for a Gradle raise (round 2)", () => {
    expect(isDependencyFile("package.json", { ecosystem: "go", moved: [] })).toBe(false);
    expect(isDependencyFile("pom.xml", { ecosystem: "npm", moved: [] })).toBe(false);
    expect(isDependencyFile("go.sum", { ecosystem: "go", moved: [] })).toBe(true);
    expect(isDependencyFile("gradlew", { ecosystem: "maven", moved: ["com.google.guava:guava"] })).toBe(
      false,
    );
    const before =
      "distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-bin.zip\n";
    const raise = before.replace("8.5", "8.14.3");
    expect(wrapperRaiseOnly(before, raise)).toBe(true);
    expect(wrapperRaiseOnly(before, `${raise}zipStorePath=elsewhere\n`)).toBe(false);
    expect(wrapperRaiseOnly(before, before.replace("services.gradle.org", "evil.example"))).toBe(false);
    expect(wrapperRaiseOnly(before, before)).toBe(false);
  });
  it("refuses workflows, sources and scripts", () => {
    for (const p of [
      ".github/workflows/ci.yml",
      "src/index.ts",
      "scripts/postinstall.sh",
      "Makefile",
      ".npmrc",
      "vendor/evil.sh",
      "vendor/bin/run",
      "gradle/wrapper/evil.sh",
    ])
      expect(isDependencyFile(p), p).toBe(false);
  });
});
