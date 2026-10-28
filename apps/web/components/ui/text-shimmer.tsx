import * as React from "react";
import { cn } from "@/lib/utils";

const SHIMMER_STYLES = `
@keyframes an-shimmer {
  from { background-position: 100% center; }
  to { background-position: 0% center; }
}
.an-text-shimmer {
  display: inline-block;
  background-size: 250% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  background-image: linear-gradient(
    90deg,
    var(--an-foreground-subtle, var(--ink-3)) 0%,
    var(--an-foreground-subtle, var(--ink-3)) 40%,
    var(--an-foreground-muted, var(--signal)) 50%,
    var(--an-foreground-subtle, var(--ink-3)) 60%,
    var(--an-foreground-subtle, var(--ink-3)) 100%
  );
  background-repeat: no-repeat;
}
.an-text-shimmer--active {
  animation: an-shimmer var(--an-shimmer-duration, 2s) linear infinite;
}
`;

let stylesInjected = false;
function useShimmerStyles() {
  if (typeof document === "undefined") return;
  if (stylesInjected) return;
  if (document.getElementById("an-text-shimmer-styles")) {
    stylesInjected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = "an-text-shimmer-styles";
  style.textContent = SHIMMER_STYLES;
  document.head.appendChild(style);
  stylesInjected = true;
}

export type TextShimmerProps = {
  children: React.ReactNode;
  as?: React.ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  delay?: number;
};

function TextShimmerComponent({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 100,
  delay = 0,
}: TextShimmerProps) {
  useShimmerStyles();

  const style = {
    "--an-shimmer-duration": `${duration}s`,
    "--an-shimmer-spread": `${spread}px`,
    animationDelay: delay > 0 ? `${delay}s` : undefined,
    animationDuration: `${duration}s`,
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  } as React.CSSProperties;

  return (
    <Component className={cn("an-text-shimmer", "an-text-shimmer--active", className)} style={style}>
      {children}
    </Component>
  );
}

export const TextShimmer = React.memo(TextShimmerComponent);
