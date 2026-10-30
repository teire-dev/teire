import { CONFIG_PR_KEYS } from "@teire/engine/config-keys";
import { ExternalLink, MessageCircleQuestion, Plus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import {
  DeleteAccount,
  RevokeGitHubAccess,
  SignOutEverywhere,
  Uninstall,
} from "@/components/app/access-controls";
import { BulkFixMode } from "@/components/app/bulk-fix-mode";
import { ConfigBoard } from "@/components/app/config-board";
import { ConfigPrForm } from "@/components/app/config-pr-form";
import { FixModeControl } from "@/components/app/fix-mode-control";
import { InstallationFixMode } from "@/components/app/installation-fix-mode";
import { RefreshInstallations } from "@/components/app/refresh-installations";
import { RegistryCredentials } from "@/components/app/registry-credentials";
import { TileSquare } from "@/components/flow/tile";
import { GithubMark } from "@/components/icons";
import { MarkStack } from "@/components/teire/mark";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { StackedActivityBars } from "@/components/ui/stacked-activity";
import { myScope } from "@/lib/app-shell";
import { assistantSpend } from "@/lib/assistant/budget";
import { githubLogin } from "@/lib/auth";
import { myInstallations } from "@/lib/dashboard";
import { configCurrent } from "@/lib/fix-mode";
import { languageMarks } from "@/lib/marks";
import { credentialsReady, registriesOf } from "@/lib/registries";
import { getSession } from "@/lib/session";
import { ADD_ACCOUNT_URL, APP_SLUG, INSTALL_URL } from "@/lib/site";
import { reposOf, usageDaily, usageOf } from "@/lib/workspace";
import { InstallCard, SignInCard } from "../../gate";

const SECTIONS = ["organization", "repositories", "installations", "registries", "usage", "account"] as const;
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

/** A section: its title and, when it needs one, a chip of what it is about; then its content. */
function Part({
  title,
  chip,
  children,
}: {
  title: string;
  chip?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium text-ink">{title}</h2>
        {chip}
      </div>
      {children}
    </section>
  );
}

const Chip = ({ children }: { children: React.ReactNode }) => (
  <span className="rounded-full bg-sunken px-2.5 py-0.5 font-mono text-[11px] text-ink-3">{children}</span>
);

/** What each model call was for, in a legend's words. */
const PURPOSE: Record<string, string> = {
  fix: "Fixes",
  notes: "Release notes",
  triage: "Triage",
  review: "Review",
  "provider-page": "Provider pages",
};
const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

async function Body({ params }: PageProps<"/app/settings/[section]">) {
  await connection();
  const [{ section }, session] = await Promise.all([params, getSession()]);
  if (!SECTIONS.includes(section as Section)) notFound();
  if (!session) return <SignInCard next={`/app/settings/${section}`} />;
  if (section === "installations") return <Installations userId={session.user.id} />;
  if (section === "account")
    return <Account userId={session.user.id} name={session.user.name} image={session.user.image ?? null} />;
  const mine = await myScope(session.user.id);
  if (!mine) return <InstallCard />;
  const inst = mine.installation;
  switch (section as Section) {
    case "registries": {
      if (!credentialsReady())
        return (
          <Part title="Private registries">
            <div className="rounded-xl bg-sheet px-4 py-4 text-[13px] text-ink-2 shadow-card">
              Private registries aren't set up on this Teire deployment yet: its credential sealing key isn't
              configured, so no credential can be saved.
            </div>
          </Part>
        );
      const { rows, goPrivate } = await registriesOf({ ...mine.scope, installationId: inst.id });
      return (
        <Part title="Private registries" chip={<Chip>{inst.login} admins only</Chip>}>
          <RegistryCredentials installationId={inst.id} rows={rows} goPrivate={goPrivate} />
        </Part>
      );
    }
    case "organization": {
      const rows = await reposOf(mine.scope);
      const config = rows.find(
        (r) => r.fullName.toLowerCase() === `${inst.login}/teire-config`.toLowerCase(),
      );
      return (
        <div className="flex flex-col gap-8">
          <Part title="Default fix mode" chip={<Chip>{inst.login} admins only</Chip>}>
            <InstallationFixMode
              installationId={inst.id}
              mode={inst.defaultFixMode}
              security={inst.securityFixMode}
            />
          </Part>
          <Part
            title="Organisation defaults"
            chip={
              config ? (
                <Link href={`/app/repos/${config.fullName}/config`} className="hover:opacity-80">
                  <Chip>{config.fullName}</Chip>
                </Link>
              ) : null
            }
          >
            {config ? (
              <div className="flex flex-col gap-4">
                <div className="rounded-xl bg-sheet p-4 shadow-card">
                  <ConfigPrForm
                    repo={config.fullName}
                    current={configCurrent(config.config, Object.keys(CONFIG_PR_KEYS))}
                  />
                </div>
                {config.config ? (
                  <ConfigBoard
                    config={config.config as Record<string, unknown>}
                    base={`/app/repos/${config.fullName}/config`}
                  />
                ) : null}
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
                <TileSquare tile={{ entity: "repository", state: "pending", label: "" }} size="sm" />
                <span className="text-sm text-ink-2">
                  No <span className="font-mono">{inst.login}/teire-config</span> yet
                </span>
                <Button asChild size="sm" variant="ghost" className="ml-auto">
                  <a href="/docs/guide/configuration">How ›</a>
                </Button>
              </div>
            )}
          </Part>
        </div>
      );
    }
    case "repositories": {
      const rows = await reposOf(mine.scope);
      return (
        <Part title="Fix mode per repository" chip={<BulkFixMode repos={rows.map((r) => r.fullName)} />}>
          <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
                <Link
                  href={`/app/repos/${r.fullName}`}
                  className="flex min-w-0 items-center gap-2.5 hover:underline"
                >
                  <MarkStack brands={languageMarks(r.languages)} max={2} />
                  <span className="truncate text-sm font-medium text-ink">{r.fullName.split("/")[1]}</span>
                </Link>
                <FixModeControl
                  repo={r.fullName}
                  mode={r.fixMode.mode}
                  origin={r.fixMode.origin}
                  file={r.fixMode.file}
                  compact
                />
              </li>
            ))}
          </ul>
        </Part>
      );
    }
    case "usage": {
      const [u, daily, mineAsked] = await Promise.all([
        usageOf(mine.scope),
        usageDaily(mine.scope, 30),
        assistantSpend(session.user.id),
      ]);
      const cost = u.byPurpose.reduce((n, p) => n + p.costUsd, 0);
      const order = [...daily.purposes].sort(
        (a, b) =>
          daily.series.reduce((n, d) => n + (d[b] ?? 0), 0) -
          daily.series.reduce((n, d) => n + (d[a] ?? 0), 0),
      );
      const share = mineAsked.dailyCapUsd ? Math.min(1, mineAsked.todayUsd / mineAsked.dailyCapUsd) : 0;
      return (
        <Part title="Usage" chip={<Chip>last 30 days · from the receipts</Chip>}>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Runs", value: u.runs.toLocaleString() },
              { label: "Sandbox minutes", value: Math.round(u.sandboxMs / 60_000).toLocaleString() },
              { label: "Model spend", value: `$${cost.toFixed(2)}` },
            ].map((f) => (
              <div key={f.label} className="flex flex-col gap-2 rounded-xl bg-sheet p-4 shadow-card">
                <span className="text-[13px] text-ink-2">{f.label}</span>
                <span className="font-mono text-[1.75rem] leading-none font-medium tracking-tight text-ink tabular-nums">
                  {f.value}
                </span>
              </div>
            ))}
          </div>
          {order.length ? (
            <div className="rounded-xl bg-sheet p-4 shadow-card">
              <StackedActivityBars
                days={daily.series.map((d) => d.day)}
                segments={order.slice(0, SERIES.length).map((p, i) => ({
                  key: p,
                  label: PURPOSE[p] ?? p,
                  color: SERIES[i] as string,
                  values: daily.series.map((d) => d[p] ?? 0),
                }))}
                prefix="$"
                partialLast
                partialNote="today"
              />
            </div>
          ) : null}
          {u.byPurpose.length ? (
            <div className="overflow-hidden rounded-xl bg-sheet shadow-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-rule text-left">
                    {["Purpose", "Calls", "Tokens", "Cost"].map((h) => (
                      <th key={h} scope="col" className="px-4 py-2 text-xs font-normal text-ink-3">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule font-mono text-xs">
                  {u.byPurpose.map((p) => (
                    <tr key={p.purpose}>
                      <td className="px-4 py-2 font-sans text-ink">{PURPOSE[p.purpose] ?? p.purpose}</td>
                      <td className="px-4 py-2 text-ink-2 tabular-nums">{p.calls.toLocaleString()}</td>
                      <td className="px-4 py-2 text-ink-2 tabular-nums">{p.tokens.toLocaleString()}</td>
                      <td className="px-4 py-2 text-ink tabular-nums">${p.costUsd.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {/* Ask Teire has its own budget, apart from fix runs (D127): chatting never stops a fix. */}
          <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-3 shadow-card">
            <MessageCircleQuestion className="size-4 shrink-0 text-ink-2" aria-hidden />
            <span className="text-sm text-ink-2">Ask Teire today</span>
            <span className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-sunken" aria-hidden>
              <span
                className="block h-full rounded-full bg-signal"
                style={{ width: `${Math.round(share * 100)}%` }}
              />
            </span>
            <span className="font-mono text-xs text-ink tabular-nums">
              ${mineAsked.todayUsd.toFixed(3)} / ${mineAsked.dailyCapUsd.toFixed(2)}
            </span>
          </div>
        </Part>
      );
    }
    default:
      notFound();
  }
}

/**
 * Who is signed in, and every way to take Teire's access away (the account owner's own controls):
 * sign out here or everywhere, revoke Teire's GitHub authorization, or delete the Teire account.
 */
async function Account({ userId, name, image }: { userId: string; name: string; image: string | null }) {
  const login = await githubLogin(userId);
  return (
    <div className="flex flex-col gap-8">
      <Part title="Signed in">
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-sheet p-4 shadow-card">
          <Avatar className="size-10">
            {image ? <AvatarImage src={image} alt="" /> : null}
            <AvatarFallback className="text-xs">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-ink">{name}</span>
            <span className="flex items-center gap-1 font-mono text-[11px] text-ink-3">
              <GithubMark className="size-3" />
              {login ?? "GitHub didn't answer"}
            </span>
          </span>
          <span className="ml-auto flex flex-wrap gap-2">
            <SignOutEverywhere />
          </span>
        </div>
      </Part>
      <Part title="GitHub access">
        <div className="flex flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card">
          <p className="text-sm text-ink-2">
            Teire reads which repositories you can see with an authorization you gave GitHub. Its access to
            your repositories is the app's installation:{" "}
            <Link href="/app/settings/installations" className="text-link hover:underline">
              uninstall it
            </Link>{" "}
            or remove a repository from its page.
          </p>
          <span>
            <RevokeGitHubAccess />
          </span>
        </div>
      </Part>
      <Part title="Delete your Teire account">
        <div className="flex flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card">
          <p className="text-sm text-ink-2">
            Your sign-in, GitHub access, Ask Teire threads and what Teire knew you could see. Installations
            keep running until you uninstall them.
          </p>
          <span>
            {login ? (
              <DeleteAccount login={login} />
            ) : (
              <span className="text-sm text-ink-3">Sign in again to delete your account.</span>
            )}
          </span>
        </div>
      </Part>
    </div>
  );
}

async function Installations({ userId }: { userId: string }) {
  const installs = await myInstallations(userId);
  return (
    <Part title="Installations" chip={<RefreshInstallations />}>
      {installs.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {installs.map((i) => (
            <li key={i.id} className="flex flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card">
              <span className="flex items-center gap-3">
                <Avatar className="size-10 rounded-[10px]">
                  {i.avatarUrl ? <AvatarImage src={i.avatarUrl} alt="" /> : null}
                  <AvatarFallback className="text-xs">{i.login.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-ink">{i.login}</span>
                  <span className="font-mono text-[11px] text-ink-3">
                    {i.type === "Organization" ? "organisation" : "personal"} ·{" "}
                    {i.selection === "all" ? "all repos" : "selected repos"}
                  </span>
                </span>
                {i.suspendedAt ? (
                  <span className="ml-auto rounded-full bg-attention-soft px-2 py-0.5 font-mono text-[11px] text-attention">
                    suspended
                  </span>
                ) : null}
              </span>
              <span className="flex items-center justify-between gap-2 border-t border-rule pt-2">
                <a
                  href={
                    i.type === "Organization"
                      ? `https://github.com/organizations/${i.login}/settings/installations/${i.id}`
                      : `https://github.com/settings/installations/${i.id}`
                  }
                  className="flex items-center gap-1.5 text-xs text-ink-2 hover:text-ink"
                >
                  <GithubMark className="size-3.5" />
                  Repository access <ExternalLink className="size-3" aria-hidden />
                </a>
                <Uninstall installationId={i.id} login={i.login} />
              </span>
            </li>
          ))}
          <li>
            <a
              href={ADD_ACCOUNT_URL}
              className="flex h-full min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-rule-strong text-sm text-ink-2 hover:bg-hover hover:text-ink"
            >
              <Plus className="size-4" aria-hidden />
              Another account
            </a>
          </li>
        </ul>
      ) : (
        <div className="flex items-center gap-3 rounded-xl bg-sheet px-4 py-4 shadow-card">
          <TileSquare tile={{ entity: "repository", state: "pending", label: "" }} size="sm" />
          <span className="text-sm text-ink-2">No installation you can see yet</span>
          <Button asChild shape="pill" size="sm" className="ml-auto">
            <a href={INSTALL_URL}>
              <GithubMark className="size-4" />
              Install on GitHub
            </a>
          </Button>
        </div>
      )}
      <a
        href={`https://github.com/apps/${APP_SLUG}`}
        className="w-fit font-mono text-[11px] text-ink-3 hover:text-ink"
      >
        github.com/apps/{APP_SLUG}
      </a>
    </Part>
  );
}
