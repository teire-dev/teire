"use client";

import { ArrowLeft, Check, ExternalLink, Loader, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { followAction } from "@/components/app/follow-action";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { WelcomeData } from "@/lib/welcome";

/**
 * The welcome flow (plan revision 3.3, U5, Factory's onboarding grammar): a four-segment progress bar,
 * a mono-uppercase question per step, Back and Continue (Enter continues). The steps unlock in order
 * and the flow resumes where the person left it.
 *   1 Installed: which account, which repositories (change them on GitHub)
 *   2 First scans: live, per repository, with what each found (a failed one can be retried)
 *   3 How Teire should fix: Automatic (recommended), Ask first, Off; the mode each repository gets
 *   4 Turn it on: Activate closes the onboarding PRs with a comment; or keep them
 */
type Data = Extract<WelcomeData, { state: "ok" }>;
type Repo = Data["repos"][number];
type Result = { status: string; result: string | null } | { error: string };

const STEPS = ["Installed", "First scans", "How Teire fixes", "Turn it on"] as const;

const MODES = [
  {
    key: "auto",
    name: "Automatic",
    said: "Teire starts a fix for every change that reaches your code and opens the pull request with its evidence.",
    note: "Recommended",
  },
  {
    key: "ask",
    name: "Ask first",
    said: "Teire lists what it found and waits: nothing new starts until you click Fix now or comment @teire fix.",
  },
  {
    key: "off",
    name: "Off",
    said: "Teire lists what it finds and never starts a fix. You can turn it on per repository later.",
  },
] as const;

const keyOf = (s: string) => `welcome:${s}:${Math.floor(Date.now() / 60_000)}`;

export function WelcomeFlow({ data, updated }: { data: Data; updated: boolean }) {
  const router = useRouter();
  const store = `teire-welcome-${data.installation.id}`;
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"auto" | "ask" | "off">(data.installation.defaultFixMode ?? "auto");
  const [security, setSecurity] = useState<"auto" | "ask">(data.installation.securityFixMode ?? "auto");
  const [modeResult, setModeResult] = useState<Result | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(data.repos.filter((r) => r.status !== "active").map((r) => r.fullName)),
  );
  const [results, setResults] = useState<Record<string, Result>>({});
  const [retried, setRetried] = useState<Record<string, Result>>({});

  // Resume where the person left it.
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(store));
      if (Number.isInteger(saved) && saved > 0 && saved < STEPS.length) setStep(saved);
    } catch {}
  }, [store]);
  useEffect(() => {
    try {
      localStorage.setItem(store, String(step));
    } catch {}
  }, [store, step]);

  // A scan still going after ten minutes finishes in the background; it doesn't hold the flow.
  const scanning = data.repos.filter(
    (r) =>
      (!r.scan || r.scan.status === "queued" || r.scan.status === "running") &&
      Date.now() - Date.parse(r.scan?.at ?? r.createdAt) < 10 * 60_000,
  );
  // While first scans run, the page reads again every four seconds.
  useEffect(() => {
    if (!scanning.length) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [scanning.length, router]);

  const done = useMemo(
    () => [
      true,
      scanning.length === 0,
      !!modeResult && !("error" in modeResult) && modeResult.status !== "refused",
      data.repos.length > 0 &&
        data.repos.every((r) => r.status === "active" || "status" in (results[r.fullName] ?? {})),
    ],
    [scanning.length, modeResult, data.repos, results],
  );
  // A step can be left once it's done; step 3 can also keep the current default.
  const canContinue = step === 2 ? true : (done[step] ?? false);
  const next = useCallback(() => {
    if (step < STEPS.length - 1 && canContinue) setStep(step + 1);
  }, [step, canContinue]);

  // Enter continues (Factory's "[ enter to continue ]"), except while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "Enter" || t?.closest("input, textarea, button, a, [role=checkbox]")) return;
      next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next]);

  const saveMode = async () => {
    setModeResult({ status: "requested", result: null });
    await followAction(
      {
        kind: "set-installation-fix-mode",
        params: { mode, security },
        installationId: data.installation.id,
        key: keyOf(`mode:${data.installation.id}:${mode}:${security}`),
      },
      (s) => setModeResult("error" in s ? s : { status: s.status, result: s.result }),
    );
  };

  const activate = async (keep: boolean) => {
    const names = data.repos
      .filter((r) => chosen.has(r.fullName) && r.status !== "active")
      .map((r) => r.fullName);
    await Promise.all(
      names.map((repo) =>
        followAction(
          { kind: "activate", params: { keep }, repo, key: keyOf(`activate:${repo}:${keep}`) },
          (s) =>
            setResults((r) => ({ ...r, [repo]: "error" in s ? s : { status: s.status, result: s.result } })),
        ),
      ),
    );
    try {
      localStorage.setItem("teire-welcome-done", JSON.stringify({ at: Date.now(), repos: names.length }));
    } catch {}
    router.refresh();
  };

  const retry = (repo: string) =>
    void followAction({ kind: "rescan", params: {}, repo, key: keyOf(`rescan:${repo}`) }, (s) =>
      setRetried((r) => ({ ...r, [repo]: "error" in s ? s : { status: s.status, result: s.result } })),
    ).then(() => router.refresh());

  const QUESTIONS = [
    updated
      ? `Teire's access to ${data.installation.login} changed.`
      : `Teire is installed on ${data.installation.login}.`,
    scanning.length ? "Reading your repositories." : "Here's what Teire found.",
    "How should Teire fix?",
    "Turn Teire on.",
  ];

  return (
    <div className="flex flex-col gap-8">
      {/* The four segments: done in ink, the current one in cobalt, the rest waiting. */}
      <ol className="grid grid-cols-4 gap-2" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className="flex flex-col gap-1.5">
            <span
              className={cn(
                "h-1 rounded-full",
                i < step || (i === step && done[i]) ? "bg-ink" : i === step ? "bg-signal" : "bg-rule-strong",
              )}
            />
            <button
              type="button"
              disabled={i > step && !done.slice(0, i).every(Boolean)}
              onClick={() => setStep(i)}
              className={cn(
                "w-fit text-left font-mono text-[10px] tracking-[0.08em] uppercase disabled:cursor-not-allowed",
                i === step ? "text-ink" : "text-ink-3 hover:text-ink-2 disabled:hover:text-ink-3",
              )}
              aria-current={i === step ? "step" : undefined}
            >
              {String(i + 1).padStart(2, "0")} {label}
            </button>
          </li>
        ))}
      </ol>

      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-2xl font-medium tracking-tight text-ink uppercase sm:text-3xl">
          {QUESTIONS[step]}
        </h1>
        {step === 0 ? (
          <p className="text-ink-2">
            Teire reads each repository you gave it, finds what newer versions, APIs and models change in your
            code, fixes it in a sandbox and opens pull requests with the proof.
          </p>
        ) : null}
      </header>

      {data.installation.suspended ? (
        <p className="rounded-lg bg-attention-soft px-4 py-3 text-sm text-attention">
          This installation is suspended on GitHub: Teire scans nothing and opens nothing until it's
          unsuspended in GitHub's settings.
        </p>
      ) : null}

      {step === 0 ? <Installed data={data} /> : null}
      {step === 1 ? <Scans repos={data.repos} retried={retried} onRetry={retry} /> : null}
      {step === 2 ? (
        <Modes
          repos={data.repos}
          mode={mode}
          setMode={setMode}
          security={security}
          setSecurity={setSecurity}
          result={modeResult}
          onSave={saveMode}
        />
      ) : null}
      {step === 3 ? (
        <Activate
          repos={data.repos}
          chosen={chosen}
          setChosen={setChosen}
          results={results}
          onActivate={activate}
        />
      ) : null}

      <footer className="flex items-center justify-between gap-3 border-t border-rule pt-5">
        {step > 0 ? (
          <Button variant="ghost" onClick={() => setStep(step - 1)}>
            <ArrowLeft data-icon="inline-start" />
            Back
          </Button>
        ) : (
          <span />
        )}
        <span className="flex items-center gap-4">
          {step < STEPS.length - 1 ? (
            <>
              <span className="hidden font-mono text-[11px] text-ink-3 sm:inline">[ enter to continue ]</span>
              <Button onClick={next} disabled={!canContinue}>
                {step === 2 && !done[2] ? `Keep ${MODES.find((m) => m.key === mode)?.name}` : "Continue"}
              </Button>
            </>
          ) : done[3] ? (
            <Button asChild>
              <Link href="/app">Go to your Overview</Link>
            </Button>
          ) : null}
        </span>
      </footer>
    </div>
  );
}

