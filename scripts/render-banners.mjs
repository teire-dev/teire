// The README and organisation-profile banners (light and dark, 2560×1280): Teire's mark and motto
// beside the live run page of a real Teire fix (teire-dev/examples PR #30, zod 3.25.76 → 4.6.6,
// proven), captured from teire.vercel.app in the same theme. Rerun when the product changes.
//
// Run (playwright-core and a Chromium build, not a dependency of this repo):
//   PLAYWRIGHT_FROM=/path/with/node_modules/ CHROMIUM=/path/to/chrome node scripts/render-banners.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? import.meta.url)("playwright-core");
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, ".github/assets");
const RUN = "https://teire.vercel.app/runs/d1b0c4d8-a46e-4e9d-b057-30b6d12be23b";
const svg = (name) =>
  `data:image/svg+xml;base64,${readFileSync(join(ROOT, "apps/web/public/logos", name)).toString("base64")}`;
const MARK = `data:image/svg+xml;base64,${readFileSync(join(ROOT, ".github/assets/brand/teire-logo.svg")).toString("base64")}`;

const THEMES = {
  light: {
    bg: "#f8f9fc",
    dot: "rgba(27,37,64,.10)",
    ink: "#1b2540",
    ink2: "#4a5675",
    ink3: "#7a849c",
    rule: "rgba(27,37,64,.12)",
    logos: { nvidia: svg("nvidia-light.svg"), nebius: svg("nebius-light.svg") },
  },
  dark: {
    bg: "#001033",
    dot: "rgba(232,237,251,.12)",
    ink: "#fafeff",
    ink2: "#b9c3dc",
    ink3: "#8a96b4",
    rule: "rgba(232,237,251,.16)",
    logos: { nvidia: svg("nvidia-dark.svg"), nebius: svg("nebius-dark.svg") },
  },
};

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
for (const [name, t] of Object.entries(THEMES)) {
  // The run page as anyone sees it: its header, the flow and the checks that proved it.
  const run = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: name,
  });
  await run.addInitScript((theme) => localStorage.setItem("theme", theme), name);
  await run.goto(RUN, { waitUntil: "networkidle", timeout: 120_000 });
  await run.waitForTimeout(3000);
  await run.mouse.move(0, 0);
  const shot = (await run.screenshot({ clip: { x: 124, y: 86, width: 1192, height: 672 } })).toString("base64");
  await run.close();

  const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Newsreader:opsz,wght@6..72,500&family=Noto+Serif+JP:wght@500&display=block" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 2560px; height: 1280px; background: ${t.bg}; color: ${t.ink}; font-family: Geist, sans-serif;
    background-image: radial-gradient(${t.dot} 1.6px, transparent 1.6px); background-size: 32px 32px;
    display: flex; align-items: center; gap: 96px; padding: 0 120px; overflow: hidden; }
  .left { flex: 0 0 1000px; display: flex; flex-direction: column; gap: 44px; }
  .brand { display: flex; align-items: center; gap: 26px; }
  .brand img { width: 104px; height: 104px; }
  .brand b { font-size: 72px; font-weight: 600; letter-spacing: -0.02em; }
  .brand span { font-family: "Noto Serif JP", serif; font-size: 46px; color: ${t.ink3}; margin-left: 10px; }
  .eco { font-family: "Geist Mono", monospace; font-size: 26px; white-space: nowrap; color: ${t.ink2}; letter-spacing: .01em; }
  h1 { font-family: Newsreader, serif; font-weight: 500; font-size: 124px; line-height: 1.02; letter-spacing: -0.025em; text-wrap: balance; }
  p { font-size: 42px; line-height: 1.35; color: ${t.ink2}; max-width: 940px; text-wrap: balance; }
  .built { display: flex; align-items: center; gap: 40px; padding-top: 30px; border-top: 2px solid ${t.rule}; }
  .built small { font-family: "Geist Mono", monospace; font-size: 24px; color: ${t.ink3}; letter-spacing: .12em; }
  .built img { height: 46px; }
  .right { flex: 1; display: flex; flex-direction: column; gap: 22px; }
  .chip { align-self: flex-start; font-family: "Geist Mono", monospace; font-size: 26px; color: ${t.ink2};
    border: 2px solid ${t.rule}; border-radius: 999px; padding: 10px 24px; }
  .chip i { font-style: normal; color: #16a34a; }
  .shot { border-radius: 36px; overflow: hidden; border: 2px solid ${t.rule};
    box-shadow: 0 40px 120px -30px rgba(0,16,51,.45); }
  .shot img { display: block; width: 100%; }
</style></head><body>
  <div class="left">
    <div class="brand"><img src="${MARK}" alt=""><b>Teire</b><span>手入れ</span></div>
    <div class="eco">npm · PyPI · Go · Cargo · RubyGems · Maven · APIs · models</div>
    <h1>When upstream breaks, Teire fixes your code.</h1>
    <p>Found, fixed by Nemotron, proven by your own tests.</p>
    <div class="built"><small>BUILT ON</small><img src="${t.logos.nvidia}" alt=""><img src="${t.logos.nebius}" alt=""></div>
  </div>
  <div class="right">
    <div class="chip"><i>●</i> live proof · teire-dev/examples · PR #30</div>
    <div class="shot"><img src="data:image/png;base64,${shot}" alt=""></div>
  </div>
</body></html>`;
  const page = await browser.newPage({ viewport: { width: 2560, height: 1280 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  writeFileSync(join(OUT, `banner-${name}.png`), await page.screenshot({ type: "png" }));
  await page.close();
  console.log("wrote", `banner-${name}.png`);
}
await browser.close();
