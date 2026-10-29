"use client";

import { motion, useInView, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * The landing's spine (plan revision 3.4, B1): one line that draws itself as the visitor scrolls, a
 * dot travelling at its head, through every station of the hero run. Phones run it down the left edge
 * (at the tile column's centre), wider screens down the middle. Reduced motion shows it drawn.
 */
export function ScrollSpine({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 75%", "end 55%"] });
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.4 });
  const head = useTransform(progress, (v) => `${Math.min(100, Math.max(0, v * 100))}%`);
  return (
    <div ref={ref} className="relative [--spine:40px] md:[--spine:50%]">
      <span
        aria-hidden
        className="absolute top-0 bottom-0 left-[var(--spine)] w-px -translate-x-1/2 bg-rule-strong"
      />
      <motion.span
        aria-hidden
        className="absolute top-0 bottom-0 left-[var(--spine)] w-[2px] origin-top -translate-x-1/2 bg-[linear-gradient(to_bottom,var(--signal),var(--signal)_70%,var(--proven))]"
        style={{ scaleY: reduce ? 1 : progress }}
      />
      {reduce ? null : (
        <motion.span
          aria-hidden
          className="absolute left-[var(--spine)] z-10 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal shadow-[0_0_0_5px_var(--signal-soft)]"
          style={{ top: head }}
        />
      )}
      {children}
    </div>
  );
}

/**
 * A station arrives on the spring as the line reaches it (once). Rendered visible on the server, so
 * no-JS, print and link previews see everything; once the page is live, what's still below the fold
 * is tucked away (instantly, unseen) and springs in when it enters.
 */
export function Reveal({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const seen = useInView(ref, { once: true, margin: "0px 0px -18% 0px" });
  const [live, setLive] = useState(false);
  // Anything already in view or scrolled past when the page goes live stays shown (a fast reader
  // who scrolled before hydration never finds an empty station behind them).
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    const check = () => {
      // In view or scrolled past (an anchor jump, End, a fast scroll): show it.
      if ((ref.current?.getBoundingClientRect().top ?? 0) < window.innerHeight * 0.9) setPassed(true);
    };
    check();
    setLive(true);
    window.addEventListener("scroll", check, { passive: true });
    const print = () => setPassed(true);
    window.addEventListener("beforeprint", print);
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("beforeprint", print);
    };
  }, []);
  const shown = reduce || !live || seen || passed;
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={false}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 28 }}
      transition={shown ? { type: "spring", stiffness: 150, damping: 20, mass: 0.8 } : { duration: 0 }}
    >
      {children}
    </motion.div>
  );
}
