import Link from "next/link";
import { Button } from "@/components/ui/button";

/** A repository, tab or section that isn't there, or isn't in an installation you can see. */
export default function AppNotFound() {
  return (
    <section className="mx-auto flex w-full max-w-xl flex-col gap-3 rounded-xl bg-sheet p-6 shadow-card">
      <span className="eyebrow">Not found</span>
      <h1 className="text-lg font-semibold text-ink">Nothing here.</h1>
      <p className="text-sm text-ink-2">
        This repository or page doesn&apos;t exist, or it&apos;s in an installation your GitHub account
        can&apos;t see. If it was installed just now, refresh your installations in Settings.
      </p>
      <div className="flex gap-2">
        <Button size="sm" asChild>
          <Link href="/app/repos">Repositories</Link>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href="/app/settings/installations">Installations</Link>
        </Button>
      </div>
    </section>
  );
}
