"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type RowSelectionState,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import type { FixMode, FixModeOrigin } from "@teire/engine/config";
import { ArrowDown, ArrowUp } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { MarkStack } from "@/components/teire/mark";
import { StatusChip, type Tone } from "@/components/teire/status-chip";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DataTableToolbar,
  DataTableToolbarBulkActions,
  DataTableToolbarClearSelection,
  DataTableToolbarColumn,
  DataTableToolbarColumns,
  DataTableToolbarExport,
  DataTableToolbarGroup,
  DataTableToolbarSearch,
  DataTableToolbarSelectionCount,
} from "@/components/ui/data-table-toolbar";
import { languageMarks } from "@/lib/marks";
import { BulkFixMode } from "./bulk-fix-mode";
import { FixModeControl } from "./fix-mode-control";

export interface RepoTableRow {
  id: number;
  fullName: string;
  isPrivate: boolean;
  languages: string[];
  fixMode: { mode: FixMode; origin: FixModeOrigin; file: string | null };
  state: { label: string; tone: Tone; why?: string };
  affected: number;
  openPrs: number;
  needsYou: number;
  lastScannedAt: string | null;
}

const ago = (iso: string | null) => {
  if (!iso) return "not yet";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 3600
    ? `${Math.round(s / 60)} min ago`
    : s < 86_400
      ? `${Math.round(s / 3600)} h ago`
      : `${Math.round(s / 86_400)} d ago`;
};

const LABELS: Record<string, string> = {
  fullName: "Repository",
  fixMode: "Fix mode",
  state: "State",
  affected: "Reaching code",
  openPrs: "Open PRs",
  needsYou: "Needs you",
  lastScannedAt: "Scanned",
};

/**
 * The Repositories table (plan revision 3.3, U3: TanStack Table with 21st's Data Table Toolbar): sortable
 * columns, search, column visibility, CSV export of the rows shown, and rows selected for "Set fix
 * mode…" in the bulk bar. The fix mode changes in place in its cell.
 */
