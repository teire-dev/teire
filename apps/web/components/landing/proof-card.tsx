import { ArrowUpRight } from "lucide-react";
import localFont from "next/font/local";
import Link from "next/link";
import hero from "@/lib/landing/hero-run.json";
import pen from "@/lib/landing/pen.json";
import { cn } from "@/lib/utils";

/** The investigator's pen from the demo film (D7: the landing hero, the README and Devpost art only). */
const virgil = localFont({ src: "../../app/fonts/Virgil.woff2", display: "swap" });

/** "4/4 passed" → "4/4"; a typecheck that passes says so. */
const after = (name: "typecheck" | "test") =>
  name === "test" ? hero.checks.tests.after : hero.checks.typecheck.after ? "pass" : "fail";

/**
 * The hero's proof (revamp S4, the thumbnail the owner chose): the real zod run's checks, what the
 * upgrade broke on the left and what passed after the fix on the right, with the pen's ring around
 * the green column. Every figure comes from the run's committed snapshot; the card opens the run and
 * the note opens its pull request. The pen strokes are rough.js output baked once (`pen.json`), so
 * the page draws them as plain paths. Fixed size so the ring stays on its column; phones zoom it.
 */
export function ProofCard({ className }: { className?: string }) {
  const rows = (["typecheck", "test"] as const).map((name) => ({
    name: name === "test" ? "tests" : name,
    broke: hero.broke[name],
    after: after(name),
  }));
  return (
    <div
      className={cn(
        "relative h-[300px] w-[480px] shrink-0 max-sm:[zoom:0.66] max-[400px]:[zoom:0.5]",
        className,
      )}
    >
      <Link
        href={hero.run.href}
        aria-label={`The run: ${hero.run.package} ${hero.run.from} to ${hero.run.to} on ${hero.repo}, typecheck and tests fail after the upgrade and pass after the fix`}
        className="absolute top-2 left-0 block w-[440px] -rotate-2 rounded-[18px] bg-[#15181e] px-6 pt-5 pb-6 text-hero-ink shadow-[0_40px_90px_rgb(0_0_0/0.55)] ring-1 ring-white/12 transition-[box-shadow,translate] hover:-translate-y-0.5 hover:ring-white/20"
      >
        <p className="mb-3 font-mono text-[13px] text-hero-ink-2">
          {hero.run.package} {hero.run.from} → {hero.run.to} · the upgrade broke it
        </p>
        {rows.map((r) => (
          <div
            key={r.name}
            data-row={r.name}
            className="grid grid-cols-[100px_112px_44px_1fr] items-center border-t border-white/10 py-3 font-mono text-[22px] whitespace-nowrap"
          >
            <span className="text-[17px] text-hero-ink-2">{r.name}</span>
            <span className="text-hero-broke">✗ exit {r.broke?.exit}</span>
            <span className="text-center text-hero-ink-2">→</span>
            <span data-ok className="w-fit text-hero-proven">
              ✓ {r.after}
            </span>
          </div>
        ))}
      </Link>
      <svg
        aria-hidden
        viewBox={`0 0 ${pen.width} ${pen.height}`}
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
      >
        {pen.paths.map((d, i) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="var(--cta)"
            strokeWidth={i === 0 ? 3.5 : 2.75}
            strokeLinecap="round"
          />
        ))}
      </svg>
      <a
        href={hero.pr.url}
        className={cn(
          virgil.className,
          "absolute -rotate-3 text-[25px] whitespace-nowrap text-cta hover:underline",
        )}
        style={{ left: pen.note.x, top: pen.note.y }}
      >
        fixed by Nemotron · proven
        <ArrowUpRight className="ml-1 inline size-4 align-baseline" aria-hidden />
      </a>
    </div>
  );
}
