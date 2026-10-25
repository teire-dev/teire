import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { goDeclarations, goDocsLookup } from "../src/surface/godoc";

// Shapes from golang-jwt/jwt v5.3.1 (registered_claims.go, types.go, errors.go), gofmt'd.
const SOURCE = `package jwt

// RegisteredClaims are a structured version of the JWT Claims Set.
type RegisteredClaims struct {
	// the \`exp\` (Expiration Time) claim.
	ExpiresAt *NumericDate \`json:"exp,omitempty"\`
}

// GetExpirationTime implements the Claims interface.
func (c RegisteredClaims) GetExpirationTime() (*NumericDate, error) {
	return c.ExpiresAt, nil
}

// NewNumericDate constructs a new *NumericDate.
func NewNumericDate(t time.Time) *NumericDate {
	return nil
}

func (p *parser) hidden() {}

var (
	ErrTokenExpired = errors.New("token is expired")
	errInternal     = errors.New("x")
)
`;

describe("Go docs for the fix agent", () => {
  it("lists exported declarations with their doc comments and bodies", () => {
    const decls = goDeclarations(SOURCE, "registered_claims.go");
    expect(decls.map((d) => `${d.kind}:${d.receiver ?? ""}.${d.name}`)).toEqual([
      "type:.RegisteredClaims",
      "method:RegisteredClaims.GetExpirationTime",
      "func:.NewNumericDate",
      "var:.ErrTokenExpired",
    ]);
    expect(decls[0]?.text).toContain("ExpiresAt *NumericDate");
    expect(decls[2]?.doc).toBe("NewNumericDate constructs a new *NumericDate.");
  });

  it("answers a query with module@version citations and names what the target lacks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "godoc-"));
    writeFileSync(join(dir, "claims.go"), SOURCE);
    writeFileSync(join(dir, "claims_test.go"), "package jwt\n\nfunc TestNothing() {}\n");
    const answer = await goDocsLookup(
      "github.com/golang-jwt/jwt/v5",
      "v5.3.1",
      dir,
    )("migrate StandardClaims to RegisteredClaims and NewNumericDate");
    expect(answer).toContain("type RegisteredClaims struct");
    expect(answer).toContain("(github.com/golang-jwt/jwt/v5@v5.3.1/claims.go:4)");
    expect(answer).toContain("Not declared in v5.3.1: StandardClaims");
    expect(answer).not.toContain(dir);
    expect(answer).not.toContain("TestNothing");
  });
});
