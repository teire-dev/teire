import { Check, GitPullRequest } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { Badge } from "@/components/ui/badge";

/**
 * A real Teire pull request, drawn as product UI (signature move: the receipt). Content from the
 * verified run on teire-dev/demo-ai-web (context/11-build-notes/s04-status.md): OpenAI shut
 * gpt-4.1-nano down on 2026-10-23; the swap to the provider's named replacement passed the repo's
 * own checks, tests 1/3 on the baseline and 3/3 after.
 */
const SITE = 'model: openai.chat("gpt-4.1-nano"),';

export function ExamplePr() {
  return (
    <figure className="w-full overflow-hidden rounded-lg bg-card text-left shadow-card">
      <figcaption className="sr-only">
        An example pull request Teire opened on a demo repository after OpenAI retired gpt-4.1-nano.
      </figcaption>
      <div className="flex items-start gap-3 border-b px-4 py-3">
        <GitPullRequest className="mt-0.5 size-4 shrink-0 text-clear" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">
            fix(openai): gpt-4.1-nano stopped working on 2026-10-23
          </p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            teire-dev/demo-ai-web · teire/models/openai
          </p>
        </div>
        <Badge variant="clear" className="font-mono">
          verified
        </Badge>
      </div>

      <div className="grid gap-0 divide-y text-sm">
        <section className="px-4 py-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">What changed upstream</p>
          <div className="flex items-center gap-2">
            <BrandLogo
              light="/logos/openai-light.svg"
              dark="/logos/openai-dark.svg"
              alt="OpenAI"
              className="h-4"
            />
            <span>
              <span className="font-mono line-through decoration-affected/70">gpt-4.1-nano</span>
              <span className="text-muted-foreground"> shut down; the provider names </span>
              <span className="font-mono">gpt-5.6-luna</span>
            </span>
          </div>
        </section>

        <section className="px-4 py-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Why this repo · 1 call site</p>
          <div className="overflow-hidden rounded-md border font-mono text-xs">
            <div className="flex justify-between border-b bg-muted/60 px-3 py-1.5 text-muted-foreground">
              <span>src/summarize.ts</span>
              <span>
                <span className="text-clear">+1</span> <span className="text-affected">−1</span>
              </span>
            </div>
            <pre className="overflow-x-auto leading-6">
              <span className="block bg-affected-soft px-3 text-affected">
                <span className="select-none pr-3 opacity-60">13 −</span>
                {`    ${SITE}`}
              </span>
              <span className="block bg-clear-soft px-3 text-clear">
                <span className="select-none pr-3 opacity-60">13 +</span>
                {'    model: openai.chat("gpt-5.6-luna"),'}
              </span>
            </pre>
          </div>
        </section>

        <section className="px-4 py-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Verification · your own checks, before and after
          </p>
          <table className="w-full font-mono text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 text-left font-normal">check</th>
                <th className="py-1 text-right font-normal">baseline</th>
                <th className="py-1 text-right font-normal">after</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t">
                <td className="py-1.5">tsc --noEmit</td>
                <td className="py-1.5 text-right text-clear">pass</td>
                <td className="py-1.5 text-right text-clear">pass</td>
              </tr>
              <tr className="border-t">
                <td className="py-1.5">vitest run</td>
                <td className="py-1.5 text-right text-affected">1/3</td>
                <td className="py-1.5 text-right text-clear">
                  3/3 <Check className="inline size-3" aria-label="passed" />
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="bg-muted/40 px-4 py-3 font-mono text-xs leading-6 text-muted-foreground">
          <p className="flex gap-2">
            <span>locate</span>
            <span className="flex-1 overflow-hidden whitespace-nowrap text-border">
              ........................................
            </span>
            <span>ast-grep · 8 files</span>
          </p>
          <p className="flex gap-2">
            <span>fix</span>
            <span className="flex-1 overflow-hidden whitespace-nowrap text-border">
              ........................................
            </span>
            <span>replacement from the source · $0.00</span>
          </p>
          <p className="flex gap-2">
            <span>verify</span>
            <span className="flex-1 overflow-hidden whitespace-nowrap text-border">
              ........................................
            </span>
            <span>sandbox · network off for tests</span>
          </p>
        </section>
      </div>
    </figure>
  );
}