export function ReposTable({ rows }: { rows: RepoTableRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [visibility, setVisibility] = useState<VisibilityState>({});
  const columns = useMemo<ColumnDef<RepoTableRow>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        enableHiding: false,
        header: ({ table }) => (
          <Checkbox
            aria-label="Select every repository shown"
            checked={
              table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? "indeterminate" : false
            }
            onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={`Select ${row.original.fullName}`}
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(!!v)}
          />
        ),
      },
      {
        accessorKey: "fullName",
        header: LABELS.fullName,
        cell: ({ row }) => (
          <Link href={`/app/repos/${row.original.fullName}`} className="flex min-w-0 items-center gap-2">
            <MarkStack brands={languageMarks(row.original.languages)} />
            <span className="truncate font-mono text-xs text-ink hover:underline">
              {row.original.fullName}
            </span>
            {row.original.isPrivate ? <span className="text-[10px] text-ink-3">private</span> : null}
          </Link>
        ),
      },
      {
        id: "fixMode",
        accessorFn: (r) => r.fixMode.mode,
        header: LABELS.fixMode,
        cell: ({ row }) => (
          <FixModeControl
            repo={row.original.fullName}
            mode={row.original.fixMode.mode}
            origin={row.original.fixMode.origin}
            file={row.original.fixMode.file}
          />
        ),
      },
      {
        id: "state",
        accessorFn: (r) => r.state.label,
        header: LABELS.state,
        cell: ({ row }) => (
          <span className="flex flex-col gap-0.5">
            <StatusChip tone={row.original.state.tone}>{row.original.state.label}</StatusChip>
            {row.original.state.why ? (
              <span className="text-[11px] text-ink-3">{row.original.state.why}</span>
            ) : null}
          </span>
        ),
      },
      {
        accessorKey: "affected",
        header: LABELS.affected,
        cell: ({ row }) => (
          <Link
            href={`/app/repos/${row.original.fullName}/findings`}
            className={`font-mono text-xs tabular-nums ${row.original.affected ? "text-ink" : "text-ink-3"}`}
          >
            {row.original.affected}
          </Link>
        ),
      },
      {
        accessorKey: "openPrs",
        header: LABELS.openPrs,
        cell: ({ row }) => (
          <Link
            href={`/app/repos/${row.original.fullName}/prs`}
            className={`font-mono text-xs tabular-nums ${row.original.openPrs ? "text-ink" : "text-ink-3"}`}
          >
            {row.original.openPrs}
          </Link>
        ),
      },
      {
        accessorKey: "needsYou",
        header: LABELS.needsYou,
        cell: ({ row }) => (
          <Link
            href={`/app/runs?show=needs-you&repo=${encodeURIComponent(row.original.fullName)}`}
            className={`font-mono text-xs tabular-nums ${row.original.needsYou ? "text-attention" : "text-ink-3"}`}
          >
            {row.original.needsYou}
          </Link>
        ),
      },
      {
        accessorKey: "lastScannedAt",
        header: LABELS.lastScannedAt,
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-ink-3" title={row.original.lastScannedAt ?? undefined}>
            {ago(row.original.lastScannedAt)}
          </span>
        ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: search, rowSelection: selection, columnVisibility: visibility },
    getRowId: (r) => r.fullName,
    onSortingChange: setSorting,
    onRowSelectionChange: setSelection,
    onColumnVisibilityChange: setVisibility,
    onGlobalFilterChange: setSearch,
    globalFilterFn: (row, _id, value: string) =>
      row.original.fullName.toLowerCase().includes(value.toLowerCase()),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  const selected = Object.keys(selection).filter((k) => selection[k]);
  const shown = table.getRowModel().rows.map((r) => r.original);
  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide());
  // The rows shown, as a CSV the person saves (the toolbar's Export).
  const exportCsv = () => {
    const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [
      ["repository", "fix_mode", "state", "reaching_code", "open_prs", "needs_you", "last_scanned"].join(","),
      ...shown.map((r) =>
        [r.fullName, r.fixMode.mode, r.state.label, r.affected, r.openPrs, r.needsYou, r.lastScannedAt ?? ""]
          .map(cell)
          .join(","),
      ),
    ];
    const url = URL.createObjectURL(new Blob([`${lines.join("\n")}\n`], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "teire-repositories.csv" });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-3">
      <DataTableToolbar
        search={search}
        onSearchChange={setSearch}
        selectedCount={selected.length}
        onClearSelection={() => setSelection({})}
      >
        <DataTableToolbarGroup>
          <DataTableToolbarSearch placeholder="Search repositories" label="Search repositories" />
          <DataTableToolbarColumns
            value={hideable.filter((c) => c.getIsVisible()).map((c) => c.id)}
            onValueChange={(ids) =>
              setVisibility(Object.fromEntries(hideable.map((c) => [c.id, ids.includes(c.id)])))
            }
          >
            {hideable.map((c) => (
              <DataTableToolbarColumn key={c.id} value={c.id}>
                {LABELS[c.id] ?? c.id}
              </DataTableToolbarColumn>
            ))}
          </DataTableToolbarColumns>
          <DataTableToolbarExport onClick={exportCsv} />
        </DataTableToolbarGroup>
        <DataTableToolbarBulkActions>
          <DataTableToolbarSelectionCount />
          <BulkFixMode repos={selected} />
          <DataTableToolbarClearSelection />
        </DataTableToolbarBulkActions>
      </DataTableToolbar>
      <div className="overflow-x-auto rounded-xl bg-sheet shadow-card">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            {table.getHeaderGroups().map((g) => (
              <tr key={g.id} className="border-b border-rule text-left">
                {g.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                      }
                      className="eyebrow px-4 py-2.5 font-normal"
                    >
                      {h.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={h.column.getToggleSortingHandler()}
                          className="flex items-center gap-1 hover:text-ink"
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === "asc" ? (
                            <ArrowUp className="size-3" aria-hidden />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="size-3" aria-hidden />
                          ) : null}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-rule">
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                data-state={row.getIsSelected() ? "selected" : undefined}
                className="hover:bg-hover data-[state=selected]:bg-signal-soft/40"
              >
                {row.getVisibleCells().map((c) => (
                  <td key={c.id} className="px-4 py-2">
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length ? (
          <p className="px-4 py-8 text-center text-sm text-ink-3">No repository matches “{search}”.</p>
        ) : null}
      </div>
    </div>
  );
}
