"use client";

import { ExternalLink, LogOut, Trash2, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { type ActionState, removeRepositoryAccess, revokeMyGitHubAccess } from "@/app/(app)/app/actions";
import { followAction } from "@/components/app/follow-action";
import { SignInButton } from "@/components/sign-in-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

/**
 * Taking Teire's access away from inside Teire (Settings → Account, Installations, a repository's
 * page): sign out everywhere, revoke Teire's GitHub authorization, delete the Teire account, uninstall
 * from an account, take one repository out. Each that can't be undone asks for the name typed first.
 */

/** A dialog whose confirm button unlocks when the name is typed, with the result said in place. */
function Confirm({
  trigger,
  title,
  body,
  name,
  verb,
  run,
}: {
  trigger: React.ReactNode;
  title: string;
  body: React.ReactNode;
  /** Typed to confirm; omitted for what can be undone by signing in again. */
  name?: string;
  verb: string;
  run: (say: (s: React.ReactNode) => void) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<React.ReactNode>(null);
  const field = useId();
  const ready = !name || typed.trim().toLowerCase() === name.toLowerCase();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setTyped("");
          setSaid(null);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2 text-sm text-ink-2">{body}</div>
          </DialogDescription>
        </DialogHeader>
        {name ? (
          <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            <label htmlFor={field}>
              Type <span className="font-mono text-ink">{name}</span> to confirm
            </label>
            <Input id={field} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
        ) : null}
        {said ? <div className="rounded-card bg-sunken px-3 py-2 text-[13px] text-ink">{said}</div> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!ready || busy}
            onClick={async () => {
              setBusy(true);
              setSaid(null);
              await run(setSaid).catch((error: unknown) =>
                setSaid(error instanceof Error ? error.message : "Something went wrong; try again"),
              );
              setBusy(false);
            }}
          >
            {busy ? "Working…" : verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SignOutEverywhere() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void authClient
          .revokeSessions()
          .then(() => authClient.signOut())
          .finally(() => window.location.assign("/"));
      }}
    >
      <LogOut data-icon="inline-start" aria-hidden />
      {busy ? "Signing out…" : "Sign out everywhere"}
    </Button>
  );
}

export function RevokeGitHubAccess() {
  return (
    <Confirm
      trigger={
        <Button variant="outline">
          <Unplug data-icon="inline-start" aria-hidden />
          Revoke Teire's GitHub access
        </Button>
      }
      title="Revoke Teire's GitHub access?"
      body={
        <>
          <p>
            Teire stops acting as you on GitHub and you're signed out everywhere. Signing in again asks GitHub
            again.
          </p>
          <p>Your installations keep running: uninstall them to stop Teire on your repositories.</p>
        </>
      }
      verb="Revoke access"
      run={async (say) => {
        const out = await revokeMyGitHubAccess();
        if ("error" in out) return say(out.error);
        window.location.assign("/");
      }}
    />
  );
}

export function DeleteAccount({ login }: { login: string }) {
  return (
    <Confirm
      trigger={
        <Button variant="destructive">
          <Trash2 data-icon="inline-start" aria-hidden />
          Delete my Teire account
        </Button>
      }
      title="Delete your Teire account?"
      body={
        <>
          <p>
            Gone: your sign-in, Teire's GitHub access for you, your Ask Teire threads, and what Teire knew you
            could see.
          </p>
          <p>
            Stays: your installations and their pull requests, which keep running until you uninstall them,
            and the history of what you did on shared repositories, under no name.
          </p>
        </>
      }
      name={login}
      verb="Delete my account"
      run={async (say) => {
        const { error } = await authClient.deleteUser({ callbackURL: "/" });
        if (!error) return window.location.assign("/");
        // Better Auth deletes only from a session younger than a day: sign in again, then delete.
        if (error.code === "SESSION_EXPIRED" || error.code === "SESSION_IS_NOT_FRESH")
          return say(
            <span className="flex flex-col items-start gap-2">
              Sign in again to confirm it's you, then delete.
              <SignInButton next="/app/settings/account" label="Sign in again" size="sm" />
            </span>,
          );
        say(error.message ?? "Teire couldn't delete the account; try again");
      }}
    />
  );
}

export function Uninstall({ installationId, login }: { installationId: number; login: string }) {
  const router = useRouter();
  return (
    <Confirm
      trigger={
        <Button variant="ghost" size="sm" className="text-ink-2">
          <Unplug data-icon="inline-start" aria-hidden />
          Uninstall
        </Button>
      }
      title={`Uninstall Teire from ${login}?`}
      body={
        <p>
          Teire loses access to every repository of {login}, its runs stop and its data is removed. Its open
          pull requests stay on GitHub. Only {login}
          {"'s"} owner or an organization admin can.
        </p>
      }
      name={login}
      verb="Uninstall"
      run={async (say) => {
        const end = await followAction(
          {
            kind: "uninstall",
            params: { account: login },
            installationId,
            key: `uninstall:${installationId}:${Date.now()}`,
          },
          (s: ActionState | { error: string }) =>
            say("error" in s ? s.error : (s.result ?? `${s.status[0]?.toUpperCase()}${s.status.slice(1)}…`)),
        );
        if (!("error" in end) && end.status === "done") router.refresh();
      }}
    />
  );
}

export function RemoveRepository({ repo }: { repo: string }) {
  const router = useRouter();
  return (
    <Confirm
      trigger={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remove Teire from this repository"
          title="Remove Teire"
        >
          <Unplug aria-hidden />
        </Button>
      }
      title={`Remove Teire from ${repo}?`}
      body={
        <p>
          Teire loses access to {repo} on GitHub and stops there; its other repositories carry on. Add it back
          from the installation on GitHub. Only an admin of {repo} can.
        </p>
      }
      name={repo.split("/")[1]}
      verb="Remove"
      run={async (say) => {
        const out = await removeRepositoryAccess(repo);
        if ("error" in out)
          return say(
            <span className="flex flex-col items-start gap-1.5">
              {out.error}
              {out.manage ? (
                <a href={out.manage} className="inline-flex items-center gap-1 text-link hover:underline">
                  Open the installation on GitHub <ExternalLink className="size-3" />
                </a>
              ) : null}
            </span>,
          );
        say("Removed on GitHub. Teire stops here as soon as GitHub tells it, within seconds.");
        setTimeout(() => router.refresh(), 4000);
      }}
    />
  );
}
