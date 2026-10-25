import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { repoAction } from "./actions";

/** A one-click repo command (rescan, pause, fix…) as a form, so it works without client JavaScript. */
export function ActionButton({
  repo,
  action,
  target,
  back,
  children,
  variant = "outline",
}: {
  repo: string;
  action: string;
  target?: string;
  back?: string;
  children: ReactNode;
  variant?: "outline" | "default" | "ghost";
}) {
  return (
    <form action={repoAction}>
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="action" value={action} />
      {target ? <input type="hidden" name="target" value={target} /> : null}
      {back ? <input type="hidden" name="back" value={back} /> : null}
      <Button type="submit" size="sm" variant={variant}>
        {children}
      </Button>
    </form>
  );
}
