"use client";

import { KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { ActionState } from "@/app/(app)/app/actions";
import { followAction } from "@/components/app/follow-action";
import { Mark } from "@/components/teire/mark";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ECOSYSTEMS } from "@/lib/brands";
import type { RegistryRow } from "@/lib/registries";

type Ecosystem = RegistryRow["ecosystem"];
const ECOSYSTEM_KEYS: Ecosystem[] = ["npm", "pypi", "maven", "cargo", "rubygems", "go"];
const brandOf = (e: Ecosystem) =>
  ECOSYSTEMS[e] ?? { label: e, light: "/logos/provider.svg", dark: "/logos/provider.svg" };

/** What each registry's credential is usually called, so the field asks for the right thing. */
const SECRET_LABEL: Record<Ecosystem, string> = {
  npm: "Token (an npm or GitHub Packages token)",
  pypi: "Password or API token",
  maven: "Password or token",
  cargo: "Token",
  rubygems: "Password or API key",
  go: "Password or token for the module proxy",
};

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};

/** The worker's answer in place: its result, or why it refused. */
function said(state: ActionState | { error: string } | null) {
  if (!state) return null;
  if ("error" in state) return state.error;
  if (state.status === "refused" || state.status === "failed") return state.result ?? "Refused";
  return state.result ?? "Checking…";
}

