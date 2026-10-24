import { Suspense } from "react";

/** GitHub sends people here after they install or reconfigure the App (setup URL). */
export default function Welcome({ searchParams }: { searchParams: Promise<{ setup_action?: string }> }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-4 py-24">
      <p className="font-mono text-sm text-foreground/60">teire</p>
      <Suspense fallback={<h1 className="text-3xl font-semibold tracking-tight">Teire is installed.</h1>}>
        <Heading searchParams={searchParams} />
      </Suspense>
      <p className="text-foreground/70">
        Teire is reading each repository you gave it: the exact versions your lockfiles pin, what the newer
        versions change, and which of your lines use what changed. In a few minutes every repository gets a
        pull request named <span className="font-mono">Configure Teire</span> with what it found. Merge it to
        turn Teire on.
      </p>
    </main>
  );
}

async function Heading({ searchParams }: { searchParams: Promise<{ setup_action?: string }> }) {
  const { setup_action } = await searchParams;
  return (
    <h1 className="text-3xl font-semibold tracking-tight">
      {setup_action === "update" ? "Teire's access is updated." : "Teire is installed."}
    </h1>
  );
}
