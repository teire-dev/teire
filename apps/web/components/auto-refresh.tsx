"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** While the worker scans, the page re-renders every few seconds and shows the time elapsed. */
export function AutoRefresh({ since, everyMs = 3000 }: { since: string; everyMs?: number }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const refresh = setInterval(() => router.refresh(), everyMs);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [router, everyMs]);
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return (
    <span className="font-mono tabular-nums">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span>
  );
}
