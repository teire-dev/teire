import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import type * as React from "react";

/**
 * Buttons on the 3.4 tokens. Two primaries with separate jobs (plan 3.4, A5/B8):
 * - `default` is navy: every action inside the app, calm in dense screens;
 * - `cta` is the chartreuse pill with its olive edge, only at CTA size (`lg`/`xl`): Install, Scan,
 *   Sign in, Continue. Its label carries the contrast (11.7:1), its edge the 3:1 boundary.
 * Focus is one signal ring with an offset on every variant.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,box-shadow,color,transform] duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-background active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-ink text-sheet hover:bg-[color-mix(in_oklab,var(--ink),var(--sheet)_14%)]",
        cta: "bg-cta font-semibold text-cta-ink shadow-cta hover:bg-cta-hover",
        outline:
          "bg-sheet text-ink shadow-card hover:bg-hover hover:shadow-card-hover aria-expanded:bg-hover dark:bg-sunken",
        secondary: "bg-sunken text-ink hover:bg-hover aria-expanded:bg-hover",
        ghost: "text-ink-2 hover:bg-hover hover:text-ink aria-expanded:bg-hover aria-expanded:text-ink",
        destructive:
          "bg-broke-soft text-broke hover:bg-[color-mix(in_oklab,var(--broke-soft),var(--broke)_10%)] focus-visible:ring-broke",
        link: "text-link underline-offset-4 hover:underline",
        // On the navy hero band: ice-white ghost pill.
        hero: "bg-white/8 text-hero-ink shadow-[inset_0_0_0_1px_var(--hero-rule)] hover:bg-white/14",
      },
      shape: {
        default: "",
        pill: "rounded-full px-4",
      },
      size: {
        default: "h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),9px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xl: "h-11 gap-2 px-5 text-[15px] has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-[min(var(--radius-md),9px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      shape: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  shape = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, shape, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
