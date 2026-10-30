import { join } from "node:path";
import YAML from "yaml";
import { type GoAccess, goPrivateEnv } from "../golang/toolchain";
import type { GoProject } from "../inventory/go";
import type { RepoTree } from "../inventory/tree";
import type { CheckPlan, PlannedCheck } from "./commands";
import { goPrivatePatterns } from "./private-registry";

/**
 * What to run for a Go module (plan S05, research go.md Job 8): `go mod download` online, then
 * with the network off (GOPROXY=off, -mod=readonly so a check never rewrites go.mod or go.sum):
 * build (`-o /dev/null`, since `go build ./...` on a single main package writes a binary into the
 * tree), vet, and `go test -json` for per-test counts. Build tags from the repo's CI test step are
 * kept; `-race` needs cgo and a C compiler in both sandboxes, so it is left out and said so.
 */
const OFFLINE_ENV = {
  // The repo's go/toolchain directive decides (D-47): a newer toolchain is fetched from the Go proxy
  // during the install and read from the module cache afterwards.
  GOTOOLCHAIN: "auto",
  GOPROXY: "off",
  GOFLAGS: "-mod=readonly -modcacherw",
  GOWORK: "off",
  GONOSUMDB: "",
  GIT_TERMINAL_PROMPT: "0",
};

function ciTestArgs(tree: RepoTree, notes: string[]) {
  const args: string[] = [];
  for (const file of tree.files().filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))) {
    let doc: { jobs?: Record<string, { steps?: { run?: string }[] }> };
    try {
      doc = (YAML.parse(tree.read(file) ?? "") ?? {}) as typeof doc;
    } catch {
      continue;
    }
    for (const job of Object.values(doc.jobs ?? {}))
      for (const step of job.steps ?? []) {
        const run = step.run ?? "";
        const m = /\bgo test\b([^\n&|;]*)/.exec(run);
        if (!m) continue;
        const tags = /-tags[= ]("?)([\w,]+)\1/.exec(m[1] ?? "");
        if (tags?.[2] && !args.includes(`-tags=${tags[2]}`)) args.push(`-tags=${tags[2]}`);
        if (/-race\b/.test(m[1] ?? "") && !notes.some((n) => n.includes("-race")))
          notes.push("CI runs go test -race; Teire runs without -race (no cgo toolchain in both sandboxes)");
      }
  }
  return args;
}

export function detectGoChecks(
  tree: RepoTree,
  project: GoProject,
  sandboxRoot = "/work",
  /** The repository's private modules; without it, its own patterns, failing closed. */
  access: GoAccess = { patterns: goPrivatePatterns(tree), proxies: [] },
): CheckPlan {
  const notes: string[] = [...project.notes];
  // Installs (and a fix's go get) reach private modules through the repository's own proxy, whose
  // credential the sandbox's egress adds; offline checks keep them out of the checksum database.
  const offlinePrivate = goPrivateEnv({ patterns: access.patterns, proxies: [] });
  const installPrivate = goPrivateEnv({ ...access, proxies: access.proxies.map((p) => ({ url: p.url })) });
  const prefix = project.root === "." ? "" : `${project.root}/`;
  const hasTests = tree
    .files()
    .some((f) => f.startsWith(prefix) && f.endsWith("_test.go") && !/\/(vendor|testdata)\//.test(f));
  const checks: PlannedCheck[] = [
    { name: "build", argv: ["go", "build", "-o", "/dev/null", "./..."], source: "default" },
    { name: "typecheck", argv: ["go", "vet", "./..."], source: "default" },
  ];
  if (hasTests)
    checks.push({
      name: "test",
      argv: ["go", "test", "-count=1", "-json", ...ciTestArgs(tree, notes), "./..."],
      source: "default",
    });
  else notes.push("no _test.go files: build and vet only");
  return {
    manager: "go",
    image: "go",
    cwd: project.root === "." ? sandboxRoot : join(sandboxRoot, project.root),
    // In a go.work workspace (S18.4) the module builds as its workspace builds it: GOWORK set, and
    // `-mod` only readonly or vendor (Go refuses `-mod=mod` in workspace mode).
    ...(project.work
      ? (() => {
          const gowork = join(sandboxRoot, project.work.file);
          return {
            install: ["go", "mod", "download"],
            installEnv: { GOTOOLCHAIN: "auto", GOFLAGS: "-modcacherw", GOWORK: gowork, ...installPrivate },
            env: {
              ...OFFLINE_ENV,
              ...offlinePrivate,
              GOWORK: gowork,
              GOFLAGS: project.work.vendored ? "-mod=vendor" : "-mod=readonly -modcacherw",
            },
          };
        })()
      : {
          install: project.vendored ? ["go", "mod", "verify"] : ["go", "mod", "download"],
          installEnv: {
            GOTOOLCHAIN: "auto",
            GOFLAGS: "-mod=mod -modcacherw",
            GOWORK: "off",
            ...installPrivate,
          },
          env: {
            ...OFFLINE_ENV,
            ...offlinePrivate,
            ...(project.vendored ? { GOFLAGS: "-mod=vendor" } : {}),
          },
        }),
    checks,
    provenOffline: true,
    notes,
  };
}
