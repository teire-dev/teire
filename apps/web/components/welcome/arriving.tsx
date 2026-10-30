"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * GitHub lists the installation for this person, but Teire hasn't read its webhook yet: the page reads
 * again every two seconds. After two minutes it says so plainly and offers to read again.
 */
export function Arriving() {
  const router = useRouter();
  const [late, setLate] = useState(false);
  useEffect(() => {
    const began = Date.now();
    const t = setInterval(() => {
      if (Date.now() - began > 2 * 60_000) {
        setLate(true);
        clearInterval(t);
      } else router.refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [router]);
  return late ? (
    <p className="flex flex-col items-center gap-3 text-sm text-ink-2">
      GitHub hasn't told Teire about it yet.
      <button type="button" onClick={() => window.location.reload()} className="text-link hover:underline">
        Check again
      </button>
    </p>
  ) : (
    <p className="flex items-center gap-2 text-sm text-ink-2">
      <span className="size-2 animate-pulse rounded-full bg-cta" aria-hidden />
      GitHub is handing it over…
    </p>
  );
}
