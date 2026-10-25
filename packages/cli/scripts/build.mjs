// The published CLI: Teire's engine bundled in, npm packages left as dependencies (the worker's
// recipe). `teire.mjs` is a launcher: external imports are hoisted above bundled code, so the
// WASI notice @ruby/prism triggers on load is filtered before the bundle is imported.
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const OWN = /^@teire\//;
const { version } = JSON.parse(await readFile("package.json", "utf8"));

await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: { cli: "src/main.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  define: { TEIRE_VERSION: JSON.stringify(version) },
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: "external-npm",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (OWN.test(args.path) || args.path.startsWith("node:")) return undefined;
          return { path: args.path, external: true };
        });
      },
    },
  ],
});
await writeFile(
  "dist/teire.mjs",
  `#!/usr/bin/env node
const emit = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) =>
  String(warning?.message ?? warning).includes("WASI") ? undefined : emit(warning, ...rest);
await import("./cli.mjs");
`,
);
await chmod("dist/teire.mjs", 0o755);
// The engine's helpers, run from source: Python through uv, Go built once into ~/.cache/teire.
await mkdir("dist/helpers/go", { recursive: true });
await cp("../helpers/python/teire_py.py", "dist/helpers/teire_py.py");
for (const f of ["go.mod", "go.sum", "main.go"]) await cp(`../helpers/go/${f}`, `dist/helpers/go/${f}`);
console.log("built dist/teire.mjs");
