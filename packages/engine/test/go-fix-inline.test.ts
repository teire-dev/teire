import { describe, expect, it } from "vitest";
import { importsModule, inlineDirectives, keptInlineEdits, repoPathOf } from "../src/fix/go-fix-inline";

const moduleSource = `package gomponents

// DataAttr is deprecated: use Data.
//
//go:fix inline
func DataAttr(name, v string) Node { return Data(name, v) }

//go:fix inline
const Version = Current

func Data(name, v string) Node { return nil }
`;

const caller = `package html

import (
	g "maragu.dev/gomponents"
	"strings"
)

func card(id string) g.Node {
	_ = strings.ToUpper(id)
	return g.DataAttr("id", id)
}
`;

const diff = `--- /work/app/ui/card.go (old)
+++ /work/app/ui/card.go (new)
@@ -8,4 +8,4 @@
 func card(id string) g.Node {
-	_ = strings.ToUpper(id)
+	_ = strings.ToUpper(strings.TrimSpace(id))
-	return g.DataAttr("id", id)
+	return g.Data("id", id)
 }
`;

describe("go fix -inline, gated to the upgraded module's own directives (R21.7)", () => {
  it("reads the names a version marks for inlining", () => {
    expect([...inlineDirectives([{ path: "attr.go", text: moduleSource }])].sort()).toEqual([
      "DataAttr",
      "Version",
    ]);
  });

  it("tells whether a file imports the module", () => {
    expect(importsModule(caller, "maragu.dev/gomponents")).toBe(true);
    expect(importsModule('package x\nimport "maragu.dev/gomponents/html"\n', "maragu.dev/gomponents")).toBe(
      true,
    );
    expect(importsModule('package x\nimport "maragu.dev/gomponentsx"\n', "maragu.dev/gomponents")).toBe(
      false,
    );
  });

  it("maps go fix's printed paths back to the repository", () => {
    expect(repoPathOf("/work/app/ui/card.go (old)", ".")).toBe("app/ui/card.go");
    expect(repoPathOf("ui/card.go", "app")).toBe("app/ui/card.go");
    expect(repoPathOf("/elsewhere/card.go", ".")).toBeNull();
  });

  it("keeps only the hunk that inlines the module's call", () => {
    const sameHunkDiff = diff;
    const edits = keptInlineEdits({
      diff: sameHunkDiff,
      read: (p) => (p === "app/ui/card.go" ? caller : null),
      projectRoot: ".",
      modulePath: "maragu.dev/gomponents",
      names: new Set(["DataAttr"]),
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).toContain('return g.Data("id", id)');
    // The other directive's rewrite in the same hunk isn't the upgrade's: left as it was.
    expect(edits[0]?.content).toContain("_ = strings.ToUpper(id)");
    expect(edits[0]?.content).not.toContain("TrimSpace");
    expect(edits[0]?.reason).toContain("DataAttr");
  });

  it("keeps nothing in a file that doesn't import the module", () => {
    expect(
      keptInlineEdits({
        diff,
        read: () => caller.replace('g "maragu.dev/gomponents"', 'g "other.dev/lib"'),
        projectRoot: ".",
        modulePath: "maragu.dev/gomponents",
        names: new Set(["DataAttr"]),
      }),
    ).toEqual([]);
  });
});
