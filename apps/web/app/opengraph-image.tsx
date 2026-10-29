import { ImageResponse } from "next/og";
import hero from "@/lib/landing/hero-run.json";

export const alt = "Teire: when upstream breaks, Teire fixes your code";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The site's link preview (plan revision 3.4, V1/B12): the hero's navy band, the promise, and the real
 * run's stations as tiles with their figures, from the committed snapshot.
 */
const STATIONS = [
  { label: hero.run.package, meta: `${hero.run.from} → ${hero.run.to}`, tone: "#1b2540" },
  { label: hero.repo.split("/")[1] ?? hero.repo, meta: "installed version", tone: "#1b2540" },
  { label: "Nemotron 3 Ultra", meta: `${hero.fix.calls} calls`, tone: "#1b2540" },
  { label: "Sandbox", meta: "network off", tone: "#1b2540" },
  { label: "Your checks", meta: `${hero.checks.tests.before} → ${hero.checks.tests.after}`, tone: "#0b7a4b" },
  { label: `PR #${hero.pr.number}`, meta: "ready", tone: "#0b7a4b" },
];

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "radial-gradient(120% 90% at 50% 0%, #0a2a8a 0%, #001033 60%, #000a24 100%)",
        color: "#fafeff",
        fontFamily: "Georgia, serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontFamily: "sans-serif", fontSize: 30 }}>
        <svg width="48" height="48" viewBox="0 0 32 32" role="img" aria-label="Teire">
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
        Teire
      </div>
      <div style={{ fontSize: 76, lineHeight: 1.04, letterSpacing: -1, maxWidth: 980 }}>
        When upstream breaks, Teire fixes your code.
      </div>
      <div style={{ display: "flex", alignItems: "center", fontFamily: "sans-serif" }}>
        {STATIONS.map((s, i) => (
          <div key={s.label} style={{ display: "flex", alignItems: "center" }}>
            {i > 0 ? (
              <div style={{ width: 34, height: 2, background: i >= 4 ? "#3ddc97" : "#6b97ff" }} />
            ) : null}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: "14px 16px",
                borderRadius: 16,
                background: "#ffffff",
                color: "#1b2540",
                border: `3px solid ${s.tone}`,
                minWidth: 140,
              }}
            >
              <div style={{ fontSize: 20, fontWeight: 600 }}>{s.label}</div>
              <div style={{ fontSize: 16, color: "#5e677f" }}>{s.meta}</div>
            </div>
          </div>
        ))}
      </div>
    </div>,
    size,
  );
}
