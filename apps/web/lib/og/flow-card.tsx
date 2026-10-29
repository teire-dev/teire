import { ImageResponse } from "next/og";
import type { FlowGraph, FlowState } from "@/lib/flow/model";

/**
 * Link previews that draw a flow (plan revision 3.4, V6 and B12): the run, a change and a scan report
 * as Teire's tiles on the hero navy, each tile in its state's colour with its logo, under the thing's
 * own name. Satori draws it (`next/og`), so it is plain flexbox and inline styles; logos are fetched
 * from the site and inlined.
 */
export const OG_SIZE = { width: 1200, height: 630 };

const RING: Record<FlowState, string> = {
  pending: "#8e98b3",
  live: "#6b97ff",
  done: "#c9d0e0",
  proven: "#3ddc97",
  not_proven: "#f2b33d",
  failed: "#ff6b6b",
  skipped: "#5e677f",
};

/** A result's mark, drawn (the image font has no ✓ or ◐), so colour is never the only signal. */
function Glyph({ state }: { state: FlowState }) {
  const c = RING[state];
  if (state === "proven")
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" role="img" aria-label="proven">
        <path
          d="M5 12.5 10 17 19 7"
          fill="none"
          stroke={c}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (state === "failed")
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" role="img" aria-label="failed">
        <path d="M6 6 18 18M18 6 6 18" fill="none" stroke={c} strokeWidth="3.2" strokeLinecap="round" />
      </svg>
    );
  if (state === "not_proven")
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" role="img" aria-label="not proven">
        <circle cx="12" cy="12" r="8" fill="none" stroke={c} strokeWidth="2.6" />
        <path d="M12 4a8 8 0 0 1 0 16Z" fill={c} />
      </svg>
    );
  return null;
}

/** A logo as a data URI, or nothing when it can't be fetched (the tile keeps its label). */
async function inline(origin: string, path: string | undefined) {
  if (!path) return null;
  try {
    const res = await fetch(new URL(path, origin));
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "image/svg+xml";
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {
    return null;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function flowCard({
  origin,
  eyebrow,
  title,
  graph,
  footer,
  shared = false,
}: {
  origin: string;
  /** Public catalog data only: may sit in shared caches. */
  shared?: boolean;
  eyebrow: string;
  title: string;
  graph: FlowGraph;
  footer?: string;
}) {
  // Six fit: a longer run keeps its start and its end (the outcome is the point).
  const tiles = graph.tiles.length > 6 ? [...graph.tiles.slice(0, 2), ...graph.tiles.slice(-4)] : graph.tiles;
  const logos = await Promise.all(tiles.map((t) => inline(origin, t.brand?.light)));
  const linkTo = new Map(graph.links.map((l) => [l.to, l.state]));
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 64,
        background: "radial-gradient(120% 90% at 50% 0%, #0a2a8a 0%, #001033 60%, #000a24 100%)",
        color: "#fafeff",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 24, color: "#c9d0e0" }}>
        <svg width="40" height="40" viewBox="0 0 32 32" role="img" aria-label="Teire">
          <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#1b2540" stroke="rgba(250,254,255,0.35)" />
          <path
            d="M8.6 16.9 13.6 21.6"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <path d="M12.6 20.7C14.5 14.2 19.1 10.2 24.6 9.1 24.4 14.6 20.6 20.4 14.7 22.6Z" fill="#d0f100" />
          <path d="M14.3 20.9 21.9 12.3" fill="none" stroke="#1b2540" strokeWidth="0.9" strokeLinecap="round" />
        </svg>
        <span style={{ color: "#fafeff", fontWeight: 600 }}>Teire</span>
        <span>·</span>
        <span>{clip(eyebrow, 60)}</span>
      </div>
      <div
        style={{
          fontSize: 60,
          lineHeight: 1.06,
          letterSpacing: -1,
          maxWidth: 1060,
        }}
      >
        {clip(title, 90)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          {tiles.map((t, i) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center" }}>
              {i > 0 ? (
                <div style={{ width: 26, height: 3, background: RING[linkTo.get(t.id) ?? t.state] }} />
              ) : null}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  width: 158,
                  padding: "14px 14px",
                  borderRadius: 16,
                  background: "#ffffff",
                  color: "#1b2540",
                  border: `4px ${t.state === "pending" || t.state === "skipped" ? "dashed" : "solid"} ${RING[t.state]}`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    height: 26,
                  }}
                >
                  {logos[i] ? (
                    // biome-ignore lint/performance/noImgElement: Satori draws plain <img>.
                    <img src={logos[i] as string} height={24} style={{ maxWidth: 70 }} alt="" />
                  ) : (
                    <div style={{ width: 10, height: 10, borderRadius: 10, background: RING[t.state] }} />
                  )}
                  <Glyph state={t.state} />
                </div>
                <div style={{ fontSize: 19, fontWeight: 600 }}>{clip(t.label, 16)}</div>
                <div style={{ fontSize: 15, color: "#5e677f" }}>
                  {clip(t.meta ?? t.caption ?? "", 18) || " "}
                </div>
              </div>
            </div>
          ))}
        </div>
        {footer ? <div style={{ fontSize: 20, color: "#8e98b3" }}>{clip(footer, 100)}</div> : null}
      </div>
    </div>,
    {
      ...OG_SIZE,
      // A repository's image is drawn fresh each time: a repository that turns private must not keep
      // a cached picture of its run (V5–V6 review). The public catalog's change images may be shared.
      headers: { "cache-control": shared ? "public, max-age=300, s-maxage=300" : "no-store" },
    },
  );
}
