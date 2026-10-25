"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Top-level links; the current section is the one place the link accent marks navigation. */
export function NavLinks({ links }: { links: readonly { href: string; label: string; exact?: boolean }[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex items-center gap-1 text-sm">
      {links.map((l) => {
        const active = path === l.href || (!l.exact && path.startsWith(`${l.href}/`));
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1.5 transition-colors hover:bg-accent hover:text-foreground",
              active ? "text-link" : "text-muted-foreground",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
