"use client";
// 21st.dev Data Table Toolbar (skovhm, component 39966), adapted to Teire's tokens (plan revision 3.3, U3).

import { cva } from "class-variance-authority";
import { Columns3, Download, Search, X } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export const DATA_TABLE_TOOLBAR_VARIANTS = ["toolbar", "stacked", "compact"] as const;
export type DataTableToolbarVariant = (typeof DATA_TABLE_TOOLBAR_VARIANTS)[number];
export type DataTableToolbarProps = ComponentProps<"div"> & {
  variant?: DataTableToolbarVariant;
  search?: string;
  defaultSearch?: string;
  onSearchChange?: (search: string) => void;
  selectedCount?: number;
  onClearSelection?: () => void;
};

type ToolbarContext = {
  id: string;
  variant: DataTableToolbarVariant;
  search: string;
  setSearch: (search: string) => void;
  selectedCount: number;
  onClearSelection?: () => void;
};
const Context = createContext<ToolbarContext | null>(null);
function useToolbar(part: string) {
  const context = useContext(Context);
  if (!context) throw new Error(`${part} must be used within DataTableToolbar`);
  return context;
}

type ColumnsContext = {
  value: string[];
  toggle: (column: string, visible: boolean) => void;
};
const ColumnsCtx = createContext<ColumnsContext | null>(null);

const easeOut = "cubic-bezier(0.23, 1, 0.32, 1)";
// Secondary pill on the shadcn Button: raised fill, lighter on hover, a small press.
const controlVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-full border-0 bg-secondary py-0 font-medium whitespace-nowrap text-foreground transition-[background-color,scale] duration-[120ms,140ms] ease-[ease-out,cubic-bezier(0.23,1,0.32,1)] hover:bg-[color-mix(in_oklab,var(--secondary)_85%,var(--foreground))] focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-[color-mix(in_oklab,var(--secondary)_85%,var(--foreground))] motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg:not([class*='size-'])]:size-3.5 [&>svg]:text-muted-foreground",
  {
    variants: {
      variant: {
        toolbar: "h-7 px-3 text-[12.5px]/[18px] has-[>svg]:px-3",
        stacked: "h-7 px-3 text-[12.5px]/[18px] has-[>svg]:px-3",
        compact: "h-6 px-2.5 text-[12px]/[18px] has-[>svg]:px-2.5",
      },
    },
  },
);

const dataTableToolbarVariants = cva("flex min-w-0 text-[13px]/[18px] text-foreground", {
  variants: {
    variant: {
      toolbar: "flex-row flex-wrap items-center gap-2 rounded-[14px] border bg-card p-2",
      stacked:
        "flex-col flex-nowrap items-stretch gap-2 rounded-[14px] border-0 bg-background p-2.5 inset-ring-1 inset-ring-border",
      compact: "flex-row flex-wrap items-center gap-1.5 rounded-xl border bg-card p-1.5",
    },
  },
});

export function DataTableToolbar({
  variant = "toolbar",
  search,
  defaultSearch = "",
  onSearchChange,
  selectedCount = 0,
  onClearSelection,
  className,
  children,
  ...props
}: DataTableToolbarProps) {
  const id = useId();
  const [internal, setInternal] = useState(defaultSearch);
  const context: ToolbarContext = {
    id,
    variant,
    search: search ?? internal,
    setSearch: (next) => {
      if (search === undefined) setInternal(next);
      onSearchChange?.(next);
    },
    selectedCount,
    onClearSelection,
  };
  return (
    <Context.Provider value={context}>
      <div
        role="group"
        aria-label="Table controls"
        data-slot="data-table-toolbar"
        data-variant={variant}
        className={cn(dataTableToolbarVariants({ variant }), className)}
        {...props}
      >
        {children}
        <span role="status" className="sr-only">
          {selectedCount > 0 ? `${selectedCount} selected` : ""}
        </span>
      </div>
    </Context.Provider>
  );
}

export function DataTableToolbarGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="data-table-toolbar-group"
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
      {...props}
    />
  );
}

