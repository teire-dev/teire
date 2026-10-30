"use client";

import { motion, useReducedMotion } from "motion/react";
import { LogoMark } from "@/components/logo";
import { cn } from "@/lib/utils";

/**
 * Onboarding's finish (plan revision 3.4, V2 step 6: "the mark draws its leaf, a short burst"): the
 * check stroke draws, the leaf grows from its stem, then eight chartreuse sparks fly out once and
 * fade. Under reduced motion it is the still mark.
 */
const SPARKS = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2);

export function LeafBurst({ className }: { className?: string }) {
  const still = useReducedMotion();
  if (still) return <LogoMark className={cn("size-14", className)} />;
  return (
    <span className={cn("relative inline-flex size-14", className)} aria-hidden>
      <svg viewBox="0 0 32 32" className="size-14 overflow-visible" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-brand" />
        <rect
          x=".5"
          y=".5"
          width="31"
          height="31"
          rx="7.5"
          fill="none"
          strokeWidth="1"
          className="stroke-white/14"
        />
        <motion.path
          d="M8.6 16.9 13.6 21.6"
          className="stroke-white"
          fill="none"
          strokeWidth="2.8"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        />
        <motion.g
          style={{ transformOrigin: "13.6px 21.6px" }}
          initial={{ scale: 0, rotate: -25, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ delay: 0.3, type: "spring", stiffness: 260, damping: 16 }}
        >
          <path
            d="M12.6 20.7C14.5 14.2 19.1 10.2 24.6 9.1 24.4 14.6 20.6 20.4 14.7 22.6Z"
            className="fill-cta"
          />
          <path
            d="M14.3 20.9 21.9 12.3"
            className="stroke-brand"
            fill="none"
            strokeWidth="0.9"
            strokeLinecap="round"
          />
        </motion.g>
      </svg>
      {SPARKS.map((a) => (
        <motion.span
          key={a}
          className="absolute top-1/2 left-1/2 size-1.5 rounded-full bg-cta shadow-[0_0_0_1px_var(--cta-edge)]"
          initial={{ x: "-50%", y: "-50%", opacity: 0, scale: 0.4 }}
          animate={{
            x: `calc(-50% + ${Math.cos(a) * 44}px)`,
            y: `calc(-50% + ${Math.sin(a) * 44}px)`,
            opacity: [0, 1, 0],
            scale: [0.4, 1, 0.6],
          }}
          transition={{ delay: 0.62, duration: 0.7, ease: "easeOut" }}
        />
      ))}
    </span>
  );
}
