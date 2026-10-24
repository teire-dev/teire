// Registers Teire's GitHub Apps under the teire-dev org with GitHub's manifest flow.
//   node scripts/register-github-app.mjs
// Open http://localhost:3999, click a button, approve on GitHub. Credentials are written to
// .env.local (dev app) or .env.production.local (prod app). Secrets are never printed.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const ORG = "teire-dev";
const PORT = 3999;
const PROD_URL = "https://teire.vercel.app";
const DEV_URL = "http://localhost:3000";
const REDIRECT = `http://localhost:${PORT}/callback`;

const permissions = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "write",
  actions: "read",
  emails: "read",
};
const events = ["pull_request", "issue_comment", "issues", "push", "check_suite", "repository"];
const description =
  "Keeps your code working when the services it depends on change. Finds affected code, fixes it with NVIDIA Nemotron on Nebius Token Factory, proves the fix in a sandbox, and opens a pull request you only have to review.";

async function smeeChannel() {
  const res = await fetch("https://smee.io/new", { redirect: "manual" });
  return res.headers.get("location");
}

const smeeUrl = await smeeChannel();

const apps = {
  prod: {
    file: ".env.production.local",
    manifest: {
      name: "Teire Bot",
      url: PROD_URL,
      description,
      hook_attributes: { url: `${PROD_URL}/api/github/webhooks`, active: true },
      redirect_url: REDIRECT,
      callback_urls: [`${PROD_URL}/api/auth/callback/github`],
      setup_url: `${PROD_URL}/welcome`,
      setup_on_update: true,
      public: true,
      request_oauth_on_install: false,
      default_permissions: permissions,
      default_events: events,
    },
  },
  dev: {
    file: ".env.local",
    manifest: {
      name: "Teire Bot Dev",
      url: `https://github.com/${ORG}/teire`,
      description: `${description} (development app)`,
      hook_attributes: { url: smeeUrl, active: true },
      redirect_url: REDIRECT,
      callback_urls: [`${DEV_URL}/api/auth/callback/github`],
      setup_url: `${DEV_URL}/welcome`,
      setup_on_update: true,
      public: false,
      request_oauth_on_install: false,
      default_permissions: permissions,
      default_events: events,
    },
  },
};

const states = new Map(); // state -> app key

function upsertEnv(file, values) {
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${JSON.stringify(value)}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
  }
  writeFileSync(file, text, { mode: 0o600 });
}

function page(body) {
  return `<!doctype html><meta charset="utf-8"><title>Register Teire GitHub Apps</title>
<style>body{font:15px system-ui;max-width:640px;margin:48px auto;padding:0 16px}button{font:inherit;padding:10px 16px;margin:8px 0;cursor:pointer}code{font-family:ui-monospace,monospace}</style>
${body}`;
}

function manifestForm(key) {
  const app = apps[key];
  const state = randomBytes(16).toString("hex");
  states.set(state, key);
  const manifest = JSON.stringify(app.manifest).replace(/"/g, "&quot;");
  return `<form id="${key}" method="post" action="https://github.com/organizations/${ORG}/settings/apps/new?state=${state}">
<input type="hidden" name="manifest" value="${manifest}"><button>Create “${app.manifest.name}”</button></form>`;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  // /prod and /dev go straight to GitHub's confirm page: one click there creates the app.
  const direct = url.pathname.slice(1);
  if (direct in apps) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page(`${manifestForm(direct)}<script>document.getElementById("${direct}").submit()</script>`));
    return;
  }
  if (url.pathname === "/") {
    const forms = Object.keys(apps).map(manifestForm).join("");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      page(
        `<h1>Register Teire's GitHub Apps</h1><p>Org: <code>${ORG}</code>. Create both; credentials go straight into the env files.</p>${forms}`,
      ),
    );
    return;
  }
  if (url.pathname === "/callback") {
    const key = states.get(url.searchParams.get("state") ?? "");
    const code = url.searchParams.get("code");
    if (!key || !code) {
      res.writeHead(400).end("Unknown state or missing code. Start again from http://localhost:3999");
      return;
    }
    states.delete(url.searchParams.get("state"));
    const conv = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!conv.ok) {
      res.writeHead(502).end(`GitHub returned ${conv.status}. Start again from http://localhost:3999`);
      return;
    }
    const app = await conv.json();
    upsertEnv(apps[key].file, {
      GITHUB_APP_ID: String(app.id),
      GITHUB_APP_SLUG: app.slug,
      GITHUB_CLIENT_ID: app.client_id,
      GITHUB_CLIENT_SECRET: app.client_secret,
      GITHUB_WEBHOOK_SECRET: app.webhook_secret,
      GITHUB_APP_PRIVATE_KEY: app.pem,
      ...(key === "dev" ? { SMEE_URL: smeeUrl } : {}),
    });
    console.log(
      `[register] ${key} app created: ${app.slug} (id ${app.id}); credentials written to ${apps[key].file}`,
    );
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      page(`<h1>Created ${app.name}</h1><p>Bot: <code>${app.slug}[bot]</code>. Credentials saved to <code>${apps[key].file}</code>.</p>
<p><a href="${app.html_url}">App settings</a> (upload the logo there) · <a href="/">Back</a></p>`),
    );
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`[register] open http://localhost:${PORT}`));
