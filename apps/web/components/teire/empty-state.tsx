import { cn } from "@/lib/utils";

/**
 * An empty section that teaches (The Org's teaser): a dimmed preview of what will be here, real-looking
 * and inert, with one sentence and one action over it.
 */
export function EmptyState({
  title,
  body,
  action,
  preview,
  className,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
  preview?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative overflow-hidden", className)}>
      {preview ? (
        <div
          aria-hidden
          className="pointer-events-none select-none opacity-50 [mask-image:linear-gradient(to_bottom,black_10%,transparent_85%)]"
        >
          {preview}
        </div>
      ) : null}
      <div
        className={cn(
          "flex flex-col items-center gap-2 px-6 text-center",
          preview ? "absolute inset-x-0 bottom-0 pb-6" : "py-10",
        )}
      >
        <p className="text-sm font-medium text-ink">{title}</p>
        {body ? <p className="max-w-sm text-xs text-ink-3">{body}</p> : null}
        {action ? <div className="mt-1">{action}</div> : null}
      </div>
    </div>
  );
}
