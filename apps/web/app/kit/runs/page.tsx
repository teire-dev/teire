import { connection } from "next/server";
import { Suspense } from "react";
import { KitShell } from "@/components/teire/kit-shell";
import { RunRowItem } from "@/components/teire/run-row";
import { Surface } from "@/components/teire/surface";
import { kitRuns, kitShell, requireKit } from "@/lib/kit";

export const metadata = { title: "Runs" };

export default function KitRunsPage() {
  return (
    <Suspense fallback={<div className="m-8 h-96 animate-pulse rounded-lg bg-sheet shadow-card" />}>
      <Runs />
    </Suspense>
  );
}

async function Runs() {
  await connection();
  await requireKit();
  const [rows, shell] = await Promise.all([kitRuns(), kitShell()]);
  return (
    <KitShell
      account={shell.account}
      repos={shell.repos}
      crumbs={[{ label: shell.account.login, href: "/kit/overview" }, { label: "Runs" }]}
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Runs</span>
          <h1 className="heading text-2xl text-ink">Every run, newest first</h1>
        </div>
        <Surface flush>
          <ul className="divide-y divide-rule">
            {rows.map((r) => (
              <RunRowItem key={r.id} row={r} href={`/kit/run/${r.id}`} />
            ))}
          </ul>
        </Surface>
      </div>
    </KitShell>
  );
}