export function DataTableToolbarSearch({
  label = "Search rows",
  className,
  onChange,
  onKeyDown,
  ...props
}: Omit<ComponentProps<"input">, "value" | "defaultValue" | "type"> & {
  label?: string;
}) {
  const context = useToolbar("DataTableToolbarSearch");
  const inputRef = useRef<HTMLInputElement>(null);
  const compact = context.variant === "compact";
  return (
    <div
      data-slot="data-table-toolbar-search"
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-full border border-transparent [transition:border-color_120ms_ease-out,background-color_120ms_ease-out] focus-within:border-rule-strong motion-reduce:transition-none",
        compact ? "h-6 pr-0.75 pl-[9px]" : "pr-1 pl-[11px]",
        context.variant === "stacked"
          ? "h-8 flex-[0_0_auto] bg-card"
          : cn("flex-[1_1_200px] bg-muted", !compact && "h-7"),
      )}
    >
      <Search size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3 size-3.5" />
      <Input
        aria-label={label}
        data-slot="data-table-toolbar-search-input"
        className={cn(
          "h-auto w-full min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-inherit shadow-none outline-none placeholder:text-ink-3 focus-visible:ring-0 dark:bg-transparent [&::-webkit-search-cancel-button]:hidden",
          compact
            ? "text-[12px]/[18px] md:text-[12px]/[18px]"
            : "text-[12.5px]/[18px] md:text-[12.5px]/[18px]",
          className,
        )}
        {...props}
        ref={inputRef}
        type="search"
        id={`${context.id}-search`}
        value={context.search}
        onChange={(event) => {
          onChange?.(event);
          if (!event.defaultPrevented) context.setSearch(event.target.value);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented && event.key === "Escape" && context.search) {
            event.preventDefault();
            context.setSearch("");
          }
        }}
      />
      {context.search ? (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label="Clear search"
          onClick={() => {
            context.setSearch("");
            inputRef.current?.focus();
          }}
          className={cn(
            controlVariants({ variant: context.variant }),
            "size-5 p-0 has-[>svg]:p-0 [&_svg:not([class*='size-'])]:size-3",
            "animate-in fade-in-0 zoom-in-75 duration-150 ease-out-quint motion-reduce:animate-none",
          )}
        >
          <X size={12} className="size-3" strokeWidth={2} aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

export function DataTableToolbarButton({ className, ...props }: ComponentProps<"button">) {
  const context = useToolbar("DataTableToolbarButton");
  return (
    <Button
      data-slot="data-table-toolbar-button"
      variant="secondary"
      className={cn(controlVariants({ variant: context.variant }), className)}
      {...props}
      type="button"
    />
  );
}

export function DataTableToolbarExport({ children = "Export", ...props }: ComponentProps<"button">) {
  return (
    <DataTableToolbarButton data-slot="data-table-toolbar-export" {...props}>
      <Download size={14} className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
      {children}
    </DataTableToolbarButton>
  );
}

export type DataTableToolbarColumnsProps = Omit<ComponentProps<"div">, "defaultValue"> & {
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  label?: string;
};

export function DataTableToolbarColumns({
  value,
  defaultValue = [],
  onValueChange,
  label = "Columns",
  children,
  className,
  ...props
}: DataTableToolbarColumnsProps) {
  const context = useToolbar("DataTableToolbarColumns");
  const [internal, setInternal] = useState(defaultValue);
  const panelId = `${context.id}-columns`;
  const visible = value ?? internal;

  const columns: ColumnsContext = {
    value: visible,
    toggle: (column, show) => {
      const next = show ? [...visible, column] : visible.filter((item) => item !== column);
      if (value === undefined) setInternal(next);
      onValueChange?.(next);
    },
  };

  return (
    <ColumnsCtx.Provider value={columns}>
      <div data-slot="data-table-toolbar-columns" className={cn("relative", className)} {...props}>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              className={controlVariants({ variant: context.variant })}
            >
              <Columns3 size={14} className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              {label}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            id={panelId}
            align="end"
            sideOffset={6}
            aria-label={`Visible ${label.toLowerCase()}`}
            className="w-auto min-w-[184px] rounded-[14px] border-0 bg-popover p-1 text-[13px]/[18px] text-popover-foreground shadow-float data-[side=bottom]:slide-in-from-top-0 data-[side=left]:slide-in-from-right-0 data-[side=right]:slide-in-from-left-0 data-[side=top]:slide-in-from-bottom-0 data-[state=open]:zoom-in-96 data-open:zoom-in-96 data-[state=open]:duration-180 data-open:duration-180 data-[state=open]:ease-[cubic-bezier(0.16,1,0.3,1)] data-open:ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none"
          >
            <fieldset className="m-0 grid min-w-0 gap-px border-0 p-0">
              <legend className="sr-only">{`Visible ${label.toLowerCase()}`}</legend>
              {children}
            </fieldset>
          </PopoverContent>
        </Popover>
      </div>
    </ColumnsCtx.Provider>
  );
}

export function DataTableToolbarColumn({
  value,
  children,
  disabled,
  className,
}: {
  value: string;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const columns = useContext(ColumnsCtx);
  if (!columns) throw new Error("DataTableToolbarColumn must be used within DataTableToolbarColumns");
  return (
    <Label
      data-slot="data-table-toolbar-column"
      className={cn(
        "flex min-h-[30px] items-center gap-2 rounded-lg px-2 py-1 text-[13px] leading-[18px] font-medium select-auto",
        disabled
          ? "cursor-default opacity-45"
          : "cursor-pointer [transition:background-color_120ms_ease-out] hover:bg-accent motion-reduce:transition-none",
        className,
      )}
    >
      <Checkbox
        disabled={disabled}
        checked={columns.value.includes(value)}
        onCheckedChange={(checked) => columns.toggle(value, checked === true)}
        className="m-0 size-3.5 border-ink-3 data-[state=checked]:border-primary data-checked:border-primary shadow-none focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid disabled:cursor-default disabled:opacity-100 [&_svg]:size-3"
      />
      {children}
    </Label>
  );
}

export function DataTableToolbarBulkActions({ className, children, ...props }: ComponentProps<"div">) {
  const context = useToolbar("DataTableToolbarBulkActions");
  const visible = context.selectedCount > 0;
  const ref = useRef<HTMLDivElement>(null);
  // Fade the bar in when a selection starts.
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!visible || !bar || typeof bar.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    bar.animate(
      [
        { opacity: 0, transform: "translateY(-4px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 220, easing: easeOut },
    );
  }, [visible]);
  // Stay mounted while the exit animation plays; reduced motion has none, so unmount at once.
  const [rendered, setRendered] = useState(visible);
  if (visible && !rendered) setRendered(true);
  useEffect(() => {
    if (visible) return;
    const bar = ref.current;
    const animation = bar ? window.getComputedStyle(bar).animationName : "";
    if (!animation || animation === "none") setRendered(false);
  }, [visible]);
  if (!visible && !rendered) return null;
  return (
    <div
      role="group"
      aria-label="Bulk actions"
      data-slot="data-table-toolbar-bulk-actions"
      data-state={visible ? "open" : "closed"}
      aria-hidden={visible ? undefined : true}
      inert={!visible}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1.5 rounded-full bg-primary/12 inset-ring-1 inset-ring-primary/22",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=closed]:duration-150 data-[state=closed]:ease-out data-[state=closed]:fill-mode-forwards motion-reduce:animate-none",
        context.variant === "stacked" ? "basis-auto" : "basis-full",
        context.variant === "compact" ? "py-0.75 pr-0.75 pl-2.5" : "py-1 pr-1 pl-3",
        className,
      )}
      {...props}
      ref={ref}
      onAnimationEnd={(event) => {
        props.onAnimationEnd?.(event);
        if (event.target === event.currentTarget && !visible) setRendered(false);
      }}
    >
      {children}
    </div>
  );
}

export function DataTableToolbarSelectionCount({ className, children, ...props }: ComponentProps<"span">) {
  const context = useToolbar("DataTableToolbarSelectionCount");
  return (
    <span
      data-slot="data-table-toolbar-selection-count"
      className={cn("mr-auto text-[12.5px] font-medium text-foreground tabular-nums", className)}
      {...props}
      aria-hidden="true"
    >
      {children ?? `${context.selectedCount} selected`}
    </span>
  );
}

export function DataTableToolbarClearSelection({
  children = "Clear selection",
  onClick,
  ...props
}: ComponentProps<"button">) {
  const context = useToolbar("DataTableToolbarClearSelection");
  return (
    <DataTableToolbarButton
      data-slot="data-table-toolbar-clear-selection"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context.onClearSelection?.();
      }}
    >
      {children}
    </DataTableToolbarButton>
  );
}

export default DataTableToolbar;