function Installed({ data }: { data: Data }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl bg-sheet p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-3">
          {data.installation.avatarUrl ? (
            // biome-ignore lint/performance/noImgElement: GitHub's avatar, small and remote.
            <img src={data.installation.avatarUrl} alt="" className="size-8 rounded-md" />
          ) : null}
          <span className="flex flex-col">
            <span className="font-medium text-ink">{data.installation.login}</span>
            <span className="text-xs text-ink-3">
              {data.installation.selection === "all" ? "Every repository" : "Selected repositories"} ·{" "}
              {data.repos.length} you can see
            </span>
          </span>
        </span>
        <a
          href={data.installation.manage}
          className="flex items-center gap-1 text-sm text-ink-2 hover:text-ink"
          target="_blank"
          rel="noreferrer"
        >
          Change which repositories on GitHub <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>
      {data.repos.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {data.repos.map((r) => (
            <li
              key={r.fullName}
              className="rounded-full bg-sunken px-2.5 py-1 font-mono text-xs text-ink-2 ring-1 ring-rule ring-inset"
            >
              {r.fullName.split("/")[1]}
              {r.isPrivate ? <span className="ml-1 text-ink-3">private</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-2">
          No repository yet that you can see. GitHub may still be sending the list (this page updates), or the
          repositories are private ones GitHub doesn't list for you: change the selection on GitHub.
        </p>
      )}
    </section>
  );
}

function Scans({
  repos,
  retried,
  onRetry,
}: {
  repos: Repo[];
  retried: Record<string, Result>;
  onRetry: (repo: string) => void;
}) {
  return (
    <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card" aria-live="polite">
      {repos.map((r) => {
        const s = r.scan?.status;
        const again = retried[r.fullName];
        return (
          <li key={r.fullName} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="flex min-w-0 items-center gap-2.5">
              {s === "done" ? (
                <Check className="size-4 shrink-0 text-proven" aria-label="Scanned" />
              ) : s === "failed" ? (
                <X className="size-4 shrink-0 text-broke" aria-label="Scan failed" />
              ) : (
                <Loader className="size-4 shrink-0 animate-spin text-signal" aria-label="Scanning" />
              )}
              <Link href={`/app/repos/${r.fullName}`} className="truncate font-mono text-ink entity-link">
                {r.fullName}
              </Link>
            </span>
            <span className="flex shrink-0 items-center gap-3 text-xs text-ink-2">
              {s === "done" ? (
                r.reaching ? (
                  <span className="text-broke">
                    {r.reaching} change{r.reaching === 1 ? "" : "s"} reach the code
                  </span>
                ) : (
                  <span className="text-proven">Nothing reaches the code</span>
                )
              ) : s === "failed" ? (
                <>
                  <span className="max-w-56 truncate text-broke" title={r.scan?.error ?? undefined}>
                    {r.scan?.error ?? "The scan failed"}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => onRetry(r.fullName)} disabled={!!again}>
                    <RotateCcw data-icon="inline-start" />
                    {again ? "Retrying…" : "Retry"}
                  </Button>
                </>
              ) : (
                <span>
                  {Date.now() - Date.parse(r.scan?.at ?? r.createdAt) > 10 * 60_000
                    ? "Still going; it finishes in the background"
                    : s === "running"
                      ? "Scanning"
                      : "Waiting its turn"}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Modes({
  repos,
  mode,
  setMode,
  security,
  setSecurity,
  result,
  onSave,
}: {
  repos: Repo[];
  mode: "auto" | "ask" | "off";
  setMode: (m: "auto" | "ask" | "off") => void;
  security: "auto" | "ask";
  setSecurity: (s: "auto" | "ask") => void;
  result: Result | null;
  onSave: () => void;
}) {
  const fromFile = repos.filter((r) => r.fixMode.file);
  const busy = !!result && !("error" in result) && !["done", "refused", "failed"].includes(result.status);
  return (
    <div className="flex flex-col gap-5">
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="sr-only">Fix mode</legend>
        {MODES.map((m) => {
          const on = m.key === mode;
          return (
            <label
              key={m.key}
              className={cn(
                "cursor-pointer focus-within:ring-2 focus-within:ring-signal",
                "relative flex flex-col gap-2 rounded-lg bg-sheet p-4 text-left ring-1 ring-inset transition-colors",
                on ? "ring-ink" : "ring-rule hover:ring-rule-strong",
              )}
            >
              <input
                type="radio"
                name="fix-mode"
                value={m.key}
                checked={on}
                onChange={() => setMode(m.key)}
                className="sr-only"
              />
              {/* Factory's corner brackets mark the choice. */}
              {on
                ? [
                    "top-0 left-0 border-t-2 border-l-2",
                    "top-0 right-0 border-t-2 border-r-2",
                    "bottom-0 left-0 border-b-2 border-l-2",
                    "right-0 bottom-0 border-r-2 border-b-2",
                  ].map((c) => <span key={c} className={cn("absolute size-3 border-ink", c)} aria-hidden />)
                : null}
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">{m.name}</span>
                {"note" in m ? (
                  <span className="rounded-full bg-proven-soft px-2 py-0.5 text-[10px] font-medium text-proven">
                    {m.note}
                  </span>
                ) : null}
              </span>
              <span className="text-xs leading-relaxed text-ink-2">{m.said}</span>
            </label>
          );
        })}
      </fieldset>
      <label className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
        Security fixes
        <select
          value={security}
          onChange={(e) => setSecurity(e.currentTarget.value as "auto" | "ask")}
          className="rounded-md bg-sheet px-2 py-1 text-sm ring-1 ring-rule ring-inset outline-none focus-visible:ring-signal"
        >
          <option value="auto">Automatic: fix advisories on their own</option>
          <option value="ask">Ask first: wait for me</option>
        </select>
      </label>
      {fromFile.length ? (
        <p className="text-xs text-ink-3">
          {fromFile.map((r) => r.fullName.split("/")[1]).join(", ")} set{" "}
          {fromFile.length === 1 ? "its" : "their"} own mode in {fromFile[0]?.fixMode.file}; the file wins
          there.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onSave} disabled={busy}>
          {busy ? "Saving…" : "Save as the default"}
        </Button>
        {result ? (
          <span
            className={cn(
              "text-sm",
              "error" in result || result.status === "refused" ? "text-broke" : "text-ink-2",
            )}
          >
            {"error" in result
              ? result.error
              : result.status === "refused"
                ? `${result.result ?? "Refused"}. You can still set it per repository on the dashboard.`
                : (result.result ?? `${result.status}…`)}
          </span>
        ) : (
          <span className="text-xs text-ink-3">
            Changing the default needs an organization admin or the account owner.
          </span>
        )}
      </div>
    </div>
  );
}

function Activate({
  repos,
  chosen,
  setChosen,
  results,
  onActivate,
}: {
  repos: Repo[];
  chosen: Set<string>;
  setChosen: (s: Set<string>) => void;
  results: Record<string, Result>;
  onActivate: (keep: boolean) => void;
}) {
  const waiting = repos.filter((r) => r.status !== "active");
  const picked = waiting.filter((r) => chosen.has(r.fullName));
  const started = Object.keys(results).length > 0;
  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
        {repos.map((r) => {
          const res = results[r.fullName];
          const active = r.status === "active";
          return (
            <li key={r.fullName} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="flex min-w-0 items-center gap-3">
                <Checkbox
                  id={`activate-${r.fullName}`}
                  checked={active || chosen.has(r.fullName)}
                  disabled={active || started}
                  onCheckedChange={(on) => {
                    const next = new Set(chosen);
                    if (on) next.add(r.fullName);
                    else next.delete(r.fullName);
                    setChosen(next);
                  }}
                  aria-label={`Turn Teire on for ${r.fullName}`}
                />
                <label htmlFor={`activate-${r.fullName}`} className="truncate font-mono text-ink">
                  {r.fullName}
                </label>
              </span>
              <span className="shrink-0 text-xs text-ink-2">
                {res ? (
                  "error" in res ? (
                    <span className="text-broke">{res.error}</span>
                  ) : res.status === "done" ? (
                    <span className="text-proven">{res.result}</span>
                  ) : res.status === "refused" || res.status === "failed" ? (
                    <span className="text-broke">{res.result}</span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-signal">
                      <Loader className="size-3.5 animate-spin" aria-hidden />
                      Turning on…
                    </span>
                  )
                ) : active ? (
                  <span className="text-proven">On</span>
                ) : r.status === "paused" && r.pausedReason === "opted_out" ? (
                  "Opted out (closed its onboarding PR)"
                ) : r.onboarding?.state === "open" ? (
                  <a
                    href={r.onboarding.url ?? undefined}
                    className="hover:text-ink"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Onboarding PR #{r.onboarding.number}
                  </a>
                ) : (
                  "Not on yet"
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {waiting.length && !started ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => onActivate(false)} disabled={!picked.length}>
            Turn Teire on for {picked.length} repositor{picked.length === 1 ? "y" : "ies"}
          </Button>
          <Button variant="ghost" onClick={() => onActivate(true)} disabled={!picked.length}>
            Keep the onboarding PRs
          </Button>
          <span className="text-xs text-ink-3">
            Turning on closes each onboarding PR with a comment; keeping them leaves the PRs open to merge
            later.
          </span>
        </div>
      ) : null}
    </div>
  );
}
