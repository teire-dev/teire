"use client";

import { Flag } from "lucide-react";
import { useState } from "react";
import { SignInButton } from "@/components/sign-in-button";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

/** "Wrong? Tell us" (plan revision 3.3, U5): a report stored with the change, in the page. */
export function ChangeFeedback({ changeId }: { changeId: string }) {
  const session = authClient.useSession();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  if (state === "sent") return <p className="text-xs text-proven">Thanks; recorded with this change.</p>;
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Flag className="size-3" aria-hidden />
        Wrong? Tell us
      </button>
    );
  if (!session.isPending && !session.data)
    return (
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        Sign in so we can follow up.
        <SignInButton size="sm" variant="outline" next={`/changes/${changeId}`} label="Sign in" />
      </div>
    );
  return (
    <form
      className="flex w-full max-w-xl flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setState("sending");
        setError(null);
        const res = await fetch("/api/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ changeId, reason: text }),
        }).catch(() => null);
        const body = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (body?.ok) setState("sent");
        else {
          setError(body?.error ?? "Teire couldn't be reached");
          setState("idle");
        }
      }}
    >
      <label htmlFor="change-feedback" className="text-xs text-muted-foreground">
        What's wrong? A link to the source helps.
      </label>
      <textarea
        id="change-feedback"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        maxLength={2000}
        rows={3}
        className="rounded-md bg-sunken p-2 text-sm text-ink ring-1 ring-rule ring-inset outline-none focus-visible:ring-signal"
      />
      {error ? <p className="text-xs text-broke">{error}</p> : null}
      <span className="flex gap-2">
        <Button type="submit" size="sm" disabled={!text.trim() || state === "sending"}>
          {state === "sending" ? "Sending…" : "Send"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </span>
    </form>
  );
}
