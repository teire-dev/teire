"""Retake the docs and README screenshots in one run.

Public pages come from production (real runs, reports and catalog); app pages and Ask Teire come
from the local app on :3101, signed in as the local dev user. The docs get light WebPs in
apps/web/public/shots (wide and phone) and a fresh size map in apps/web/lib/shots.json; the README
gets light and dark PNGs in .github/assets/captures.

Run (playwright is not a dependency of this repo):
  DEVCOOKIE=<signed better-auth.session_token for the local dev user> \
    uv run --with playwright python scripts/capture-shots.py [docs|readme|all] [name ...]

Ask Teire shots make real model calls on the local app's Token Factory key.
"""

import glob
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "apps/web"
PROD, LOCAL = "https://teire.vercel.app", "http://localhost:3101"
DESKTOP = {"viewport": {"width": 1920, "height": 1080}, "device_scale_factor": 1}
README = {"viewport": {"width": 1440, "height": 900}, "device_scale_factor": 1.25}
PHONE = {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 3, "is_mobile": True, "has_touch": True}
ZOD = "/runs/d1b0c4d8-a46e-4e9d-b057-30b6d12be23b"
JWT = "/runs/fa6f5184-4d56-4867-90e4-f439f4d350c4"

# (name, base, path, devices, action). An action is None, ("console",) to bring the run's bottom
# panel to the top, ("tab", label) to open a run tab first, ("focus", element id), or ("ask", question,
# dock).
DOCS = [
    ("run-sheet", PROD, ZOD + "?tile=check", ["desktop"], None),
    ("run-sheet-steps", PROD, ZOD, ["desktop"], ("tab", "Steps")),
    ("run-sheet-receipt", PROD, ZOD, ["desktop"], ("tab", "Receipt")),
    ("run-reverify", PROD, "/runs/4cc5ad3d-c228-4ce8-b255-6294ab1fa506?tile=check", ["desktop"], None),
    ("dryrun-go-pr", PROD, JWT, ["desktop"], ("console",)),
    ("dryrun-go-diff", PROD, JWT + "?tile=fix", ["desktop"], None),
    ("dryrun-ai-web-pr", PROD, "/runs/7e9d2d48-21ba-4811-80e9-a58fa53dd6f2", ["desktop", "phone"], ("console",)),
    ("report-axios", PROD, "/scan/3218560b-1578-4070-b7f4-64a158ab3b4b", ["desktop", "phone"], None),
    ("report-flask", PROD, "/scan/4ed8f2c1-ff43-49c0-a51c-36472d45bb3a", ["desktop"], None),
    ("report-gin", PROD, "/scan/1cd512ab-1426-4c3f-913b-4345f8605692", ["desktop"], None),
    ("change-detail", PROD, "/changes/anthropic-2026-11-30-claude-sonnet-4-5-20250929", ["desktop"], None),
    ("provider-groq", PROD, "/providers/groq-com", ["desktop"], None),
    ("package-anthropic", PROD, "/packages/pypi/anthropic", ["desktop"], None),
    ("scan", PROD, "/scan", ["desktop", "phone"], None),
    ("trust", PROD, "/trust", ["desktop"], None),
    ("dashboard", LOCAL, "/app", ["desktop"], None),
    ("repos", LOCAL, "/app/repos", ["desktop"], None),
    ("repo-findings", LOCAL, "/app/repos/teire-dev/serve-handler/findings", ["desktop"], None),
    ("repo-prs", LOCAL, "/app/repos/teire-dev/examples/prs", ["desktop"], None),
    ("repo-config", LOCAL, "/app/repos/teire-dev/examples/config", ["desktop"], None),
    ("changes-for-you", LOCAL, "/app/changes", ["desktop"], None),
    ("app-runs", LOCAL, "/app/runs?show=needs-you", ["desktop"], None),
    ("settings", LOCAL, "/app/settings/usage", ["desktop"], None),
    ("welcome", LOCAL, "/welcome", ["desktop"], None),
    ("runtime-notice", LOCAL, "/app/repos/teire-dev/examples/findings?group=runtime/node", ["desktop"], ("focus", "group-runtime/node")),
    ("ask-overview", LOCAL, "/app", ["desktop"], ("ask", "What needs me today?", False)),
    ("ask-docked", LOCAL, "/runs/6611b070-513d-4a06-8bc4-ff8e964a9fd8", ["desktop"], ("ask", "Explain this run", True)),
    ("ask-why", LOCAL, "/app/repos/teire-dev/bristow/findings", ["desktop"], ("ask", "Why is there no PR for anthropic on teire-dev/bristow?", False)),
    ("ask-action", LOCAL, "/app/repos/teire-dev/nlsh", ["desktop"], ("ask", "Set fix mode to Ask first on teire-dev/nlsh", False)),
    ("ask", LOCAL, "/app/repos/teire-dev/nlsh/findings", ["phone"], ("ask", "What reaches this code?", False)),
]
# The README's captures, each in light and dark.
READMES = [
    ("run", PROD, ZOD + "?tile=code", None),
    ("run-pr", PROD, ZOD, ("console",)),
    ("report", PROD, "/scan/1cd512ab-1426-4c3f-913b-4345f8605692", None),
    ("groq", PROD, "/providers/groq-com", None),
    ("dashboard", LOCAL, "/app", None),
]

