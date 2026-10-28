"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * TanStack Query for the app's live islands (plan "Live islands", D122): one client per browser
 * session, polling only where a component asks and never while the tab is hidden (the default).
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 1000, retry: 1, refetchOnWindowFocus: true } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
