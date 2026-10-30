"use client";

import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  LayoutGrid,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { followAction } from "@/components/app/follow-action";
import { useAssistant } from "@/components/assistant/assistant-provider";
import { FlowCanvas, type PlacedTile } from "@/components/flow/flow-canvas";
import { StaticFlow } from "@/components/flow/static-flow";
import { Button } from "@/components/ui/button";
import NumberTicker from "@/components/ui/number-ticker";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { LeafBurst } from "@/components/welcome/leaf-burst";
import { type Brand, ECOSYSTEMS, SPONSORS, STACK, TEIRE } from "@/lib/brands";
import { FIX_MODES } from "@/lib/fix-mode-options";
import type { FlowLink, FlowState } from "@/lib/flow/model";
import { languageMarks, subjectMark } from "@/lib/marks";
import { cn } from "@/lib/utils";
import type { WelcomeData } from "@/lib/welcome";

/**
 * Onboarding (plan revision 3.4, V2/C7): a focused screen, Attio's split — one decision on the left,
 * on the right a live flow of the person's own repositories that grows step by step:
 *   1 Connected   GitHub → Teire
 *   2 Repositories Teire fans out to the repositories this installation covers (pick which to turn on)
 *   3 First scan  each repository's edge goes live; the focused one sprouts what it uses and what reaches it
 *   4 Fix mode    the flow re-routes per mode; drag "You" into it to approve each fix (desktop)
 *   5 Turn on     the chosen repositories switch on (and their onboarding PRs close, unless kept)
 *   6 Finish
 * Resume, Enter to continue and the 4-second refresh while scans run are kept from 3.3's flow, and so
 * are its actions: the installation's default fix mode (admin-gated), Activate, a failed scan's rescan.
 */
type Data = Extract<WelcomeData, { state: "ok" }>;
type Repo = Data["repos"][number];
type Mode = "auto" | "ask" | "off";
type Result = { status: string; result: string | null } | { error: string };

const STEPS = ["Connected", "Repositories", "First scan", "Fix mode", "Turn on", "Done"] as const;
const MODES: { key: Mode; name: string; said: string; tag?: string }[] = FIX_MODES.map((m) => ({
  key: m.value,
  name: m.label,
  said: m.said,
  ...(m.value === "auto" ? { tag: "Recommended" } : {}),
}));

const keyOf = (s: string) => `welcome:${s}:${Math.floor(Date.now() / 60_000)}`;
const short = (fullName: string) => fullName.split("/")[1] ?? fullName;
const ok = (r?: Result) => !!r && !("error" in r) && r.status !== "refused" && r.status !== "failed";
/** Confirmed: the worker said done. Still open is not on, and a refusal is not on. */
const done = (r?: Result) => !!r && !("error" in r) && r.status === "done";

function scanState(r: Repo): FlowState {
  if (!r.scan || r.scan.status === "queued" || r.scan.status === "running") return "live";
  return r.scan.status === "failed" ? "failed" : "done";
}

