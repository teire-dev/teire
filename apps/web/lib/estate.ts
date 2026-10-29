import { type Brand, ECOSYSTEMS } from "./brands";
import type { FlowLink, FlowState, FlowTile } from "./flow/model";
import { providerLogo } from "./logos";
import { until } from "./time";
import type { ChangeReach, Estate, EstateSource } from "./workspace";

/**
 * The estate map as tiles (plan revision 3.4, V4 and C8): three columns, the changes (or their
 * sources) reaching code, your repositories, and what Teire has open. Built on the server from
 * `estateOf`, so the client only places and moves tiles; both views ship together so the toggle is
 * instant.
 */
export type EstateColumn = 0 | 1 | 2;

export interface EstateTile extends FlowTile {
  column: EstateColumn;
  /** A change that can be dropped on a repository it reaches, to open that repository's Fix now. */
  drag?: { subject: string; reaches: ChangeReach[] };
  /** A repository tile's full name: what a dragged change is dropped on. */
  repo?: string;
}

export interface EstateLink extends FlowLink {
  /** How much the edge carries (call sites, changes, PRs): drawn as its weight. */
  weight?: number;
}

export interface EstateGraph {
  tiles: EstateTile[];
  links: EstateLink[];
}

const KIND_LABEL: Record<string, string> = {
  "runtime-eol": "Runtimes",
  "model-retirement": "Models",
  "security-advisory": "Advisories",
};

/** A change's mark: its provider for model and API changes, its ecosystem for packages. */
export function changeBrand(c: { provider: string | null; ecosystem: string | null }): Brand | undefined {
  if (c.provider) {
    const p = providerLogo(c.provider);
    return { label: p.name, light: p.light, dark: p.dark };
  }
  return c.ecosystem ? (ECOSYSTEMS[c.ecosystem] as Brand | undefined) : undefined;
}

const clip = (s: string, n = 22) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What a dragged change would do on one repository, as the edge between them is drawn. */
function reachState(r: ChangeReach): FlowState {
  switch (r.plan.kind) {
    case "running":
      return "live";
    case "open":
      return "done";
    case "run":
      return "pending";
    default:
      return "skipped";
  }
}

/** A source's name and mark: a provider's logo, an ecosystem's, else the kind in words. */
export function sourceBrand(
  kind: "provider" | "ecosystem" | "kind",
  slug: string,
): { label: string; brand?: Brand } {
  if (kind === "provider") {
    const p = providerLogo(slug);
    return { label: p.name, brand: { label: p.name, light: p.light, dark: p.dark } };
  }
  const eco = kind === "ecosystem" ? ECOSYSTEMS[slug] : undefined;
  return eco
    ? { label: eco.label, brand: eco as Brand }
    : { label: KIND_LABEL[slug] ?? slug.replace(/-/g, " ") };
}

function sourceTile(s: EstateSource): EstateTile {
  if (s.kind === "gaps")
    return {
      id: "s:gaps",
      column: 0,
      entity: "check",
      state: "not_proven",
      label: "Couldn't check",
      meta: `${s.changes} repo${s.changes === 1 ? "" : "s"}`,
      href: "/app/repos",
    };
  const { label, brand } = sourceBrand(s.kind, s.slug);
  return {
    id: `s:${s.key}`,
    column: 0,
    entity: "change",
    state: "done",
    label,
    meta: `${s.changes} change${s.changes === 1 ? "" : "s"}`,
    ...(brand ? { brand } : {}),
    href: s.kind === "provider" ? `/providers/${s.slug}` : "/app/changes",
  };
}

/** The middle and right columns, the same in both views: repositories and what Teire has open. */
function repoColumns(e: Estate) {
  const tiles: EstateTile[] = e.repos.map((r) => ({
    id: `r:${r.fullName}`,
    column: 1,
    entity: "repository",
    state: r.live ? "live" : "done",
    label: r.fullName.split("/")[1] ?? r.fullName,
    ...(r.reaching ? { meta: `${r.reaching} reaching` } : {}),
    ...(r.live ? { caption: "Working" } : {}),
    href: `/app/repos/${r.fullName}`,
    repo: r.fullName,
  }));
  if (e.moreRepos > 0)
    tiles.push({
      id: "r:more",
      column: 1,
      entity: "repository",
      state: "pending",
      label: `${e.moreRepos} more`,
      href: "/app/repos",
    });
  const outs = [
    {
      id: "o:ready",
      n: e.outcomes.ready,
      label: "Ready to merge",
      state: "proven",
      href: "/app/runs?show=open-prs&evidence=verified",
      key: "ready",
    },
    {
      id: "o:drafts",
      n: e.outcomes.drafts,
      label: "Drafts",
      state: "not_proven",
      href: "/app/runs?show=open-prs",
      key: "drafts",
    },
    {
      id: "o:issues",
      n: e.outcomes.issues,
      label: "Issues",
      state: "failed",
      href: "/app/runs?show=needs-you",
      key: "issues",
    },
  ] as const;
  const links: EstateLink[] = [];
  for (const o of outs) {
    if (!o.n) continue;
    tiles.push({
      id: o.id,
      column: 2,
      entity: "outcome",
      state: o.state,
      label: o.label,
      meta: String(o.n),
      href: o.href,
    });
    for (const r of e.repos) {
      const n = r[o.key];
      if (n)
        links.push({
          from: `r:${r.fullName}`,
          to: o.id,
          state: o.state,
          weight: n,
        });
    }
  }
  // Nothing open yet: the column still says where fixes land, and the reached repositories point there.
  if (!outs.some((o) => o.n)) {
    tiles.push({
      id: "o:none",
      column: 2,
      entity: "outcome",
      state: "pending",
      label: "Pull requests",
      meta: "none open",
      href: "/app/runs",
    });
  }
  return { tiles, links };
}

