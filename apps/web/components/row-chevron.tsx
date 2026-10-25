import { ChevronRight } from "lucide-react";

/** The visible cue that a whole row opens a page; a hover colour alone says nothing on a phone. */
export function RowChevron() {
  return <ChevronRight className="size-4 shrink-0 self-center text-muted-foreground" aria-hidden />;
}