/** The canvas for each step, from the person's own data. */
function layout(step: number, data: Data, chosen: Set<string>, mode: Mode, results: Record<string, Result>) {
  const tiles: PlacedTile[] = [];
  const links: FlowLink[] = [];
  const gh: Brand = SPONSORS.github;
  const teire: PlacedTile = {
    id: "teire",
    entity: "fix",
    state: "done",
    label: "Teire",
    x: 200,
    y: 0,
    brand: TEIRE,
  };
  const repos = data.repos.slice(0, 5);
  const more = data.repos.length - repos.length;
  const ry = (i: number, n: number) => (i - (n - 1) / 2) * 104;

  if (step <= 2) {
    tiles.push({
      id: "gh",
      entity: "repository",
      state: "done",
      label: data.installation.login,
      meta: "GitHub",
      brand: gh,
      x: 0,
      y: 0,
    });
    tiles.push({ ...teire, state: step === 0 ? "live" : "done" });
    links.push({ from: "gh", to: "teire", state: step === 0 ? "live" : "done" });
  }
  if (step === 1 || step === 2) {
    repos.forEach((r, i) => {
      const on = chosen.has(r.fullName);
      const st: FlowState = step === 2 ? (on ? scanState(r) : "skipped") : on ? "done" : "pending";
      tiles.push({
        id: `r:${r.fullName}`,
        entity: "repository",
        state: st,
        label: short(r.fullName),
        ...(step === 2 && r.packages
          ? { meta: `${r.packages} packages` }
          : r.isPrivate
            ? { meta: "private" }
            : {}),
        ...(step === 2 && r.scan?.status === "failed" ? { caption: "scan failed" } : {}),
        brand: languageMarks(r.languages)[0] ?? gh,
        x: 420,
        y: ry(i, repos.length + (more > 0 ? 1 : 0)),
      });
      links.push({ from: "teire", to: `r:${r.fullName}`, state: st === "skipped" ? "pending" : st });
    });
    if (more > 0) {
      tiles.push({
        id: "more",
        entity: "repository",
        state: "pending",
        label: `${more} more`,
        x: 420,
        y: ry(repos.length, repos.length + 1),
      });
      links.push({ from: "teire", to: "more", state: "pending" });
    }
  }
  if (step === 2) {
    // The focused repository sprouts what it uses and what reaches its code (capped, plan 3.4 B6).
    const focus = [...repos]
      .filter((r) => chosen.has(r.fullName))
      .sort((a, b) => b.reaching - a.reaching || (b.changes?.length ?? 0) - (a.changes?.length ?? 0))[0];
    if (focus) {
      const fy = tiles.find((t) => t.id === `r:${focus.fullName}`)?.y ?? 0;
      languageMarks(focus.languages)
        .slice(0, 3)
        .forEach((b, i) => {
          // The ecosystem's own package count, when the scan read its manifests.
          const n = Object.entries(ECOSYSTEMS).find(([, e]) => e.label === b.label)?.[0];
          const count = n ? focus.byEcosystem?.[n] : undefined;
          tiles.push({
            id: `e:${b.label}`,
            entity: "update",
            state: "done",
            label: b.label,
            ...(count ? { meta: `${count} packages` } : {}),
            brand: b,
            size: "sm",
            x: 640,
            y: fy + (i - 1) * 100 + 10,
          });
          links.push({ from: `r:${focus.fullName}`, to: `e:${b.label}`, state: "done" });
        });
      (focus.changes ?? []).slice(0, 3).forEach((c, i) => {
        tiles.push({
          id: `c:${c.key}`,
          entity: "change",
          state: c.verdict === "affected" ? "failed" : "not_proven",
          label: c.title.length > 26 ? `${c.title.slice(0, 25)}…` : c.title,
          brand: subjectMark(c.key),
          size: "sm",
          x: 860,
          y: fy + (i - 1) * 100 + 10,
        });
        links.push({
          from: `r:${focus.fullName}`,
          to: `c:${c.key}`,
          state: "not_proven",
          label: i === 0 ? "reaches" : undefined,
        });
      });
    }
  }
  if (step === 3) {
    // The fix flow for the person's own most urgent change (or a package update when none reaches).
    const top = data.repos.flatMap((r) => r.changes ?? [])[0];
    const change: PlacedTile = {
      id: "change",
      entity: "change",
      state: "done",
      label: top ? (top.title.length > 24 ? `${top.title.slice(0, 23)}…` : top.title) : "A change",
      ...(top ? { brand: subjectMark(top.key) } : {}),
      x: 0,
      y: 0,
    };
    tiles.push(change);
    if (mode === "off") {
      tiles.push({
        id: "report",
        entity: "outcome",
        state: "done",
        label: "Listed for you",
        meta: "no PR",
        x: 190,
        y: 0,
      });
      links.push({ from: "change", to: "report", state: "done" });
      for (const [id, label, x] of [
        ["fix", "Fix", 380],
        ["checks", "Your checks", 540],
        ["pr", "Pull request", 700],
      ] as const)
        tiles.push({
          id,
          entity: id === "fix" ? "fix" : id === "checks" ? "check" : "outcome",
          state: "skipped",
          label,
          x,
          y: 0,
        });
    } else {
      const ask = mode === "ask";
      tiles.push({
        id: "you",
        entity: "review",
        state: ask ? "live" : "pending",
        label: "You",
        meta: ask ? "click Fix now" : undefined,
        draggable: true,
        x: 170,
        y: ask ? 0 : 140,
        ...(ask ? {} : { hint: "Drag You in to approve each fix" }),
      });
      tiles.push({
        id: "fix",
        entity: "fix",
        state: "done",
        label: "Nemotron 3 Ultra",
        brand: STACK.nemotron,
        x: 340,
        y: 0,
      });
      tiles.push({ id: "sandbox", entity: "sandbox", state: "done", label: "Sandbox", x: 500, y: 0 });
      tiles.push({ id: "checks", entity: "check", state: "proven", label: "Your checks", x: 660, y: 0 });
      tiles.push({ id: "pr", entity: "outcome", state: "proven", label: "Pull request", x: 820, y: 0 });
      if (ask)
        links.push(
          { from: "change", to: "you", state: "live" },
          { from: "you", to: "fix", state: "pending" },
        );
      else links.push({ from: "change", to: "fix", state: "live" });
      links.push(
        { from: "fix", to: "sandbox", state: "done" },
        { from: "sandbox", to: "checks", state: "proven" },
        { from: "checks", to: "pr", state: "proven" },
      );
    }
  }
  if (step >= 4) {
    tiles.push({ ...teire, x: 0, y: 0, state: "done" });
    const list = data.repos.filter((r) => chosen.has(r.fullName) || r.status === "active").slice(0, 6);
    list.forEach((r, i) => {
      const res = results[r.fullName];
      const st: FlowState =
        r.status === "active" || done(res) ? "proven" : res && !ok(res) ? "failed" : res ? "live" : "pending";
      tiles.push({
        id: `r:${r.fullName}`,
        entity: "repository",
        state: st,
        label: short(r.fullName),
        meta: st === "proven" ? "On" : st === "failed" ? "refused" : st === "live" ? "turning on" : "Off",
        brand: languageMarks(r.languages)[0] ?? gh,
        x: 260,
        y: ry(i, list.length),
      });
      links.push({
        from: "teire",
        to: `r:${r.fullName}`,
        state: st === "proven" ? "proven" : st === "failed" ? "failed" : "pending",
      });
    });
  }
  return { tiles, links };
}

