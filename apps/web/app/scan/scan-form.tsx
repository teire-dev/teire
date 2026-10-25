"use client";

import { ArrowRight } from "lucide-react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type ScanState, startPublicScan } from "./actions";

export function ScanForm() {
  const [state, action, pending] = useActionState<ScanState, FormData>(startPublicScan, { error: null });
  return (
    <form action={action} className="flex flex-col gap-2">
      <label htmlFor="repo" className="text-sm font-medium">
        Public GitHub repository
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="repo"
          name="repo"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="owner/name or https://github.com/owner/name"
          defaultValue={state.input ?? ""}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "repo-error" : undefined}
          className="h-10 font-mono"
        />
        <Button type="submit" size="lg" className="h-10 px-4" disabled={pending}>
          {pending ? "Starting…" : "Scan"}
          {pending ? null : <ArrowRight data-icon="inline-end" />}
        </Button>
      </div>
      {state.error ? (
        <p id="repo-error" role="alert" className="text-sm text-affected">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