CONSOLE = "() => { const t = document.querySelector('[role=tablist]'); if (t) window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 96); }"
FOCUS = "(id) => { const e = document.getElementById(id); if (e) window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 140); }"


def launch(p):
    try:
        return p.chromium.launch()
    except Exception:
        cache = os.path.expanduser("~/Library/Caches/ms-playwright")
        found = sorted(glob.glob(cache + "/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell"))
        if not found:
            raise SystemExit("No Chromium: run `uv run --with playwright playwright install chromium` once.")
        return p.chromium.launch(executable_path=found[-1])


def shoot(browser, base, path, device, theme, action, out):
    ctx = browser.new_context(color_scheme=theme, **device)
    if base == LOCAL:
        ctx.add_cookies([{"name": "better-auth.session_token", "value": os.environ["DEVCOOKIE"], "domain": "localhost", "path": "/"}])
    ctx.add_init_script(f"try {{ localStorage.setItem('theme', '{theme}') }} catch {{}}")
    page = ctx.new_page()
    page.goto(base + path, wait_until="networkidle")
    page.wait_for_timeout(2500)
    kind = action[0] if action else None
    if kind == "tab":
        page.get_by_role("tab", name=action[1]).click()
        page.wait_for_timeout(800)
    if kind in ("tab", "console"):
        page.evaluate(CONSOLE)
    if kind == "focus":
        page.evaluate(FOCUS, action[1])
    if kind == "ask":
        page.get_by_label("Ask Teire (⌘I)").click()
        panel = page.get_by_label("Ask Teire", exact=True)
        panel.wait_for(timeout=15000)
        if page.get_by_label("New thread").count():
            page.get_by_label("New thread").first.click()
        if action[2]:
            page.get_by_label("Dock to the right").click()
        box = panel.locator("textarea").first
        box.fill(action[1])
        box.press("Enter")
        page.get_by_label("Ask again").last.wait_for(timeout=150000)
    page.wait_for_timeout(1200)
    page.mouse.move(0, 0)
    page.screenshot(path=out)
    ctx.close()


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    only = set(sys.argv[2:])
    tmp = Path(tempfile.mkdtemp(prefix="teire-shots-"))
    with sync_playwright() as p:
        browser = launch(p)
        if which in ("docs", "all"):
            for name, base, path, devices, action in DOCS:
                if only and name not in only:
                    continue
                for d in devices:
                    shoot(browser, base, path, DESKTOP if d == "desktop" else PHONE, "light", action, str(tmp / f"{name}-{d}.png"))
                    print("docs", name, d)
        if which in ("readme", "all"):
            for name, base, path, action in READMES:
                if only and name not in only:
                    continue
                for theme in ("light", "dark"):
                    out = ROOT / ".github/assets/captures" / f"{name}-{theme}.png"
                    shoot(browser, base, path, README, theme, action, str(out))
                    subprocess.run(["magick", str(out), "-strip", "-define", "png:compression-level=9", str(out)], check=True)
                    print("readme", name, theme)
        browser.close()
    # Docs: WebP at the docs' widths, then the size map the <Shot> components read.
    for f in sorted(tmp.glob("*.png")):
        stem = f.stem
        if stem.endswith("-phone"):
            subprocess.run(["magick", str(f), "-resize", "780x>", "-quality", "82", str(WEB / "public/shots/phone" / f"{stem[:-6]}.webp")], check=True)
        else:
            subprocess.run(["magick", str(f), "-resize", "1600x>", "-quality", "80", str(WEB / "public/shots/wide" / f"{stem.removesuffix('-desktop')}.webp")], check=True)
    sizes = {}
    for kind in ("phone", "wide"):
        for f in sorted((WEB / "public/shots" / kind).glob("*.webp")):
            w, h = subprocess.run(["magick", "identify", "-format", "%w %h", str(f)], capture_output=True, text=True, check=True).stdout.split()
            sizes[f"{kind}/{f.stem}"] = {"width": int(w), "height": int(h)}
    (WEB / "lib/shots.json").write_text(json.dumps(sizes, indent=2) + "\n")


if __name__ == "__main__":
    main()
