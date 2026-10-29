"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai";
import { AtSign, Copy, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { Skeleton } from "@/components/ui/skeleton";
import type { AssistantContext, AssistantMessage } from "@/lib/assistant/message";
import { cn } from "@/lib/utils";
import {
  ActionCard,
  ChangeCard,
  ChangesCard,
  ChoicesCard,
  ConfigCard,
  ConfigSnippet,
  DocsCard,
  FindingCard,
  FindingsCard,
  NoticeCard,
  OverviewCard,
  ReachCard,
  RepoCard,
  ReposCard,
  RunCard,
  RunsCard,
  SafeLink,
  StepsCard,
  UsageCard,
  WhyCard,
} from "./assistant-cards";
import { type Mention, useAssistant } from "./assistant-provider";

/**
 * One Ask Teire thread (plan revision 3.3, U4): the stored messages load first (a skeleton while they
 * do), then the conversation streams through `useChat`: tool steps as rows with their cards, the
 * Markdown answer, and copy, retry, helpful / not helpful under each reply. Stop aborts the model on
 * the server too; an interrupted reply stays, marked, with Retry.
 */
export function AssistantChat({ threadId, chip }: { threadId: string; chip: AssistantContext | null }) {
  const [initial, setInitial] = useState<AssistantMessage[] | null>(null);
  useEffect(() => {
    let alive = true;
    setInitial(null);
    fetch(`/api/assistant/threads/${threadId}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { messages: AssistantMessage[] }).messages : []))
      .catch(() => [])
      .then((m) => alive && setInitial(m));
    return () => {
      alive = false;
    };
  }, [threadId]);
  if (!initial)
    return (
      <div className="flex flex-1 flex-col gap-4 p-4" role="status" aria-label="Loading the thread">
        <Skeleton className="ml-auto h-9 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  return <Thread key={threadId} threadId={threadId} initial={initial} chip={chip} />;
}

const SUGGESTIONS: Record<string, string[]> = {
  none: [
    "What needs me today?",
    "Which repos have a run going?",
    "Make Teire ask before fixing everywhere",
    "What does Ask first mean?",
  ],
  repo: [
    "What needs me here?",
    "Why is there no PR for the top finding?",
    "Make Teire ask before fixing here",
    "What would the next upgrade break?",
  ],
  run: ["Explain this run", "Why is this a draft?", "What wasn't covered?", "Re-verify it"],
  change: ["Which of my repos does this reach?", "What should I replace it with?", "Fix it everywhere"],
  docs: ["How does Teire prove a fix?", "How do I turn on Ask first?", "What does teire.yml control?"],
};

function modelName(id: string | undefined) {
  if (!id) return "Nemotron 3 Ultra";
  return /ultra/i.test(id)
    ? "Nemotron 3 Ultra"
    : /super/i.test(id)
      ? "Nemotron 3 Super"
      : id.split("/").pop();
}

function Thread({
  threadId,
  initial,
  chip,
}: {
  threadId: string;
  initial: AssistantMessage[];
  chip: AssistantContext | null;
}) {
  const a = useAssistant();
  const live = useRef({ chip, mode: a.mode });
  live.current = { chip, mode: a.mode };
  const transport = useMemo(
    () =>
      new DefaultChatTransport<AssistantMessage>({
        api: "/api/assistant",
        prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => ({
          body: {
            id,
            trigger,
            messageId,
            message: trigger === "submit-message" ? messages.at(-1) : undefined,
            context: live.current.chip,
            mode: live.current.mode,
          },
        }),
      }),
    [],
  );
  const { messages, sendMessage, status, stop, regenerate, error, clearError } = useChat<AssistantMessage>({
    id: threadId,
    messages: initial,
    transport,
  });
  const busy = status === "submitted" || status === "streaming";
  const [text, setText] = useState("");

  const send = (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    clearError();
    void sendMessage({ text: q });
    setText("");
  };

  // A question asked from elsewhere (Explain, ⌘K's "Ask Teire: …") goes as soon as the thread is ready.
  useEffect(() => {
    if (a.queued && !busy) {
      const q = a.takeQueued();
      if (q) send(q);
    }
  });

  const lastModel = [...messages].reverse().find((m) => m.role === "assistant")?.metadata?.model;
  const asked = new Set(
    messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))),
  );
  const suggestions = (SUGGESTIONS[a.mode === "docs" ? "docs" : (chip?.kind ?? "none")] ?? []).filter(
    (s) => !asked.has(s),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-5 px-4 py-4">
          {messages.length === 0 ? (
            <div className="flex flex-col gap-3 pt-6">
              <p className="text-sm text-ink-2">
                {a.mode === "docs"
                  ? "Ask about how Teire works. Answers come from the docs and the public catalog."
                  : "Ask about your repositories, findings, runs and changes. Teire reads freely and acts only when you confirm."}
              </p>
              <div className="flex flex-col gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="w-fit rounded-md px-2 py-1 text-left text-sm text-ink hover:bg-hover"
                  >
                    {s} <span className="text-ink-3">›</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <Turn
                key={m.id}
                message={m}
                last={i === messages.length - 1}
                streaming={busy && i === messages.length - 1}
                onPick={send}
                onRetry={() => void regenerate({ messageId: m.id })}
                busy={busy}
              />
            ))
          )}
          {status === "submitted" ? <Shimmer className="font-mono text-[11px]">Reading…</Shimmer> : null}
          {error ? (
            <div className="flex items-center gap-2 text-xs text-broke">
              <span>{error.message || "Nemotron didn't answer this time."}</span>
              <button type="button" className="entity-link text-ink" onClick={() => void regenerate()}>
                Retry
              </button>
              <SafeLink href="/docs" className="text-ink-2">
                Search the docs
              </SafeLink>
            </div>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton className="bg-sheet" />
      </Conversation>
      {messages.length > 0 && !busy ? (
        <Suggestions className="px-4 pb-2">
          {suggestions.slice(0, 3).map((s) => (
            <Suggestion key={s} suggestion={s} onClick={send} className="h-7 text-xs" />
          ))}
        </Suggestions>
      ) : null}
      <Composer
        text={text}
        setText={setText}
        onSend={() => send(text)}
        onStop={stop}
        status={status}
        mentions={a.mentions}
        model={modelName(lastModel)}
        docs={a.mode === "docs"}
      />
    </div>
  );
}

/** What each tool step says, while it works and when it's done (Factory's present-tense grammar). */
function stepTitle(name: string, input: Record<string, unknown> | undefined, output: unknown, done: boolean) {
  const o = (output ?? {}) as Record<string, unknown>;
  const n = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).length : 0);
  const repo = typeof input?.repo === "string" ? input.repo : "";
  if (done && typeof o.error === "string") return o.error;
  switch (name) {
    case "get_overview":
      return done ? "Read the overview" : "Reading what needs you…";
    case "list_repos":
      return done ? `Listed ${o.total ?? n("repos")} repositories` : "Listing repositories…";
    case "get_repo":
      return done ? `Read ${repo}` : `Reading ${repo}…`;
    case "list_findings":
      return done ? `Read ${n("groups")} findings on ${repo}` : `Reading ${repo} findings…`;
    case "get_finding":
      return done ? "Read the finding" : `Reading the finding on ${repo}…`;
    case "list_runs":
      return done ? `Listed ${n("runs")} runs` : "Listing runs…";
    case "get_run":
    case "explain_run":
      return done ? "Read the run" : "Reading the run…";
    case "list_changes":
      return done ? `Found ${o.total ?? n("changes")} changes` : "Searching the catalog…";
    case "get_change":
      return done ? "Read the change" : "Reading the change…";
    case "affected_by_change":
      return done ? `Reaches ${n("reaches")} repositories` : "Finding where it reaches…";
    case "get_config":
      return done ? "Read teire.yml" : `Reading ${repo} teire.yml…`;
    case "get_usage":
      return done ? "Read usage" : "Reading usage…";
    case "search_docs":
      return done
        ? `Found ${n("results")} docs pages`
        : `Searching the docs for "${String(input?.query ?? "")}"…`;
    case "why_no_pr":
      return done ? "Walked the gates" : "Walking the gates…";
    case "preview_config":
      return done ? "Previewed the change" : "Previewing teire.yml…";
    case "propose_action":
      return done ? "Prepared the action" : "Preparing the action…";
    default:
      return done ? `Ran ${name}` : `Running ${name}…`;
  }
}

function cardFor(name: string, output: unknown, onPick: (v: string) => void, busy: boolean) {
  const o = output as never;
  switch (name) {
    case "get_overview":
      return <OverviewCard o={o} />;
    case "list_repos":
      return <ReposCard o={o} />;
    case "get_repo":
      return <RepoCard o={o} />;
    case "list_findings":
      return <FindingsCard o={o} />;
    case "get_finding":
      return <FindingCard o={o} />;
    case "list_runs":
      return <RunsCard o={o} />;
    case "get_run":
    case "explain_run":
      return <RunCard o={o} />;
    case "list_changes":
      return <ChangesCard o={o} />;
    case "get_change":
      return <ChangeCard o={o} />;
    case "affected_by_change":
      return <ReachCard o={o} />;
    case "get_config":
      return <ConfigCard o={o} />;
    case "preview_config":
      return <ConfigSnippet o={o} />;
    case "get_usage":
      return <UsageCard o={o} />;
    case "search_docs":
      return <DocsCard o={o} />;
    case "why_no_pr":
      return <WhyCard o={o} />;
    case "propose_action":
      return <ActionCard o={o} />;
    case "show_steps":
      return <StepsCard o={o} />;
    case "offer_choices":
      return <ChoicesCard o={o} onPick={onPick} disabled={busy} />;
    default:
      return null;
  }
}

/** Markdown links: inside Teire, or Teire's PRs and issues on GitHub; anything else is text. */
const markdownComponents = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <SafeLink href={href}>{children}</SafeLink>
  ),
};

function Turn({
  message,
  last,
  streaming,
  onPick,
  onRetry,
  busy,
}: {
  message: AssistantMessage;
  last: boolean;
  streaming: boolean;
  onPick: (v: string) => void;
  onRetry: () => void;
  busy: boolean;
}) {
  if (message.role === "user")
    return (
      <Message from="user">
        <MessageContent className="rounded-lg rounded-br-sm bg-sunken px-3 py-2 text-ink ring-1 ring-rule ring-inset group-[.is-user]:bg-sunken group-[.is-user]:px-3 group-[.is-user]:py-2">
          {message.parts.map((p, i) =>
            // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts keep their order.
            p.type === "text" ? <span key={i}>{p.text}</span> : null,
          )}
        </MessageContent>
      </Message>
    );
  const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
  return (
    <Message from="assistant" className="max-w-full">
      <MessageContent className="w-full gap-3 text-[13.5px] leading-relaxed text-ink">
        {message.parts.map((part, i) => {
          const key = `${message.id}:${i}`;
          if (part.type === "text")
            return (
              <MessageResponse
                key={key}
                components={markdownComponents}
                className="text-ink [&_code]:rounded [&_code]:bg-sunken [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_li]:my-0.5 [&_ol]:my-1.5 [&_p]:my-1.5 [&_ul]:my-1.5"
              >
                {part.text}
              </MessageResponse>
            );
          if (part.type === "data-notice") return <NoticeCard key={key} notice={part.data} />;
          if (!isToolUIPart(part)) return null;
          const name = getToolName(part);
          const done = part.state === "output-available";
          const card = done ? cardFor(name, part.output, onPick, busy || !last) : null;
          const error = done && (part.output as { error?: string } | undefined)?.error;
          if (name === "offer_choices" || name === "show_steps")
            return card ? <div key={key}>{card}</div> : null;
          return (
            <Tool key={key} defaultOpen>
              <ToolHeader
                title={
                  part.state === "output-error"
                    ? `Couldn't finish: ${part.errorText}`
                    : stepTitle(name, part.input as Record<string, unknown>, part.output, done)
                }
                state={error ? "output-error" : part.state}
                expandable={!!card && !error}
              />
              {card && !error ? <ToolContent>{card}</ToolContent> : null}
            </Tool>
          );
        })}
        {message.metadata?.interrupted ? (
          <p className="font-mono text-[11px] text-attention">Stopped before it finished.</p>
        ) : null}
      </MessageContent>
      {!streaming ? (
        <ReplyActions message={message} text={text} onRetry={onRetry} canRetry={last && !busy} />
      ) : null}
    </Message>
  );
}

