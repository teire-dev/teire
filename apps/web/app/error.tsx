"use client";

import { StatePage } from "@/components/state-page";

/** Something failed while rendering: said plainly, with a retry and the reference for support. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <StatePage kind="error" digest={error.digest} reset={reset} />;
}
