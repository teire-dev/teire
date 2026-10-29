"use client";

import { ArrowRight } from "lucide-react";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type ScanState, startPublicScan } from "./actions";

/** The owner a typed value names ("owner/name" or a GitHub URL), for its avatar beside the field. */
function ownerOf(value: string) {
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/[\w.-]+/.exec(value.trim());
  return m?.[1] ?? null;
}

export function ScanForm() {
  const [state, action, pending] = useActionState<ScanState, FormData>(startPublicScan, { error: null });
  // The owner's avatar while you type (plan revision 3.4, V5: "the repository's avatar previews").
  const [value, setValue] = useState(state.input ?? "");
  const owner = ownerOf(value);
  return (
    <form action={action} className="flex flex-col gap-2">
      <label htmlFor="repo" className="sr-only">
        Public GitHub repository
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          {owner ? (
            // biome-ignore lint/performance/noImgElement: GitHub's own avatar URL, a 32px preview.
            <img
              src={`https://github.com/${owner}.png?size=64`}
              alt=""
              className="absolute top-1/2 left-2.5 size-7 -translate-y-1/2 rounded-full bg-sunken ring-1 ring-rule"
            />
          ) : null}
          <Input
            id="repo"
            name="repo"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="owner/name or https://github.com/owner/name"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "repo-error" : undefined}
            className={`h-12 rounded-full border-0 bg-white font-mono text-ink shadow-float ${owner ? "pr-5 pl-12" : "px-5"}`}
          />
        </div>
        <Button type="submit" variant="cta" size="xl" shape="pill" className="h-12" disabled={pending}>
          {pending ? "Starting…" : "Scan"}
          {pending ? null : <ArrowRight data-icon="inline-end" />}
        </Button>
      </div>
      {state.error ? (
        <p id="repo-error" role="alert" className="text-sm text-[#ff9aa4]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
