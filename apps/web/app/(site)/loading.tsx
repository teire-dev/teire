import { Skeleton } from "@/components/ui/skeleton";

/** A site page on its way: the shape of a page (a title, a lead, a sheet). */
export default function SiteLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-12"
      role="status"
      aria-label="Loading"
    >
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="mt-4 h-64 w-full" />
    </div>
  );
}
