/**
 * Words per route (plan revision 3.4, "Words" and B4): the hard-coded copy a route renders, following
 * its local imports, split into **prose** (sentences, headings, helper text) and **flow** words (tile,
 * edge and chip labels: anything under `components/flow/` or inside an element marked `data-flow`).
 * Budgets apply to prose only, so tiles keep their labels. Data (change titles, quotes) isn't counted
 * here; the rendered pass in the V7 walk measures what people actually see.
 *
 *   pnpm --filter @teire/web copy-budget [--json]
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as TS from "typescript";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(web, "package.json"));
const ts: typeof TS = require("typescript");

const TEXT_KEYS = new Set([
  "title",
  "body",
  "description",
  "label",
  "q",
  "a",
  "text",
  "hint",
  "help",
  "empty",
  "summary",
  "subtitle",
  "heading",
  "caption",
  "placeholder",
  "message",
  "detail",
  "tool",
  "reads",
  "cta",
  "lead",
]);
const words = (s: string) => (s.replace(/\{[^}]*\}/g, " ").match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length;

interface Count {
  prose: number;
  flow: number;
  imports: string[];
}
const cache = new Map<string, Count>();

function fileWords(file: string): Count {
  const hit = cache.get(file);
  if (hit) return hit;
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Tile vocabulary: the flow parts, and the labels, captions and brand names they draw.
  const inFlowDir =
    file.includes(`${path.sep}components${path.sep}flow${path.sep}`) ||
    file.includes(`${path.sep}lib${path.sep}flow${path.sep}`) ||
    /lib[\\/](proof|brands|logos|marks|estate)\.ts$/.test(file);
  const out: Count = { prose: 0, flow: 0, imports: [] };
  const add = (n: number, flow: boolean) => {
    if (flow || inFlowDir) out.flow += n;
    else out.prose += n;
  };
  const isFlowElement = (node: TS.Node) => {
    const open = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    return !!open?.attributes.properties.some(
      (p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "data-flow",
    );
  };
  const visit = (node: TS.Node, flow: boolean) => {
    const here = flow || isFlowElement(node);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // A type-only import renders nothing of the module it names.
      if (!node.importClause?.isTypeOnly) out.imports.push(node.moduleSpecifier.text);
    } else if (ts.isJsxText(node)) {
      add(words(node.text), here);
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isStringLiteralLike(node.expression) &&
      ts.isJsxElement(node.parent)
    ) {
      add(words(node.expression.text), here);
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      const val = ts.isStringLiteral(init)
        ? init.text
        : ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)
          ? init.expression.text
          : null;
      // A JSX `title` is a hover tooltip, not on-screen copy (plan revision 3.4, B4); data keys still count.
      if (val && TEXT_KEYS.has(name) && name !== "title") add(words(val), here);
    } else if (ts.isPropertyAssignment(node) && TEXT_KEYS.has(node.name.getText(sf).replace(/["']/g, ""))) {
      if (ts.isStringLiteralLike(node.initializer)) add(words(node.initializer.text), here);
    }
    ts.forEachChild(node, (c) => visit(c, here));
  };
  visit(sf, false);
  cache.set(file, out);
  return out;
}

function resolve(from: string, spec: string) {
  const base = spec.startsWith("@/")
    ? path.join(web, spec.slice(2))
    : spec.startsWith(".")
      ? path.resolve(path.dirname(from), spec)
      : null;
  if (!base) return null;
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const p = base + ext;
    if (fs.existsSync(p) && fs.statSync(p).isFile() && /\.tsx?$/.test(p)) return p;
  }
  return null;
}

function routeWords(entry: string) {
  const seen = new Set<string>();
  const stack = [entry];
  let prose = 0;
  let flow = 0;
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    const c = fileWords(f);
    // shadcn primitives render the caller's words, not their own; the assistant's tool descriptions and
    // prompts are read by the model, never rendered.
    if (
      !f.includes(`${path.sep}components${path.sep}ui${path.sep}`) &&
      !f.includes(`${path.sep}lib${path.sep}assistant${path.sep}`)
    ) {
      prose += c.prose;
      flow += c.flow;
    }
    for (const s of c.imports) {
      const r = resolve(f, s);
      if (r && !r.includes("node_modules")) stack.push(r);
    }
  }
  return { prose, flow, files: seen.size };
}

const app = path.join(web, "app");
const entries: string[] = [];
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name !== "api" && e.name !== "og") walk(p);
    } else if (/^(page|not-found|error|loading)\.tsx$/.test(e.name)) entries.push(p);
  }
};
walk(app);
const rows = entries
  .map((p) => ({ route: path.relative(app, p).replace(/\\/g, "/"), ...routeWords(p) }))
  .sort((a, b) => b.prose - a.prose);
if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else {
  console.log(" prose   flow  route");
  for (const r of rows) console.log(String(r.prose).padStart(6), String(r.flow).padStart(6), "", r.route);
  const sum = (k: "prose" | "flow") => rows.reduce((s, r) => s + r[k], 0);
  console.log(String(sum("prose")).padStart(6), String(sum("flow")).padStart(6), "", "total");
}
