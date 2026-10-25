"use client";

import { useState } from "react";
import { GithubMark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

/** GitHub is the only sign-in (C1); after it, the person lands where they were going. */
export function SignInButton({
  next = "/app",
  label = "Sign in",
  ...props
}: { next?: string; label?: string } & Omit<React.ComponentProps<typeof Button>, "onClick">) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      {...props}
      disabled={pending}
      onClick={() => {
        setPending(true);
        void authClient.signIn
          .social({ provider: "github", callbackURL: next })
          .catch(() => setPending(false));
      }}
    >
      <GithubMark data-icon="inline-start" />
      {pending ? "Opening GitHub…" : label}
    </Button>
  );
}

export function SignOutButton() {
  return (
    <button
      type="button"
      className="w-full text-left"
      onClick={() => void authClient.signOut().then(() => window.location.assign("/"))}
    >
      Sign out
    </button>
  );
}
