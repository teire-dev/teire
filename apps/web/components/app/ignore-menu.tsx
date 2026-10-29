"use client";

import { EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { runAction } from "./run-action";

/**
 * Ignore, an icon with its menu (plan revision 3.3, U3; Dependabot's ignore conditions): this version only, this kind of
 * update (major, minor or patch) of the package, or the package altogether. A model or API change is
 * ignored whole. Each choice is the same action as `@teire ignore`, undoable from its toast.
 */
export function IgnoreMenu({ repo, group }: { repo: string; group: string }) {
  const router = useRouter();
  const [head, ...rest] = group.split("/");
  const provider = head === "models" || head === "api" || head === "runtime";
  // `advisory/<ecosystem>/<package>/<advisory id>` (U3 review): the advisory, or the package's findings.
  if (head === "advisory") {
    const name = rest.slice(1, -1).join("/");
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Ignore" title="Ignore">
            <EyeOff aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel className="eyebrow">Ignore</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() =>
              void runAction({ kind: "ignore", params: { target: group }, repo }).then(() => router.refresh())
            }
          >
            This advisory ({rest.at(-1)})
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void runAction({ kind: "ignore", params: { target: name }, repo }).then(() => router.refresh())
            }
          >
            Everything about {name}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  const pkg = provider ? null : rest.slice(0, -1).join("/");
  const version = provider ? null : rest.at(-1);
  const choose = async (params: Record<string, unknown>) => {
    await runAction({ kind: "ignore", params, repo });
    router.refresh();
  };
  if (!pkg)
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Ignore"
        title="Ignore"
        onClick={() => void choose({ target: group })}
      >
        <EyeOff aria-hidden />
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Ignore" title="Ignore">
          <EyeOff aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="eyebrow">Ignore {pkg}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void choose({ target: group })}>
          This version ({version})
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void choose({ target: pkg, update: "major" })}>
          Major updates
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void choose({ target: pkg, update: "minor" })}>
          Minor updates
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void choose({ target: pkg, update: "patch" })}>
          Patch updates
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void choose({ target: pkg })}>
          Every update of {pkg}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