function ReplyActions({
  message,
  text,
  onRetry,
  canRetry,
}: {
  message: AssistantMessage;
  text: string;
  onRetry: () => void;
  canRetry: boolean;
}) {
  const [rating, setRating] = useState<1 | -1 | null>(message.metadata?.rating ?? null);
  const [copied, setCopied] = useState(false);
  const rate = (value: 1 | -1) => {
    const next = rating === value ? null : value;
    setRating(next);
    void fetch(`/api/assistant/messages/${message.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: next }),
    });
  };
  const cost = message.metadata?.costUsd;
  const button = "rounded-md p-1 text-ink-3 hover:bg-hover hover:text-ink";
  return (
    <div className="flex items-center gap-0.5">
      {text ? (
        <button
          type="button"
          className={button}
          aria-label={copied ? "Copied" : "Copy as Markdown"}
          title={copied ? "Copied" : "Copy as Markdown"}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <Copy className="size-3.5" aria-hidden />
        </button>
      ) : null}
      {canRetry ? (
        <button type="button" className={button} aria-label="Ask again" title="Ask again" onClick={onRetry}>
          <RotateCcw className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <button
        type="button"
        className={cn(button, rating === 1 && "text-proven")}
        aria-label="Helpful"
        aria-pressed={rating === 1}
        title="Helpful"
        onClick={() => rate(1)}
      >
        <ThumbsUp className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        className={cn(button, rating === -1 && "text-broke")}
        aria-label="Not helpful"
        aria-pressed={rating === -1}
        title="Not helpful"
        onClick={() => rate(-1)}
      >
        <ThumbsDown className="size-3.5" aria-hidden />
      </button>
      {cost !== undefined ? (
        <span
          className="ml-1 font-mono text-[10px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100"
          title={`${message.metadata?.tokensIn ?? 0} tokens in, ${message.metadata?.tokensOut ?? 0} out`}
        >
          ${cost.toFixed(4)}
        </span>
      ) : null}
    </div>
  );
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

function Composer({
  text,
  setText,
  onSend,
  onStop,
  status,
  mentions,
  model,
  docs,
}: {
  text: string;
  setText: (t: string) => void;
  onSend: () => void;
  onStop: () => void;
  status: ReturnType<typeof useChat>["status"];
  mentions: Mention[];
  model: string | undefined;
  docs: boolean;
}) {
  const busy = status === "submitted" || status === "streaming";
  // `@` at the end of what's typed lists what can be mentioned (repositories, runs, changes).
  const at = /(?:^|\s)@([\w./-]*)$/.exec(text);
  const matches = at
    ? mentions.filter((m) => m.label.toLowerCase().includes((at[1] ?? "").toLowerCase())).slice(0, 6)
    : [];
  const pr = PR_URL.exec(text);
  const prKnown = pr ? mentions.some((m) => m.kind === "repo" && m.id === pr[1]) : false;
  const insert = (m: Mention) => setText(text.replace(/@([\w./-]*)$/, `@${m.label} `));

  return (
    <div className="border-t border-rule p-3">
      {matches.length ? (
        <ul
          className="mb-2 flex flex-col rounded-lg bg-sheet p-1 shadow-float ring-1 ring-rule"
          aria-label="Mention"
        >
          {matches.map((m) => (
            <li key={`${m.kind}:${m.id}`}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-hover"
                onClick={() => insert(m)}
              >
                <span className="font-mono text-[10px] text-ink-3">{m.kind}</span>
                <span className="truncate text-ink">{m.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <PromptInput
        onSubmit={() => (busy ? onStop() : onSend())}
        className="rounded-lg bg-sunken ring-1 ring-rule ring-inset focus-within:ring-signal [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none"
      >
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder={docs ? "Ask about how Teire works…" : "Ask about a repository, a run or a change…"}
            className="min-h-12 text-sm"
            aria-label="Ask Teire"
          />
        </PromptInputBody>
        {pr ? (
          <p className={cn("px-3 pb-1 font-mono text-[10px]", prKnown ? "text-proven" : "text-attention")}>
            {prKnown ? `✓ PR #${pr[2]} on ${pr[1]}` : `Teire doesn't watch ${pr[1]} for you`}
          </p>
        ) : null}
        <PromptInputFooter className="px-2 pb-2">
          <PromptInputTools>
            {!docs ? (
              <button
                type="button"
                className="rounded-md p-1 text-ink-3 hover:bg-hover hover:text-ink"
                aria-label="Mention a repository, run or change"
                title="Mention a repository, run or change"
                onClick={() => setText(`${text}${text && !text.endsWith(" ") ? " " : ""}@`)}
              >
                <AtSign className="size-3.5" aria-hidden />
              </button>
            ) : null}
            <span className="font-mono text-[10px] text-ink-3">{model} · Nebius Token Factory</span>
          </PromptInputTools>
          <PromptInputSubmit
            status={status}
            disabled={!busy && !text.trim()}
            aria-label={busy ? "Stop" : "Send"}
            className="size-7 rounded-md bg-ink text-sheet hover:bg-ink/90"
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
