"use client";

import { StatePage } from "@/components/state-page";

/** A site page that failed keeps the header and footer, with a retry and the reference. */
export default function SiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <StatePage kind="error" digest={error.digest} reset={reset} inset />;
}
