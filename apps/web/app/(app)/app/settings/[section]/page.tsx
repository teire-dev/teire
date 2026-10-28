import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { BulkFixMode } from "@/components/app/bulk-fix-mode";
import { ConfigPrForm } from "@/components/app/config-pr-form";
import { FixModeControl } from "@/components/app/fix-mode-control";
import { InstallationFixMode } from "@/components/app/installation-fix-mode";
import { RefreshInstallations } from "@/components/app/refresh-installations";
import { GithubMark } from "@/components/icons";
import { Kpi } from "@/components/teire/kpi";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { myScope } from "@/lib/app-shell";
import { myInstallations } from "@/lib/dashboard";
import { getSession } from "@/lib/session";
import { APP_SLUG, INSTALL_URL } from "@/lib/site";
import { reposOf, usageOf } from "@/lib/workspace";
import { InstallCard, SignInCard } from "../../gate";

const SECTIONS = ["organization", "repositories", "installations", "usage"] as const;
type Section = (typeof SECTIONS)[number];

export async function generateMetadata({ params }: PageProps<"/app/settings/[section]">) {
  const { section } = await params;
  return { title: `Settings · ${section.replace(/^./, (c) => c.toUpperCase())}` };
}

export default function SettingsSectionPage(props: PageProps<"/app/settings/[section]">) {
  return (
    <Suspense fallback={<div className="h-72 animate-pulse rounded-xl bg-sheet shadow-card" />}>
      <Body {...props} />
    </Suspense>
  );
}

