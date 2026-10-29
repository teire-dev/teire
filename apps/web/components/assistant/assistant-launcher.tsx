"use client";

import { LogoMark } from "@/components/logo";

/**
 * Ask Teire's launcher (plan revision 3.3, U4): a 44px ink pill in the bottom-right corner (toasts
 * live bottom-left), the Teire mark alone until hovered or focused, when it says what it is and its
 * shortcut. Teire's own design: the references have no corner launcher.
 */
export function AssistantLauncher({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Ask Teire (⌘I)"
      aria-keyshortcuts="Meta+I"
      className="group fixed right-4 bottom-4 z-40 flex h-11 items-center gap-0 rounded-full bg-ink pr-1.5 pl-1.5 text-sheet shadow-float outline-none transition-[gap,padding] duration-200 ease-out hover:gap-2 hover:pr-4 focus-visible:gap-2 focus-visible:pr-4 focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-canvas motion-reduce:transition-none sm:right-6 sm:bottom-6"
    >
      <LogoMark className="size-8" />
      <span className="grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-hover:grid-cols-[1fr] group-focus-visible:grid-cols-[1fr] motion-reduce:transition-none">
        <span className="flex items-center gap-2 overflow-hidden whitespace-nowrap text-sm font-medium">
          Ask Teire
          <kbd className="rounded bg-sheet/15 px-1.5 font-mono text-[11px] text-sheet/80">⌘I</kbd>
        </span>
      </span>
    </button>
  );
}
