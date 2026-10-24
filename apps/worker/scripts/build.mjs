// Production bundle for the worker (coolify skill, node-production recipe):
// bundle our own workspace packages, keep npm packages external, split chunks beside main.mjs,
// and fail the build if a lazy __esm wrapper appears (it caused a production-only crash loop before).
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const OWN = /^@teire\//;
const outdir = "dist/bundle";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: { main: "src/main.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  splitting: true,
  outdir,
  outExtension: { ".js": ".mjs" },
  chunkNames: "[name]-[hash]",
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

let lazyWrappers = 0;
for (const file of await readdir(outdir)) {
  if (!file.endsWith(".mjs")) continue;
  const text = await readFile(join(outdir, file), "utf8");
  lazyWrappers += text.split("__esm(").length - 1;
}
if (lazyWrappers > 0) {
  console.error(`build check failed: ${lazyWrappers} __esm( wrappers in the bundle`);
  process.exit(1);
}
console.log(`built ${outdir}/main.mjs`);