const repoId = (e: Estate, repo: string) =>
  e.repos.some((r) => r.fullName === repo) ? `r:${repo}` : "r:more";

/** The map by change: what reaches your code, most urgent first, each draggable onto a repository. */
export function changesGraph(e: Estate): EstateGraph {
  const right = repoColumns(e);
  const tiles: EstateTile[] = [];
  const links: EstateLink[] = [];
  for (const c of e.changes) {
    const id = `c:${c.id}`;
    const subject = c.subject ?? c.title;
    tiles.push({
      id,
      column: 0,
      entity: "change",
      state: c.reaches.some((r) => r.plan.kind === "running") ? "live" : "done",
      label: clip(subject, 28),
      ...(c.from || c.to ? { meta: clip(`${c.from ? `${c.from} ` : ""}→ ${c.to ?? "?"}`) } : {}),
      ...(c.deadline ? { caption: until(c.deadline) } : {}),
      ...(changeBrand(c) ? { brand: changeBrand(c) as Brand } : {}),
      href: `/app/changes?change=${encodeURIComponent(c.id)}`,
      drag: { subject, reaches: c.reaches },
    });
    // One edge per repository the change reaches (a repository off the map joins "N more").
    const seen = new Map<string, EstateLink>();
    for (const r of c.reaches) {
      const to = repoId(e, r.repo);
      const hit = seen.get(to);
      if (hit) {
        hit.weight = (hit.weight ?? 0) + 1;
        continue;
      }
      const link: EstateLink = {
        from: id,
        to,
        state: reachState(r),
        weight: r.sites >= 3 ? 2 : r.sites ? 1 : 0,
      };
      seen.set(to, link);
      links.push(link);
    }
  }
  if (e.moreChanges > 0)
    tiles.push({
      id: "c:more",
      column: 0,
      entity: "change",
      state: "pending",
      label: `${e.moreChanges} more`,
      href: "/app/changes",
    });
  if (e.gaps.length) {
    tiles.push({
      id: "c:gaps",
      column: 0,
      entity: "check",
      state: "not_proven",
      label: "Couldn't check",
      meta: `${e.gaps.length} repo${e.gaps.length === 1 ? "" : "s"}`,
      href: e.gaps.length === 1 ? `/app/repos/${e.gaps[0]?.repo}/findings` : "/app/repos",
    });
    for (const to of new Set(e.gaps.map((g) => repoId(e, g.repo))))
      links.push({ from: "c:gaps", to, state: "not_proven" });
  }
  if (right.tiles.some((t) => t.id === "o:none"))
    for (const r of e.repos)
      if (links.some((l) => l.to === `r:${r.fullName}` && l.from.startsWith("c:") && l.from !== "c:gaps"))
        right.links.push({ from: `r:${r.fullName}`, to: "o:none", state: "pending" });
  return { tiles: [...tiles, ...right.tiles], links: [...links, ...right.links] };
}

/** The map by source: providers and ecosystems with their changes, and what Teire couldn't check. */
export function sourcesGraph(e: Estate): EstateGraph {
  const right = repoColumns(e);
  const tiles = e.sources.map(sourceTile);
  const links: EstateLink[] = [];
  for (const s of e.sources) {
    const by = new Map<string, number>();
    for (const r of s.reaches) {
      const to = repoId(e, r.repo);
      by.set(to, (by.get(to) ?? 0) + r.n);
    }
    for (const [to, n] of by)
      links.push({
        from: `s:${s.kind === "gaps" ? "gaps" : s.key}`,
        to,
        state: s.kind === "gaps" ? "not_proven" : "done",
        weight: n,
      });
  }
  return { tiles: [...tiles, ...right.tiles], links: [...links, ...right.links] };
}
