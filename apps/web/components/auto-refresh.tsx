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
    <span className="font-mono tabular-nums">
      {s < 60
        ? `${s}s`
        : s < 3600
          ? `${Math.floor(s / 60)}m ${s % 60}s`
          : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`}
    </span>
  );
}