/** Add or replace a credential: token, or username and password; sealed on the server, never shown again. */
function CredentialDialog({
  installationId,
  row,
  trigger,
}: {
  installationId: number;
  /** The registry, or null to name one no scan found yet. */
  row: Pick<RegistryRow, "ecosystem" | "host" | "url"> | null;
  trigger: React.ReactNode;
}) {
  const router = useRouter();
  const ids = { host: useId(), url: useId(), user: useId(), secret: useId() };
  const [open, setOpen] = useState(false);
  const [ecosystem, setEcosystem] = useState<Ecosystem>(row?.ecosystem ?? "npm");
  const [host, setHost] = useState(row?.host ?? "");
  // A URL the repo wrote with a token in it is shown redacted; the full one is asked for.
  const redacted = !!row?.url?.includes("***");
  const [url, setUrl] = useState(redacted ? "" : (row?.url ?? ""));
  const [kind, setKind] = useState<"token" | "basic">(row?.ecosystem === "maven" ? "basic" : "token");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [state, setState] = useState<ActionState | { error: string } | null>(null);
  const busy = state !== null && !("error" in state) && !["done", "refused", "failed"].includes(state.status);
  const ready = host.trim() && secret.trim() && (kind === "token" || username.trim());
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setSecret("");
          setState(null);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row ? `Credential for ${row.host}` : "Add a private registry"}</DialogTitle>
          <DialogDescription>
            Sealed on the server for Teire's worker alone. Teire sends it to this host for installs, version
            lookups and Dependabot's jobs, never to a repository's code, and never shows it again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-[13px] text-ink-2">
          {row ? null : (
            <div className="grid grid-cols-[8rem_1fr] gap-2">
              <Select value={ecosystem} onValueChange={(v) => setEcosystem(v as Ecosystem)}>
                <SelectTrigger aria-label="Ecosystem">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ECOSYSTEM_KEYS.map((e) => (
                    <SelectItem key={e} value={e}>
                      {brandOf(e).label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id={ids.host}
                aria-label="Registry host"
                placeholder="npm.pkg.github.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}
          {row && !redacted ? null : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.url}>
                {redacted
                  ? `Registry URL: the repository's has a token in it (${row?.url}), so enter the full one`
                  : "Registry URL, if it has a path (optional)"}
              </label>
              <Input
                id={ids.url}
                placeholder="https://pkgs.dev.azure.com/acme/_packaging/feed/npm/registry"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}
          <ToggleGroup
            type="single"
            variant="outline"
            value={kind}
            onValueChange={(v) => v && setKind(v as "token" | "basic")}
            className="w-fit"
          >
            <ToggleGroupItem value="token">Token</ToggleGroupItem>
            <ToggleGroupItem value="basic">Username and password</ToggleGroupItem>
          </ToggleGroup>
          {kind === "basic" ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.user}>Username</label>
              <Input
                id={ids.user}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.secret}>
              {kind === "basic" ? "Password" : SECRET_LABEL[row?.ecosystem ?? ecosystem]}
            </label>
            <Input
              id={ids.secret}
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
            />
          </div>
        </div>
        {said(state) ? (
          <div className="rounded-card bg-sunken px-3 py-2 text-[13px] text-ink">{said(state)}</div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {state && !("error" in state) && state.status === "done" ? "Close" : "Cancel"}
          </Button>
          <Button
            disabled={!ready || busy}
            onClick={async () => {
              setState(null);
              const final = await followAction(
                {
                  kind: "set-registry-credential",
                  params: {
                    ecosystem: row?.ecosystem ?? ecosystem,
                    host: (row?.host ?? host).trim().toLowerCase(),
                    url: (redacted || !row ? url.trim() : row.url) || null,
                    kind,
                    username: kind === "basic" ? username.trim() : null,
                    secret,
                  },
                  installationId,
                  key: `web:registry:${crypto.randomUUID()}`,
                },
                setState,
              );
              if (!("error" in final) && final.status === "done") {
                setSecret("");
                router.refresh();
              }
            }}
          >
            <KeyRound data-icon="inline-start" aria-hidden />
            {busy ? "Saving…" : "Save credential"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveCredential({ installationId, row }: { installationId: number; row: RegistryRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ActionState | { error: string } | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setState(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Remove the credential for ${row.host}`}>
          <Trash2 aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove the credential for {row.host}?</DialogTitle>
          <DialogDescription>
            Teire stops sending it. Repositories that install from {row.host} can't be verified or upgraded
            until a new one is saved.
          </DialogDescription>
        </DialogHeader>
        {said(state) ? (
          <div className="rounded-card bg-sunken px-3 py-2 text-[13px] text-ink">{said(state)}</div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              const final = await followAction(
                {
                  kind: "remove-registry-credential",
                  params: { ecosystem: row.ecosystem, host: row.host },
                  installationId,
                  key: `web:registry:${crypto.randomUUID()}`,
                },
                setState,
              );
              if (!("error" in final) && final.status === "done") {
                setOpen(false);
                router.refresh();
              }
            }}
          >
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings → Private registries (S18.7): every registry this installation's repositories install
 * from, where each is named, and its credential: saved (with when it was last used) or missing.
 */
export function RegistryCredentials({
  installationId,
  rows,
  goPrivate,
}: {
  installationId: number;
  rows: RegistryRow[];
  goPrivate: string[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {rows.length ? (
        <ul className="flex flex-col divide-y divide-rule rounded-xl bg-sheet shadow-card">
          {rows.map((row) => (
            <li key={`${row.ecosystem}|${row.host}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Mark brand={brandOf(row.ecosystem)} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-[13px] text-ink">{row.host}</span>
                  {row.scopes.map((s) => (
                    <span
                      key={s}
                      className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[11px] text-ink-3"
                    >
                      {s}
                    </span>
                  ))}
                </div>
                <span className="truncate text-[12px] text-ink-3">
                  {row.namedIn.length
                    ? `${row.namedIn
                        .slice(0, 2)
                        .map((n) => `${n.repo} · ${n.file}`)
                        .join(", ")}${row.namedIn.length > 2 ? ` and ${row.namedIn.length - 2} more` : ""}`
                    : "No repository names it in its latest scan"}
                </span>
              </div>
              {row.credential ? (
                <span className="flex items-center gap-1.5 text-[12px] text-ink-2">
                  <ShieldCheck className="size-3.5 text-proven" aria-hidden />
                  {row.credential.kind === "basic" ? `${row.credential.username} · password` : "Token"} ·
                  saved {ago(row.credential.updatedAt)}
                  {row.credential.lastUsedAt
                    ? ` · used ${ago(row.credential.lastUsedAt)}`
                    : " · not used yet"}
                </span>
              ) : (
                <span className="text-[12px] text-attention">Needs a credential</span>
              )}
              <div className="flex items-center gap-1">
                <CredentialDialog
                  installationId={installationId}
                  row={row}
                  trigger={
                    <Button variant={row.credential ? "outline" : "default"} size="sm">
                      {row.credential ? "Replace" : "Add credential"}
                    </Button>
                  }
                />
                {row.credential ? <RemoveCredential installationId={installationId} row={row} /> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl bg-sheet px-4 py-4 text-[13px] text-ink-2 shadow-card">
          No repository here installs from a private registry: every package comes from its public registry.
        </div>
      )}
      {goPrivate.length ? (
        <p className="text-[12px] text-ink-3">
          Go modules marked private in CI: <span className="font-mono">{goPrivate.join(", ")}</span>. Add a
          credential for the module proxy your GOPROXY names to read them.
        </p>
      ) : null}
      <CredentialDialog
        installationId={installationId}
        row={null}
        trigger={
          <Button variant="outline" size="sm" className="w-fit">
            <Plus data-icon="inline-start" aria-hidden />
            Add a registry
          </Button>
        }
      />
    </div>
  );
}
