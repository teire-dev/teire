"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { refreshMyInstallations } from "@/app/(app)/app/actions";
import { Button } from "@/components/ui/button";

/** Asks GitHub again which installations this account can see, and says how many it found. */
export function RefreshInstallations() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const out = await refreshMyInstallations();
          if ("error" in out) toast.error(out.error);
          else
            toast.success(`GitHub says you can see ${out.count} installation${out.count === 1 ? "" : "s"}`);
          router.refresh();
        })
      }
    >
      <RefreshCw className={pending ? "animate-spin" : undefined} data-icon="inline-start" aria-hidden />
      Refresh from GitHub
    </Button>
  );
}
