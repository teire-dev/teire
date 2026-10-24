export default function Home() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-4 py-24">
      <p className="font-mono text-sm text-foreground/60">teire</p>
      <h1 className="text-3xl font-semibold tracking-tight">
        Keeps your code working when the services it depends on change.
      </h1>
      <p className="text-foreground/70">
        Teire watches providers like OpenAI, Anthropic, Gemini, Stripe and Nebius Token Factory, finds the
        code a change affects, fixes it with NVIDIA Nemotron, proves the fix in a sandbox, and opens a pull
        request you only have to review.
      </p>
    </main>
  );
}
