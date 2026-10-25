import { Suspense } from "react";
import { NavLinks } from "@/components/nav-links";

const LINKS = [
  { href: "/app", label: "Overview", exact: true },
  { href: "/app/repos", label: "Repositories" },
  { href: "/app/settings", label: "Settings" },
] as const;

/** Dashboard sections; Overview matches exactly so it is not marked on its sub-pages. */
export function SubNav() {
  return (
    <div className="flex items-center gap-1 border-b pb-2 text-sm">
      <Suspense fallback={null}>
        <NavLinks links={LINKS} />
      </Suspense>
    </div>
  );
}