/** A section: its title, a one-line subtitle, then its content (Factory's settings grammar). */
function Part({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-medium text-ink">{title}</h2>
        <p className="text-sm text-ink-3">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

async function Body({ params }: PageProps<"/app/settings/[section]">) {
  await connection();
  const [{ section }, session] = await Promise.all([params, getSession()]);
  if (!SECTIONS.includes(section as Section)) notFound();
  if (!session) return <SignInCard next={`/app/settings/${section}`} />;
  if (section === "installations") return <Installations userId={session.user.id} />;
  const mine = await myScope(session.user.id);
  if (!mine) return <InstallCard />;
  const inst = mine.installation;
  switch (section as Section) {
    case "organization": {
      const rows = await reposOf(mine.scope);
      const config = rows.find(
        (r) => r.fullName.toLowerCase() === `${inst.login}/teire-config`.toLowerCase(),
      );
      return (
        <div className="flex flex-col gap-8">
          <Part
            title="Default fix mode"
            subtitle={`What every repository of ${inst.login} follows unless its own setting or teire.yml says otherwise. Only an admin of ${inst.login} (or the account's owner) can change it; Teire checks on GitHub.`}
          >
            <div className="rounded-xl bg-sheet p-4 shadow-card">
              <InstallationFixMode
                installationId={inst.id}
                mode={inst.defaultFixMode}
                security={inst.securityFixMode}
              />
            </div>
          </Part>
          <Part
            title="Organisation defaults"
            subtitle={`Majors, plain bumps, PR limits and the schedule for every repository live in ${inst.login}/teire-config, changed through a pull request there.`}
          >
            {config ? (
              <div className="flex flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card">
                <span className="text-sm text-ink-2">
                  <Link
                    href={`/app/repos/${config.fullName}/config`}
                    className="font-mono text-ink hover:underline"
                  >
                    {config.fullName}
                  </Link>{" "}
                  holds them; each repository&apos;s Config tab shows which values came from it.
                </span>
                <ConfigPrForm repo={config.fullName} />
              </div>
            ) : (
              <p className="rounded-xl bg-sheet p-4 text-sm text-ink-3 shadow-card">
                No <span className="font-mono">{inst.login}/teire-config</span> repository Teire can read yet.
                Create one with a <span className="font-mono">teire.yml</span> at its root and include it in
                the installation to set defaults for every repository;{" "}
                <a href="/docs/guide/configuration" className="text-link hover:underline">
                  how
                </a>
                .
              </p>
            )}
          </Part>
        </div>
      );
    }
    case "repositories": {
      const rows = await reposOf(mine.scope);
      return (
        <Part
          title="Fix mode per repository"
          subtitle="Each repository's mode and where it was set; a teire.yml that sets it wins and locks the control."
        >
          <div className="flex justify-end">
            <BulkFixMode repos={rows.map((r) => r.fullName)} />
          </div>
          <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                <Link
                  href={`/app/repos/${r.fullName}`}
                  className="min-w-0 truncate font-mono text-xs text-ink hover:underline"
                >
                  {r.fullName}
                </Link>
                <FixModeControl
                  repo={r.fullName}
                  mode={r.fixMode.mode}
                  origin={r.fixMode.origin}
                  file={r.fixMode.file}
                />
              </li>
            ))}
          </ul>
        </Part>
      );
    }
    case "usage": {
      const u = await usageOf(mine.scope);
      const cost = u.byPurpose.reduce((n, p) => n + p.costUsd, 0);
      return (
        <Part
          title="Usage"
          subtitle={`The last 30 days across ${inst.login}'s repositories; every figure comes from the runs' own receipts.`}
        >
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-rule shadow-card md:grid-cols-3">
            <Kpi label="Runs" value={u.runs} />
            <Kpi label="Sandbox time (min)" value={Math.round(u.sandboxMs / 60_000)} />
            {/* Dollars and cents: the count-up shows whole numbers only. */}
            <div className="flex min-w-0 flex-col justify-between gap-3 bg-sheet p-4">
              <span className="eyebrow">Model spend</span>
              <span className="font-mono text-4xl leading-none font-medium tracking-tight text-ink tabular-nums">
                ${cost.toFixed(2)}
              </span>
            </div>
          </div>
          {u.byPurpose.length ? (
            <div className="overflow-hidden rounded-xl bg-sheet shadow-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-rule text-left">
                    {["Purpose", "Calls", "Tokens", "Cost"].map((h) => (
                      <th key={h} scope="col" className="eyebrow px-4 py-2 font-normal">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule font-mono text-xs">
                  {u.byPurpose.map((p) => (
                    <tr key={p.purpose}>
                      <td className="px-4 py-2 text-ink">{p.purpose}</td>
                      <td className="px-4 py-2 tabular-nums text-ink-2">{p.calls.toLocaleString()}</td>
                      <td className="px-4 py-2 tabular-nums text-ink-2">{p.tokens.toLocaleString()}</td>
                      <td className="px-4 py-2 tabular-nums text-ink">${p.costUsd.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-xl bg-sheet p-4 text-sm text-ink-3 shadow-card">
              No model call in the last 30 days.
            </p>
          )}
        </Part>
      );
    }
    default:
      notFound();
  }
}

async function Installations({ userId }: { userId: string }) {
  const installs = await myInstallations(userId);
  return (
    <Part
      title="Installations"
      subtitle="Where Teire is installed that GitHub says you can see. Repository access is changed on GitHub."
    >
      {installs.length ? (
        <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
          {installs.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span className="flex items-center gap-3">
                <Avatar className="size-7">
                  {i.avatarUrl ? <AvatarImage src={i.avatarUrl} alt="" /> : null}
                  <AvatarFallback className="text-xs">{i.login.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="text-sm">
                  <span className="font-medium text-ink">{i.login}</span>
                  <span className="text-ink-3">
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
        <div className="flex flex-col items-start gap-3 rounded-xl bg-sheet p-5 shadow-card">
          <p className="text-sm text-ink-3">No installation you can see yet.</p>
          <Button asChild shape="pill">
            <a href={INSTALL_URL}>
              <GithubMark className="size-4" />
              Install on GitHub
            </a>
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-3">
        <RefreshInstallations />
        <span>
          The list comes from GitHub. Installed somewhere new? Refresh.{" "}
          <a href={`https://github.com/apps/${APP_SLUG}`} className="text-link hover:underline">
            The app on GitHub
          </a>
          .
        </span>
      </div>
    </Part>
  );
}
