import { sql } from "@teire/db";
import { type NextRequest, NextResponse } from "next/server";
import { ECOSYSTEMS } from "@/lib/brands";
import { database } from "@/lib/db";

/**
 * Real 404s for catalog pages that don't exist (revamp S3). The package, change and provider pages
 * stream from a prerendered shell, so a `notFound()` inside them arrives after a 200 has been sent:
 * a crawler, a link checker or a person's tool saw a page. This answers first, with the same
 * existence rule each page uses, and hands a missing one to the not-found page with a 404. A lookup
 * that fails (the database, deps.dev) lets the page decide, as before.
 */
export const config = { matcher: ["/packages/:path+", "/changes/:path+", "/providers/:path+"] };

/** Answers kept per path, so a page's prefetches and reloads don't each ask the database. */
const TTL_MS = 10 * 60_000;
const KEPT = 2_000;
const REGISTRY_TIMEOUT_MS = 4_000;
const seen = new Map<string, { ok: boolean; at: number }>();

/** deps.dev's name for each ecosystem (as `lib/entities.ts` reads it). */
const DEPS_DEV: Record<string, string> = {
  npm: "NPM",
  pypi: "PYPI",
  maven: "MAVEN",
  go: "GO",
  cargo: "CARGO",
  rubygems: "RUBYGEMS",
};

const decode = (parts: string[]) => parts.map(decodeURIComponent).join("/");

async function one(query: ReturnType<typeof sql>) {
  const { rows } = await database().execute(query);
  return rows.length > 0;
}

/** A package page exists for registry facts, a public catalog change, or a package deps.dev knows. */
async function packageExists(ecosystem: string, name: string) {
  if (!ECOSYSTEMS[ecosystem]) return false;
  if (
    await one(sql`
      select 1 from registry_cache where ecosystem = ${ecosystem} and name = ${name}
      union all
      select 1 from changes where ecosystem = ${ecosystem} and subject_name = ${name} and visibility = 'public'
      limit 1`)
  )
    return true;
  const system = DEPS_DEV[ecosystem];
  if (!system) return false;
  const res = await fetch(`https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (res.status === 404) return false;
  // Any other answer (a timeout throws) leaves it to the page.
  return true;
}

async function exists(kind: string, rest: string[]) {
  if (kind === "packages") {
    const [ecosystem = "", ...name] = rest;
    return name.length ? packageExists(ecosystem, decode(name)) : false;
  }
  if (kind === "changes")
    return one(sql`select 1 from changes where id = ${decode(rest)} and visibility = 'public' limit 1`);
  // A provider a repository declared in its own teire.yml stays private (D53), as on its page.
  return one(sql`
    select 1 from providers where slug = ${decode(rest)}
      and not coalesce(record->'discovery'->'via' ? 'teire.yml', false)
    limit 1`);
}

export async function proxy(request: NextRequest) {
  const [, kind = "", ...rest] = request.nextUrl.pathname.split("/");
  const key = `${kind}/${rest.join("/")}`;
  const now = Date.now();
  let hit = seen.get(key);
  if (!hit || now - hit.at > TTL_MS) {
    try {
      hit = { ok: await exists(kind, rest), at: now };
    } catch {
      return NextResponse.next();
    }
    if (seen.size >= KEPT) seen.delete(seen.keys().next().value as string);
    seen.set(key, hit);
  }
  if (hit.ok) return NextResponse.next();
  // An unmatched path renders the app's not-found page with a real 404.
  return NextResponse.rewrite(new URL("/_missing", request.url), { status: 404 });
}
