import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { credentialContext, openSecret, sealSecret } from "../src/credentials";
import { memoryTree } from "../src/inventory/tree";
import { type AuthorizedRegistry, claimingRegistry, fromPrivateRegistry } from "../src/registry/private";
import { dependabotCredentials } from "../src/resolver/job";
import { discoverRegistries, goPrivatePatterns } from "../src/verify/private-registry";

describe("private registries a repo names (D-36)", () => {
  const tree = memoryTree({
    // An .npmrc reads its token from the environment; Teire keeps only the registry.
    ".npmrc":
      "@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=$" + "{NPM_TOKEN}\n",
    ".yarnrc.yml":
      "npmScopes:\n  corp:\n    npmRegistryServer: https://corp.jfrog.io/artifactory/api/npm/npm\n",
    "pip.conf": "[global]\nindex-url = https://user:hunter2@pypi.corp.example.com/simple\n",
    "pyproject.toml":
      '[[tool.uv.index]]\nname = "corp"\nurl = "https://pkgs.dev.azure.com/acme/_packaging/py/pypi/simple"\n',
    ".cargo/config.toml": '[registries.acme]\nindex = "sparse+https://cargo.cloudsmith.io/acme/crates/"\n',
    Gemfile:
      'source "https://rubygems.org"\nsource "https://gems.corp.example.com" do\n  gem "corp-auth"\nend\n',
    "pom.xml":
      "<project><repositories><repository><id>corp</id><url>https://maven.corp.example.com/releases</url></repository></repositories></project>",
    "build.gradle.kts":
      'repositories { mavenCentral(); maven { url = uri("https://maven.pkg.github.com/acme/libs") } }',
    ".github/workflows/ci.yml":
      "env:\n  GOPROXY: https://goproxy.corp.example.com,direct\n  GOPRIVATE: github.com/acme/*\n",
  });

  it("finds each with its scope and file, credentials left out", () => {
    const found = discoverRegistries(tree);
    const of = (host: string) => found.find((r) => r.host === host);
    expect(of("npm.pkg.github.com")).toMatchObject({ ecosystem: "npm", scope: "@acme", file: ".npmrc" });
    expect(of("corp.jfrog.io")).toMatchObject({ ecosystem: "npm", scope: "@corp" });
    expect(of("pypi.corp.example.com")?.url).toBe("https://pypi.corp.example.com/simple");
    expect(of("pkgs.dev.azure.com")?.ecosystem).toBe("pypi");
    expect(of("cargo.cloudsmith.io")).toMatchObject({ ecosystem: "cargo", scope: "acme" });
    expect(of("gems.corp.example.com")?.ecosystem).toBe("rubygems");
    expect(of("maven.corp.example.com")?.ecosystem).toBe("maven");
    expect(of("maven.pkg.github.com")?.file).toBe("build.gradle.kts");
    expect(of("goproxy.corp.example.com")?.ecosystem).toBe("go");
    expect(found.some((r) => r.host === "rubygems.org" || r.url.includes("hunter2"))).toBe(false);
    expect(goPrivatePatterns(tree)).toEqual(["github.com/acme/*"]);
  });
});

describe("credentials sealed for the worker (S-P20)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("opens only with the private key, for the installation and host it was sealed for", () => {
    const sealed = sealSecret(pub, "ghp_secret", credentialContext(42, "npm.pkg.github.com"));
    expect(sealed).not.toContain("ghp_secret");
    expect(openSecret(priv, sealed, credentialContext(42, "npm.pkg.github.com"))).toBe("ghp_secret");
    expect(() => openSecret(priv, sealed, credentialContext(43, "npm.pkg.github.com"))).toThrow();
    expect(() => openSecret(priv, sealed, credentialContext(42, "evil.example.com"))).toThrow();
  });
});

describe("which registry claims a dependency, and Dependabot's credentials (S18.7)", () => {
  const reg = (
    ecosystem: AuthorizedRegistry["ecosystem"],
    host: string,
    scope?: string,
  ): AuthorizedRegistry => ({
    ecosystem,
    host,
    url: `https://${host}`,
    ...(scope ? { scope } : {}),
    authorization: "Bearer t",
    secret: { kind: "token", username: null, value: "t" },
  });
  it("routes a scoped npm package, a named Cargo registry and a private Go module only to theirs", () => {
    const registries = [
      reg("npm", "npm.pkg.github.com", "@acme"),
      reg("cargo", "cargo.cloudsmith.io", "acme"),
      reg("go", "goproxy.corp.example.com"),
    ];
    expect(claimingRegistry("npm", { name: "@acme/ui", source: "registry" }, registries)?.host).toBe(
      "npm.pkg.github.com",
    );
    expect(claimingRegistry("npm", { name: "react", source: "registry" }, registries)).toBeNull();
    expect(
      claimingRegistry("cargo", { name: "acme-core", source: "private-index", sourceRef: "acme" }, registries)
        ?.host,
    ).toBe("cargo.cloudsmith.io");
    expect(
      claimingRegistry("go", { name: "github.com/acme/auth/v2", source: "registry" }, registries, [
        "github.com/acme/*",
      ])?.host,
    ).toBe("goproxy.corp.example.com");
    expect(
      claimingRegistry("go", { name: "github.com/other/x", source: "registry" }, registries, [
        "github.com/acme/*",
      ]),
    ).toBeNull();
    expect(dependabotCredentials(registries)).toEqual([
      { type: "npm_registry", registry: "npm.pkg.github.com", url: "https://npm.pkg.github.com", token: "t" },
      { type: "cargo_registry", registry: "acme", url: "https://cargo.cloudsmith.io", token: "t" },
      { type: "goproxy_server", url: "https://goproxy.corp.example.com", token: "t" },
    ]);
  });
});

describe("a private registry's own protocol (D-35, live on public registries that speak it)", () => {
  const at = (ecosystem: AuthorizedRegistry["ecosystem"], url: string): AuthorizedRegistry => ({
    ecosystem,
    url,
    host: new URL(url).hostname,
    authorization: "Basic dGVpcmU6dGVzdA==",
  });
  it("reads npm, PyPI simple JSON, Maven, a Cargo sparse index, RubyGems and a GOPROXY", async () => {
    const npm = await fromPrivateRegistry(at("npm", "https://registry.npmjs.org"), "left-pad");
    expect(npm?.versions.some((v) => v.version === "1.3.0")).toBe(true);
    const pypi = await fromPrivateRegistry(at("pypi", "https://pypi.org/simple"), "requests");
    expect(pypi?.versions.find((v) => v.version === "2.32.0")?.deprecated).toBeTruthy();
    expect(pypi?.versions.find((v) => v.version === "2.31.0")?.publishedAt).toMatch(/^2023-/);
    const maven = await fromPrivateRegistry(
      at("maven", "https://repo1.maven.org/maven2"),
      "com.google.guava:guava",
    );
    expect(maven?.versions.some((v) => v.version === "33.0.0-jre")).toBe(true);
    const cargo = await fromPrivateRegistry(at("cargo", "https://index.crates.io"), "serde");
    expect(cargo?.versions.at(-1)?.publishedAt).toMatch(/^\d{4}-/);
    const gems = await fromPrivateRegistry(at("rubygems", "https://rubygems.org"), "rack");
    expect(gems?.versions.some((v) => v.version === "3.0.0")).toBe(true);
    const go = await fromPrivateRegistry(at("go", "https://proxy.golang.org"), "github.com/google/uuid");
    expect(go?.versions.some((v) => v.version === "v1.6.0")).toBe(true);
  }, 120_000);
});
