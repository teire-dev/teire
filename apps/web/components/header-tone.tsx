"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Marks `<html data-over-hero>` while a navy hero band (`[data-hero]`) sits under the floating header,
 * so the header turns transparent with ice-white ink there and back to its white pill after it.
 */
export function HeaderTone() {
  const path = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-checks for a hero band on every route change
  useEffect(() => {
    const root = document.documentElement;
    const hero = document.querySelector("[data-hero]");
    if (!hero) {
      delete root.dataset.overHero;
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) root.dataset.overHero = "";
        else delete root.dataset.overHero;
      },
      // The header's own band (its top 72px): the hero counts while any of it is still under there.
      { rootMargin: `0px 0px -${Math.max(0, window.innerHeight - 72)}px 0px`, threshold: 0 },
    );
    io.observe(hero);
    return () => {
      io.disconnect();
      delete root.dataset.overHero;
    };
  }, [path]);
  return null;
}
