import { ExternalLink } from "lucide-react";
import { Suspense } from "react";
import { GithubMark } from "@/components/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { myInstallations, usage } from "@/lib/dashboard";
import { getSession } from "@/lib/session";
import { APP_SLUG, INSTALL_URL } from "@/lib/site";
import { SignInCard } from "../gate";
import { SubNav } from "../sub-nav";

export const metadata = { title: "Settings" };

/** Installations, where repository access is changed (GitHub), where config lives, and usage (C8, C12). */
export default function SettingsPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-10">
      <SubNav />
      <Suspense fallback={<div className="h-80 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <Settings />
      </Suspense>
    </main>
  );
}

async function Settings() {
  const session = await getSession();
  if (!session) return <SignInCard next="/app/settings" />;
  const [installs, totals] = await Promise.all([myInstallations(session.user.id), usage(session.user.id)]);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Installations</h2>
        {installs.length ? (
          <ul className="divide-y overflow-hidden rounded-lg bg-card shadow-card">
            {installs.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="flex items-center gap-3">
                  <Avatar className="size-7">
                    {i.avatarUrl ? <AvatarImage src={i.avatarUrl} alt="" /> : null}
                    <AvatarFallback className="text-xs">{i.login.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="text-sm">
                    <span className="font-medium">{i.login}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {i.type === "Organization" ? "organisation" : "personal"} ·{" "}
                      {i.selection === "all" ? "all repositories" : "selected repositories"}
                      {i.suspendedAt ? " · suspended" : ""}
                    </span>
                  </span>
                </span>
                <a
                  href={
                    i.type === "Organization"
                      ? `https://github.com/organizations/${i.login}/settings/installations/${i.id}`
                      : `https://github.com/settings/installations/${i.id}`
                  }
                  className="flex items-center gap-1 text-sm text-link hover:underline"
                >
                  Change repository access on GitHub <ExternalLink className="size-3" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-start gap-3 rounded-lg bg-card p-5 shadow-card">
            <p className="text-sm text-muted-foreground">No installation you can see yet.</p>
            <Button asChild shape="pill">
              <a href={INSTALL_URL}>
                <GithubMark className="size-4" />
                Install on GitHub
              </a>
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          The list comes from GitHub when you sign in. Installed somewhere new? Sign out and in again.{" "}
          <a href={`https://github.com/apps/${APP_SLUG}`} className="text-link hover:underline">
            The app on GitHub
          </a>
          .
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Configuration</h2>
        <div className="rounded-lg bg-card p-5 text-sm text-muted-foreground shadow-card">
          Teire keeps no settings of its own: each repository&apos;s{" "}
          <span className="font-mono">.github/teire.yml</span>, or an organisation&apos;s{" "}
          <span className="font-mono">teire-config</span> repository, decides what it upgrades, how many PRs
          it opens and which checks it runs. Editors validate it against the{" "}
          <a href="/schema.json" className="text-link hover:underline">
            JSON schema
          </a>
          , and each repository&apos;s Config tab shows where every value came from.
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Usage across your repositories</h2>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border shadow-card md:grid-cols-4">
          {[
            ["Runs", totals.runs.toLocaleString()],
            ["Model tokens", totals.tokens.toLocaleString()],
            ["Model cost", `$${totals.costUsd.toFixed(2)}`],
            ["Sandbox time", `${Math.round(totals.sandboxMs / 60_000)} min`],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 bg-card p-5">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-mono text-lg tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
