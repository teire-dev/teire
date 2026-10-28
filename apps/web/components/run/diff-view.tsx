/**
 * A unified diff (the run's `diff`, one createTwoFilesPatch per file) as file blocks: path, +/−
 * counts, and red/green rows at a 10–15% fill with solid gutters (design ledger: diff colours).
 */
interface FileDiff {
  path: string;
  lines: { kind: "add" | "del" | "hunk" | "ctx"; text: string }[];
  added: number;
  removed: number;
}

export function parseDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  // A deleted file's `+++` is /dev/null: its path is the `---` line's.
  let from = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("Index: ") || /^=+$/.test(line)) continue;
    if (line.startsWith("--- ")) {
      from = line.slice(4).replace(/^a\//, "").trim();
      continue;
    }
    if (line.startsWith("+++ ")) {
      const to = line.slice(4).trim();
      current = { path: to === "/dev/null" ? from : to.replace(/^b\//, ""), lines: [], added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) current.lines.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) {
      current.lines.push({ kind: "add", text: line.slice(1) });
      current.added++;
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "del", text: line.slice(1) });
      current.removed++;
    } else if (line.startsWith("\\")) continue;
    else current.lines.push({ kind: "ctx", text: line.slice(1) });
  }
  return files.filter((f) => f.lines.length);
}

const ROW = {
  add: "bg-clear-soft text-clear",
  del: "bg-affected-soft text-affected",
  hunk: "bg-muted text-muted-foreground",
  ctx: "",
} as const;
const MARK = { add: "+", del: "−", hunk: "", ctx: " " } as const;

export function DiffView({ patch, maxLines = 400 }: { patch: string | null; maxLines?: number }) {
  const files = patch ? parseDiff(patch) : [];
  if (!files.length) return <p className="text-sm text-muted-foreground">No code changed.</p>;
  let budget = maxLines;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
        <span className="text-clear">+{files.reduce((n, f) => n + f.added, 0)}</span>{" "}
        <span className="text-affected">−{files.reduce((n, f) => n + f.removed, 0)}</span>
      </p>
      {/* The files, by folder, each a jump to its diff (the plan's file tree). */}
      {files.length > 1 ? (
        <ul className="flex flex-col gap-0.5 rounded-md bg-sunken p-2 font-mono text-[11px] ring-1 ring-rule ring-inset">
          {files.map((f, i) => {
            const at = f.path.lastIndexOf("/");
            return (
              <li key={f.path}>
                <a
                  href={`#diff-${i}`}
                  className="flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-ink-3">{at > 0 ? f.path.slice(0, at + 1) : ""}</span>
                    <span className="text-ink">{f.path.slice(at + 1)}</span>
                  </span>
                  <span className="text-clear">+{f.added}</span>
                  <span className="text-affected">−{f.removed}</span>
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
      {files.map((f, i) => {
        const shown = f.lines.slice(0, Math.max(0, budget));
        budget -= shown.length;
        return (
          <div
            key={f.path}
            id={`diff-${i}`}
            className="scroll-mt-20 overflow-hidden rounded-md border font-mono text-xs"
          >
            <div className="flex items-center justify-between gap-3 border-b bg-muted/60 px-3 py-1.5">
              <span className="truncate">{f.path}</span>
              <span className="shrink-0">
                <span className="text-clear">+{f.added}</span>{" "}
                <span className="text-affected">−{f.removed}</span>
              </span>
            </div>
            <pre className="overflow-x-auto leading-5">
              {shown.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a static diff; line order is the identity
                <span key={`${f.path}-${i}`} className={`block px-3 ${ROW[l.kind]}`}>
                  <span className="mr-3 inline-block w-3 select-none opacity-60">{MARK[l.kind]}</span>
                  {l.text || " "}
                </span>
              ))}
              {shown.length < f.lines.length ? (
                <span className="block px-3 py-1 text-muted-foreground">
                  … {f.lines.length - shown.length} more lines
                </span>
              ) : null}
            </pre>
          </div>
        );
      })}
    </div>
  );
}
