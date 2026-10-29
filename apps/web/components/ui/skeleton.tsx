import { cn } from "@/lib/utils";

/** The one loading block (plan revision 3.4 clean-up): sunken, with a sweep of light. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("rounded-control shimmer", className)} {...props} />;
}

export { Skeleton };
