import { describe, expect, it } from "vitest";
import { rewriteImports } from "../src/fix/upgrade-go";
import { escapeModulePath, pathForMajor, splitMajor } from "../src/registry/go";
import { goScheme } from "../src/registry/versions";
import { goChange, goParams } from "../src/surface/go";
import { countsFromGoJson, goJsonToText } from "../src/verify/reports";

const V4 = "github.com/golang-jwt/jwt/v4";
const V5 = "github.com/golang-jwt/jwt/v5";
const c = (message: string, compatible = false) => goChange({ message, compatible }, V4, V5);

describe("Go versions and major paths", () => {
  it("orders module versions, pseudo-versions as pre-releases", () => {
    expect(goScheme.compare("v5.3.1", "v5.10.0")).toBeLessThan(0);
    expect(goScheme.isPrerelease("v0.0.0-20261007192929-f45ad48fbe92")).toBe(true);
    expect(goScheme.valid("v2.0.0+incompatible")).toBe(true);
    expect(goScheme.valid("5.3.1")).toBe(false);
    expect(goScheme.breaking("v0.27.0", "v0.28.0")).toBe(true);
    expect(goScheme.breaking("v1.36.0", "v1.43.0")).toBe(false);
  });

  it("splits a module path into its major and builds the next one", () => {
    expect(splitMajor(V4)).toEqual({ base: "github.com/golang-jwt/jwt", major: 4, style: "slash" });
    expect(splitMajor("github.com/sashabaranov/go-openai").major).toBe(1);
    expect(splitMajor("gopkg.in/yaml.v2")).toEqual({ base: "gopkg.in/yaml", major: 2, style: "gopkg" });
    expect(pathForMajor("github.com/golang-jwt/jwt", 5, "slash")).toBe(V5);
    expect(pathForMajor("gopkg.in/yaml", 3, "gopkg")).toBe("gopkg.in/yaml.v3");
    expect(escapeModulePath("github.com/Azure/azure-sdk-for-go")).toBe("github.com/!azure/azure-sdk-for-go");
  });
});

describe("apidiff lines (real output, golang-jwt v4.5.2 → v5.3.1)", () => {
  it("keeps removals and interface additions as breaking", () => {
    expect(c("StandardClaims: removed")).toMatchObject({
      kind: "removed",
      severity: "breaking",
      declKey: "StandardClaims",
    });
    expect(c("Claims.GetAudience: added")).toMatchObject({ kind: "required-added", severity: "breaking" });
  });

  it("drops path-only changes, unexported types and compatible lines", () => {
    expect(
      c(
        "./request.ParseFromRequest: changed from func(*net/http.Request, Extractor, github.com/golang-jwt/jwt/v4.Keyfunc) (*github.com/golang-jwt/jwt/v4.Token, error) to func(*net/http.Request, Extractor, github.com/golang-jwt/jwt/v5.Keyfunc) (*github.com/golang-jwt/jwt/v5.Token, error)",
      ),
    ).toBeNull();
    expect(
      c(
        "(*signingMethodNone).Sign: changed from func(string, interface{}) (string, error) to func(string, any) ([]byte, error)",
      ),
    ).toBeNull();
    expect(c("(*Parser).ParseUnverified: added", true)).toBeNull();
  });

  it("reads arity: a trailing option is compatible for callers, other changes break", () => {
    expect(
      c(
        "NewWithClaims: changed from func(SigningMethod, Claims) *Token to func(SigningMethod, Claims, ...TokenOption) *Token",
      ),
    ).toMatchObject({
      kind: "signature-changed",
      severity: "drift",
    });
    expect(
      c("Parse: changed from func(string, Keyfunc) (*Token, error) to func(string) (*Token, error)"),
    ).toMatchObject({
      kind: "arity-changed",
      severity: "breaking",
      arity: { minBefore: 2, maxBefore: 2, minAfter: 1, maxAfter: 1 },
    });
    expect(goParams("func(map[string]int, func(a, b int) bool) error")).toEqual({
      count: 2,
      variadic: false,
    });
  });
});

describe("the import rewrite of a major upgrade", () => {
  it("moves import specs only, subpackages and aliases included", () => {
    const before = [
      "package auth",
      "",
      "import (",
      '\t"errors"',
      `\t"${V4}"`,
      `\tjwtreq "${V4}/request"`,
      ")",
      "",
      `// Uses ${V4} for tokens.`,
      `const doc = "${V4}"`,
    ].join("\n");
    const after = rewriteImports(before, V4, V5) ?? "";
    expect(after).toContain(`\t"${V5}"`);
    expect(after).toContain(`\tjwtreq "${V5}/request"`);
    expect(after).toContain(`// Uses ${V4} for tokens.`);
    expect(after).toContain(`const doc = "${V4}"`);
    expect(rewriteImports(`package x\n\nimport "${V4}"\n`, V4, V5)).toBe(`package x\n\nimport "${V5}"\n`);
    expect(rewriteImports(`package x\n\nimport "${V4}x"\n`, V4, V5)).toBeNull();
  });
});

describe("go test -json", () => {
  const events = [
    '{"Time":"2026-10-25T10:00:00Z","Action":"run","Package":"x/auth","Test":"TestIssue"}',
    '{"Time":"2026-10-25T10:00:00Z","Action":"output","Package":"x/auth","Test":"TestIssue","Output":"=== RUN   TestIssue\\n"}',
    '{"Time":"2026-10-25T10:00:00Z","Action":"pass","Package":"x/auth","Test":"TestIssue"}',
    '{"Time":"2026-10-25T10:00:00Z","Action":"output","Package":"x/auth","Test":"TestExpired","Output":"    token_test.go:31: want ErrExpired\\n"}',
    '{"Time":"2026-10-25T10:00:00Z","Action":"fail","Package":"x/auth","Test":"TestExpired"}',
    '{"Time":"2026-10-25T10:00:00Z","Action":"skip","Package":"x/auth","Test":"TestSlow"}',
    '{"Time":"2026-10-25T10:00:00Z","Action":"fail","Package":"x/auth"}',
    '{"Time":"2026-10-25T10:00:00Z","Action":"output","Package":"x/broken","Output":"# x/broken\\n"}',
    '{"Time":"2026-10-25T10:00:00Z","Action":"fail","Package":"x/broken"}',
  ].join("\n");

  it("counts each test's final action, and a package that failed with no test as an error", () => {
    expect(countsFromGoJson(events)).toEqual({ collected: 3, passed: 1, failed: 1, skipped: 1, errors: 1 });
  });

  it("shows the output lines, not the JSON", () => {
    expect(goJsonToText(events)).toBe(
      "=== RUN   TestIssue\n    token_test.go:31: want ErrExpired\n# x/broken",
    );
  });
});
