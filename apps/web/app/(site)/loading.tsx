import { GhostFlow } from "@/components/flow/ghost-flow";
import { Skeleton } from "@/components/ui/skeleton";

/** A site page on its way: the flow in ghost state, then the shape of a title and a sheet. */
export default function SiteLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-14"
      role="status"
      aria-label="Loading"
    >
      <GhostFlow />
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-64 w-full rounded-card" />
    </div>
  );
}
