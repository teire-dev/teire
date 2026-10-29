import Link from "next/link";
import { BrokenFlow } from "@/components/state-page";
import { Button } from "@/components/ui/button";

/**
 * A repository, tab or section that isn't there, or isn't in an installation you can see: the broken
 * flow, one line, and the two ways on (the repositories you have, or refreshing what GitHub lists).
 */
export default function AppNotFound() {
  return (
    <section className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 py-16 text-center">
      <BrokenFlow kind="not-found" />
      <div className="flex flex-col gap-1.5">
        <h1 className="heading text-2xl text-ink">Nothing here.</h1>
        <p className="text-sm text-ink-2">Not in an installation you can see.</p>
      </div>
      <div className="flex gap-2">
        <Button asChild>
          <Link href="/app/repos">Repositories</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/app/settings/installations">Refresh installations</Link>
        </Button>
      </div>
    </section>
  );
}
