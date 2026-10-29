"use client";

import type { ToolUIPart } from "ai";
import { Check, ChevronDown, X } from "lucide-react";
import type { ComponentProps } from "react";
import { LiveDot } from "@/components/teire/live-dot";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * AI Elements' tool block in Teire's step-row grammar (plan revision 3.3, U4): one mono line per tool
 * step, present tense with the live dot while it works ("Reading teire-dev/nlsh findings…"), past
 * tense with a check when done ("Read 6 findings"); the result's card opens below it.
 */
export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("not-prose group/tool flex w-full flex-col gap-2", className)} {...props} />
);

export type ToolHeaderProps = {
  title: string;
  state: ToolUIPart["state"];
  /** Whether there is a card to open; without one the row is a plain line. */
  expandable?: boolean;
  className?: string;
};

const working = (s: ToolUIPart["state"]) => s === "input-streaming" || s === "input-available";
const failed = (s: ToolUIPart["state"]) => s === "output-error" || s === "output-denied";

export const ToolHeader = ({ className, title, state, expandable = true }: ToolHeaderProps) => {
  const icon = working(state) ? (
    <LiveDot label="Working" />
  ) : failed(state) ? (
    <X className="size-3 text-broke" aria-hidden />
  ) : (
    <Check className="size-3 text-ink-2" aria-hidden />
  );
  const line = (
    <>
      <span className="flex size-3 items-center justify-center">{icon}</span>
      <span className={cn("truncate", working(state) && "text-ink-2")}>{title}</span>
    </>
  );
  if (!expandable)
    return (
      <div className={cn("flex items-center gap-2 font-mono text-[11px] text-ink-3", className)}>{line}</div>
    );
  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-2 rounded font-mono text-[11px] text-ink-3 hover:text-ink-2",
        className,
      )}
    >
      {line}
      <ChevronDown
        className="ml-auto size-3 shrink-0 transition-transform group-data-[state=open]/tool:rotate-180"
        aria-hidden
      />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in motion-reduce:animate-none",
      className,
    )}
    {...props}
  />
);