export function Onboarding({ data, updated }: { data: Data; updated: boolean }) {
  const router = useRouter();
  const store = `teire-welcome-${data.installation.id}`;
  const [step, setStep] = useState(0);
  const { ask, available } = useAssistant();
  const [mode, setMode] = useState<Mode>(data.installation.defaultFixMode ?? "auto");
  const [security, setSecurity] = useState<"auto" | "ask">(data.installation.securityFixMode ?? "auto");
  const [closePrs, setClosePrs] = useState(true);
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(data.repos.filter((r) => r.status !== "disabled").map((r) => r.fullName)),
  );
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState(false);

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

  // While first scans run (for up to ten minutes), the page reads again every four seconds.
  const scanning = data.repos.filter(
    (r) =>
      chosen.has(r.fullName) &&
      (!r.scan || r.scan.status === "queued" || r.scan.status === "running") &&
      Date.now() - Date.parse(r.scan?.at ?? r.createdAt) < 10 * 60_000,
  );
  useEffect(() => {
    if (!scanning.length) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [scanning.length, router]);

  // A brand-new installation's repositories arrive with GitHub's webhook, seconds after the person
  // lands here: the page reads again until they do (for up to ten minutes)…
  const arriving =
    data.repos.length === 0 && Date.now() - Date.parse(data.installation.createdAt) < 10 * 60_000;
  useEffect(() => {
    if (!arriving) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [arriving, router]);
  // …and each one that arrives after the page opened joins the selection, as those it opened with did.
  const [seen, setSeen] = useState(() => new Set(data.repos.map((r) => r.fullName)));
  useEffect(() => {
    const fresh = data.repos.filter((r) => !seen.has(r.fullName));
    if (!fresh.length) return;
    setSeen(new Set(data.repos.map((r) => r.fullName)));
    setChosen((c) => new Set([...c, ...fresh.filter((r) => r.status !== "disabled").map((r) => r.fullName)]));
  }, [data.repos, seen]);

  const saveMode = async () => {
    let refused = false;
    await followAction(
      {
        kind: "set-installation-fix-mode",
        params: { mode, security },
        installationId: data.installation.id,
        key: keyOf(`mode:${data.installation.id}:${mode}:${security}`),
      },
      (s) => {
        if ("error" in s || s.status === "refused") refused = true;
      },
    );
    if (refused) {
      // The You tile springs back to the mode that is actually set (plan revision 3.4, C7).
      setMode(data.installation.defaultFixMode ?? "auto");
      toast("Needs an organization admin", {
        description: "Your choice wasn't saved; repos keep their mode.",
      });
    }
  };

  const turnOn = (repo: string) =>
    followAction(
      { kind: "activate", params: { keep: !closePrs }, repo, key: keyOf(`activate:${repo}:${!closePrs}`) },
      (s) => setResults((r) => ({ ...r, [repo]: "error" in s ? s : { status: s.status, result: s.result } })),
    );

  const activate = async () => {
    setBusy(true);
    const names = data.repos
      .filter((r) => chosen.has(r.fullName) && r.status !== "active")
      .map((r) => r.fullName);
    // Each repository's own answer, kept here as well as in state, so the decision below reads it.
    const answers = new Map<string, Result>();
    await Promise.all(
      names.map((repo) =>
        followAction(
          {
            kind: "activate",
            params: { keep: !closePrs },
            repo,
            key: keyOf(`activate:${repo}:${!closePrs}`),
          },
          (s) => {
            const res: Result = "error" in s ? s : { status: s.status, result: s.result };
            answers.set(repo, res);
            setResults((r) => ({ ...r, [repo]: res }));
          },
        ),
      ),
    );
    const on = names.filter((n) => done(answers.get(n))).length;
    const already = data.repos.filter((r) => chosen.has(r.fullName) && r.status === "active").length;
    setBusy(false);
    // Nothing turned on: stay here and say why, never "Teire is on".
    if (names.length && !on && !already) {
      const why = [...answers.values()].map((r) => ("error" in r ? r.error : r.result)).find(Boolean);
      toast.error("Teire couldn't turn on", { description: why ?? "Try again in a moment." });
      router.refresh();
      return;
    }
    try {
      localStorage.setItem("teire-welcome-done", JSON.stringify({ at: Date.now(), repos: on + already }));
    } catch {}
    setStep(5);
    router.refresh();
  };

  const retry = (repo: string) =>
    void followAction(
      { kind: "rescan", params: {}, repo, key: keyOf(`rescan:${repo}`) },
      () => undefined,
    ).then(() => router.refresh());

  // biome-ignore lint/correctness/useExhaustiveDependencies: the actions read the current choices
  const next = useCallback(async () => {
    if (step === 3) {
      setBusy(true);
      await saveMode();
      setBusy(false);
    }
    if (step === 4) return void activate();
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }, [step, mode, security, chosen, closePrs]);

  // Enter continues, except on a control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "Enter" || t?.closest("input, textarea, button, a, [role=switch], [role=radio]")) return;
      void next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next]);

  const g = layout(step, data, chosen, mode, results);
  // Drag-to-choose (C7): dropping You on the line between the change and the fix means Ask first.
  const onDrop = (id: string, at: { x: number; y: number }) => {
    if (id !== "you") return;
    setMode(Math.abs(at.y) < 60 && at.x > 50 && at.x < 300 ? "ask" : "auto");
  };
  const packages = data.repos
    .filter((r) => chosen.has(r.fullName))
    .reduce((n, r) => n + (r.packages ?? 0), 0);
  const reaching = data.repos.filter((r) => chosen.has(r.fullName)).reduce((n, r) => n + r.reaching, 0);
  const decided = data.repos.filter((r) => r.fixMode.origin === "repo-file");

  const TITLE = [
    updated ? "Access updated." : "Connected to GitHub.",
    "Pick your repositories.",
    scanning.length ? "Reading your code." : "What reaches your code.",
    "How should Teire fix?",
    "Turn Teire on.",
    "Teire is on.",
  ];

  return (
    <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
      <section className="flex flex-col gap-7 rounded-feature bg-sheet p-7 shadow-card sm:p-9">
        <ol className="flex items-center gap-1.5" aria-label="Steps">
          {STEPS.map((label, i) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
                aria-current={i === step ? "step" : undefined}
                aria-label={`${i + 1}. ${label}`}
                className={cn(
                  "block h-1.5 rounded-full transition-all duration-300",
                  i === step ? "w-8 bg-signal" : i < step ? "w-4 bg-ink" : "w-4 bg-rule-strong",
                )}
              />
            </li>
          ))}
        </ol>
        <h1 className="display text-[40px]">{TITLE[step]}</h1>

        {data.installation.suspended ? (
          <p className="rounded-card bg-attention-soft px-4 py-2.5 text-[13px] text-attention">
            Suspended on GitHub · nothing runs until it's lifted
          </p>
        ) : null}

        <div className="flex flex-1 flex-col gap-4">
          {step === 0 ? (
            <div className="flex flex-col gap-3">
              <span className="flex items-center gap-3 rounded-card bg-sunken p-3">
                {/* biome-ignore lint/performance/noImgElement: a GitHub avatar */}
                <img
                  src={`https://github.com/${data.installation.login}.png?size=80`}
                  alt=""
                  className="size-9 rounded-full"
                />
                <span className="flex flex-col">
                  <span className="text-[15px] font-medium">{data.installation.login}</span>
                  <span className="font-mono text-[11px] text-ink-3">
                    {arriving
                      ? "GitHub is handing over its repositories…"
                      : `${data.repos.length} repositories`}
                  </span>
                </span>
              </span>
              <a
                href={data.installation.manage}
                className="inline-flex w-fit items-center gap-1 text-[13px] text-link hover:underline"
              >
                Change access on GitHub <ExternalLink className="size-3" />
              </a>
            </div>
          ) : null}

          {step === 1 && arriving ? (
            <p className="flex items-center gap-2 rounded-card bg-sunken px-3 py-2.5 text-[13px] text-ink-2">
              <span className="size-2 animate-pulse rounded-full bg-cta" aria-hidden />
              GitHub is handing over this installation's repositories…
            </p>
          ) : null}
          {step === 1 ? (
            <ul className="flex flex-col gap-1.5">
              {data.repos.length > 1 ? (
                <li className="flex items-center justify-between gap-3 px-3 py-1">
                  <span className="font-mono text-[11px] text-ink-3">
                    {chosen.size} of {data.repos.length}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setChosen(
                        chosen.size === data.repos.length
                          ? new Set()
                          : new Set(data.repos.map((r) => r.fullName)),
                      )
                    }
                    className="text-xs text-ink-2 hover:text-ink"
                  >
                    {chosen.size === data.repos.length ? "Select none" : "Select all"}
                  </button>
                </li>
              ) : null}
              {data.repos.map((r) => (
                <li
                  key={r.fullName}
                  className="flex items-center justify-between gap-3 rounded-card bg-sunken px-3 py-2"
                >
                  <span className="min-w-0 truncate font-mono text-[13px]">{r.fullName}</span>
                  <Switch
                    checked={chosen.has(r.fullName)}
                    disabled={r.status === "active"}
                    onCheckedChange={(on) =>
                      setChosen((c) => {
                        const n = new Set(c);
                        if (on) n.add(r.fullName);
                        else n.delete(r.fullName);
                        return n;
                      })
                    }
                    aria-label={`Turn Teire on for ${r.fullName}`}
                  />
                </li>
              ))}
            </ul>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-4">
              <dl className="grid grid-cols-2 gap-3">
                <div className="rounded-card bg-sunken p-4">
                  <dt className="font-mono text-[11px] text-ink-3">packages read</dt>
                  <dd className="font-mono text-3xl text-ink">
                    <NumberTicker from={0} target={packages} />
                  </dd>
                </div>
                <div className="rounded-card bg-sunken p-4">
                  <dt className="font-mono text-[11px] text-ink-3">reach your code</dt>
                  <dd className="font-mono text-3xl text-broke">
                    <NumberTicker from={0} target={reaching} />
                  </dd>
                </div>
              </dl>
              {data.repos
                .filter((r) => chosen.has(r.fullName) && r.scan?.status === "failed")
                .map((r) => (
                  <div
                    key={r.fullName}
                    className="flex items-center justify-between gap-3 rounded-card bg-broke-soft px-3 py-2 text-[13px] text-broke"
                  >
                    <span className="truncate">{short(r.fullName)} · scan failed</span>
                    <Button size="xs" variant="outline" onClick={() => retry(r.fullName)}>
                      <RotateCcw data-icon="inline-start" />
                      Retry
                    </Button>
                  </div>
                ))}
              {scanning.length ? (
                <p className="font-mono text-[12px] text-signal">
                  {scanning.length} still scanning · continue anytime
                </p>
              ) : null}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-4">
              <div role="radiogroup" aria-label="Fix mode" className="flex flex-col gap-2">
                {MODES.map((m) => (
                  // biome-ignore lint/a11y/useSemanticElements: a card radio (icon, name, caption); the group carries radiogroup semantics
                  <button
                    key={m.key}
                    type="button"
                    role="radio"
                    aria-checked={mode === m.key}
                    onClick={() => setMode(m.key)}
                    className={cn(
                      "flex items-center gap-3 rounded-card p-3.5 text-left transition-shadow",
                      mode === m.key
                        ? "bg-sheet shadow-[0_0_0_2px_var(--ink)]"
                        : "bg-sunken hover:shadow-card-hover",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full",
                        mode === m.key ? "bg-ink text-sheet" : "ring-1 ring-rule-strong ring-inset",
                      )}
                    >
                      {mode === m.key ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                    <span className="flex flex-col">
                      <span className="flex items-center gap-2 text-[15px] font-medium">
                        {m.name}
                        {m.tag ? (
                          <span className="rounded-full bg-proven-soft px-2 py-0.5 text-[11px] font-medium text-proven">
                            {m.tag}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-[13px] text-ink-2">{m.said}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-3 rounded-card bg-sunken px-3 py-2.5">
                <span className="text-[13px]">Security fixes</span>
                {mode === "off" ? (
                  <span className="text-[12px] text-ink-3">Off stops security fixes too</span>
                ) : (
                  <ToggleGroup
                    type="single"
                    size="sm"
                    variant="outline"
                    value={security}
                    onValueChange={(v) => v && setSecurity(v as "auto" | "ask")}
                  >
                    <ToggleGroupItem value="auto">Automatic</ToggleGroupItem>
                    <ToggleGroupItem value="ask">Ask first</ToggleGroupItem>
                  </ToggleGroup>
                )}
              </div>
              {decided.length ? (
                <p className="font-mono text-[11px] text-ink-3">
                  Set in teire.yml: {decided.map((r) => short(r.fullName)).join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}

          {step === 4 ? (
            <div className="flex flex-col gap-3">
              <p className="font-mono text-[12px] text-ink-3">
                {[...chosen].length} repositories · {MODES.find((m) => m.key === mode)?.name}
              </p>
              <div className="flex items-center justify-between gap-3 rounded-card bg-sunken px-3 py-2.5 text-[13px]">
                <label htmlFor="close-prs">Close onboarding PRs with a comment</label>
                <Switch id="close-prs" checked={closePrs} onCheckedChange={setClosePrs} />
              </div>
            </div>
          ) : null}

          {step === 5 ? (
            <div className="flex flex-col gap-4">
              <LeafBurst />
              <dl className="grid grid-cols-3 gap-2">
                {[
                  [
                    "repos on",
                    data.repos.filter((r) => r.status === "active" || done(results[r.fullName])).length,
                  ],
                  ["packages", packages],
                  ["reaching", reaching],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded-card bg-sunken p-3">
                    <dt className="font-mono text-[11px] text-ink-3">{k}</dt>
                    <dd className="font-mono text-2xl">
                      <NumberTicker from={0} target={v as number} />
                    </dd>
                  </div>
                ))}
              </dl>
              {data.repos.some(
                (r) => chosen.has(r.fullName) && results[r.fullName] && !ok(results[r.fullName]),
              ) ? (
                <ul className="flex flex-col gap-1.5">
                  {data.repos
                    .filter((r) => chosen.has(r.fullName) && results[r.fullName] && !ok(results[r.fullName]))
                    .map((r) => (
                      <li
                        key={r.fullName}
                        className="flex items-center justify-between gap-2 rounded-card bg-broke-soft px-3 py-2 text-xs text-broke"
                      >
                        <span className="truncate font-mono">{short(r.fullName)}</span>
                        <Button size="xs" variant="outline" onClick={() => void turnOn(r.fullName)}>
                          Try again
                        </Button>
                      </li>
                    ))}
                </ul>
              ) : null}
              <nav aria-label="What next" className="grid grid-cols-3 gap-2">
                {(
                  [
                    { label: "Overview", href: "/app", icon: LayoutGrid },
                    { label: "Its runs", href: "/app/runs?show=active", icon: Activity },
                  ] as const
                ).map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className="flex flex-col items-center gap-2 rounded-card bg-sunken p-3 text-center text-[13px] hover:bg-hover"
                  >
                    <n.icon className="size-5 text-ink-2" aria-hidden />
                    {n.label}
                  </Link>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    ask("What does Teire see in my repositories, and what will it do first?", null)
                  }
                  disabled={!available}
                  className="flex flex-col items-center gap-2 rounded-card bg-sunken p-3 text-center text-[13px] hover:bg-hover disabled:opacity-50"
                >
                  <Sparkles className="size-5 text-ink-2" aria-hidden />
                  Ask Teire
                </button>
              </nav>
            </div>
          ) : null}
        </div>

        {step < 5 ? (
          <footer className="flex items-center justify-between gap-3">
            {step > 0 ? (
              <Button variant="ghost" onClick={() => setStep(step - 1)}>
                <ArrowLeft data-icon="inline-start" />
                Back
              </Button>
            ) : (
              <span />
            )}
            <Button
              variant="cta"
              size="xl"
              shape="pill"
              onClick={() => void next()}
              disabled={busy || (step === 4 && chosen.size === 0)}
            >
              {step === 3
                ? "Save and continue"
                : step === 4
                  ? busy
                    ? "Turning on…"
                    : "Turn on"
                  : "Continue"}
              <ArrowRight data-icon="inline-end" />
            </Button>
          </footer>
        ) : null}
      </section>

      {/* Phones: the same tiles as a vertical timeline (no canvas to pan, drag or squint at). */}
      <section className="rounded-feature bg-sheet p-5 shadow-card md:hidden">
        <StaticFlow
          size="sm"
          label={`Step ${step + 1}: ${TITLE[step]}`}
          graph={{
            // Teire, then what this step adds (a step's own tiles come last in its layout).
            tiles: [
              ...g.tiles.filter((t) => t.id === "teire"),
              ...g.tiles.filter((t) => t.id !== "teire").slice(-5),
            ],
            links: g.links,
          }}
        />
      </section>
      <section className="relative hidden min-h-[360px] overflow-hidden rounded-feature bg-sheet shadow-card md:block lg:min-h-[560px]">
        <FlowCanvas
          tiles={g.tiles}
          links={g.links}
          onDrop={onDrop}
          label={`Step ${step + 1}: ${TITLE[step]}`}
        />
      </section>
    </div>
  );
}
