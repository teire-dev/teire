"use client";

import { motion, useReducedMotion } from "motion/react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { LogoMark } from "@/components/logo";
import { SPONSORS } from "@/lib/brands";
import { cn } from "@/lib/utils";

/**
 * A beam between two elements (21st.dev "Animated Beam", dillionverma, id 919, Magic UI). Adapted for
 * Teire (plan revision 3.4): `motion/react` instead of framer-motion, a fixed duration (the original's
 * random default breaks hydration), the signal → lime gradient from the tokens, and a still path
 * under reduced motion. For two-to-four-party connections only (sign-in, the install gate, empties).
 */
export function AnimatedBeam({
  containerRef,
  fromRef,
  toRef,
  curvature = 0,
  reverse = false,
  duration = 4.5,
  delay = 0,
  className,
}: {
  containerRef: RefObject<HTMLElement | null>;
  fromRef: RefObject<HTMLElement | null>;
  toRef: RefObject<HTMLElement | null>;
  curvature?: number;
  reverse?: boolean;
  duration?: number;
  delay?: number;
  className?: string;
}) {
  // useId's colons aren't valid in a `url(#…)` reference.
  const gid = `beam${useId().replace(/:/g, "")}`;
  const reduce = useReducedMotion();
  const [d, setD] = useState("");
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const update = () => {
      const c = containerRef.current;
      const a = fromRef.current;
      const b = toRef.current;
      if (!c || !a || !b) return;
      const cr = c.getBoundingClientRect();
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      setSize({ width: cr.width, height: cr.height });
      const sx = ra.left - cr.left + ra.width / 2;
      const sy = ra.top - cr.top + ra.height / 2;
      const ex = rb.left - cr.left + rb.width / 2;
      const ey = rb.top - cr.top + rb.height / 2;
      setD(`M ${sx},${sy} Q ${(sx + ex) / 2},${sy - curvature} ${ex},${ey}`);
    };
    const ro = new ResizeObserver(update);
    if (containerRef.current) ro.observe(containerRef.current);
    update();
    return () => ro.disconnect();
  }, [containerRef, fromRef, toRef, curvature]);
  const coords = reverse
    ? { x1: ["90%", "-10%"], x2: ["100%", "0%"] }
    : { x1: ["10%", "110%"], x2: ["0%", "100%"] };
  return (
    <svg
      aria-hidden
      fill="none"
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
      className={cn("pointer-events-none absolute top-0 left-0", className)}
    >
      <path d={d} stroke="currentColor" strokeWidth={2} strokeOpacity={0.22} strokeLinecap="round" />
      {reduce ? null : (
        <>
          <path d={d} stroke={`url(#${gid})`} strokeWidth={2} strokeLinecap="round" />
          <defs>
            <motion.linearGradient
              id={gid}
              gradientUnits="userSpaceOnUse"
              initial={{ x1: "0%", x2: "0%", y1: "0%", y2: "0%" }}
              animate={{ x1: coords.x1, x2: coords.x2, y1: ["0%", "0%"], y2: ["0%", "0%"] }}
              transition={{ delay, duration, ease: [0.16, 1, 0.3, 1], repeat: Number.POSITIVE_INFINITY }}
            >
              <stop stopColor="var(--signal)" stopOpacity="0" />
              <stop stopColor="var(--signal)" />
              <stop offset="32.5%" stopColor="var(--cta)" />
              <stop offset="100%" stopColor="var(--cta)" stopOpacity="0" />
            </motion.linearGradient>
          </defs>
        </>
      )}
    </svg>
  );
}

function Node({
  children,
  className,
  ref,
}: {
  children: React.ReactNode;
  className?: string;
  ref: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={ref}
      className={cn(
        "z-10 flex size-14 items-center justify-center rounded-tile bg-sheet shadow-tile",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * GitHub → Teire → your repositories, as beams: who tells Teire what (sign-in, the install gate). The
 * repositories are the person's own when known, otherwise ecosystem marks stand in for "repos".
 */
export function ConnectDiagram({
  repos,
  className,
}: {
  repos: { key: string; node: React.ReactNode }[];
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const gh = useRef<HTMLDivElement>(null);
  const teire = useRef<HTMLDivElement>(null);
  const r0 = useRef<HTMLDivElement>(null);
  const r1 = useRef<HTMLDivElement>(null);
  const r2 = useRef<HTMLDivElement>(null);
  const refs = [r0, r1, r2];
  return (
    <div
      ref={box}
      className={cn("relative flex w-full items-center justify-between gap-6 text-hero-ink", className)}
    >
      <Node ref={gh}>
        <BrandLogo light={SPONSORS.github.light} dark={SPONSORS.github.dark} alt="GitHub" className="h-7" />
      </Node>
      <Node ref={teire} className="size-16 bg-brand">
        <LogoMark className="size-10" />
      </Node>
      <div className="flex flex-col gap-3">
        {repos.slice(0, 3).map((r, i) => (
          <Node key={r.key} ref={refs[i] as RefObject<HTMLDivElement | null>} className="size-12">
            {r.node}
          </Node>
        ))}
      </div>
      <AnimatedBeam containerRef={box} fromRef={gh} toRef={teire} />
      {repos.slice(0, 3).map((r, i) => (
        <AnimatedBeam
          key={r.key}
          containerRef={box}
          fromRef={teire}
          toRef={refs[i] as RefObject<HTMLDivElement | null>}
          curvature={(1 - i) * 30}
          delay={0.4 + i * 0.3}
        />
      ))}
    </div>
  );
}
