import type { VersionScheme } from "../registry/versions";

/**
 * Teire's own changelog slicer (D65): both JS changelog parsers failed on real files
 * (cross-cutting.md §7.3), this rule sliced all nine. A version heading is an ATX heading
 * (`#`–`####`) or a setext heading (a line underlined with `---`/`===`) whose text, with link
 * syntax removed, carries a version token the ecosystem's grammar accepts. Only the most common
 * heading level counts (sub-headings like `### Bug Fixes` and stray versions in prose do not), and
 * each entry runs to the next version heading. Formats seen: release-please `## [5.23.2](…)
 * (2025-09-29)`, stripe `## 18.5.0 - 2025-08-27`, changesets `## 1.2.3`, keep-a-changelog
 * `## [1.2.3] - date`, `# 1.54.1 (October 21st, 2026)`, `## Version 5.5.1`, setext `2.34.2 (…)`.
 */
export interface ChangelogEntry {
  version: string;
  heading: string;
  body: string;
  /** Character offsets of the entry in the original text. */
  start: number;
  end: number;
}

const TOKEN = /(?:^|[\s[(/@])v?(\d+\.\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)(?=$|[\s\])(,:;]|\s-)/;

function stripLinks(text: string) {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "");
}

interface Heading {
  level: number;
  version: string;
  text: string;
  start: number;
  bodyStart: number;
}

export function versionHeadings(markdown: string, scheme: VersionScheme): Heading[] {
  const lines = markdown.split("\n");
  const out: Heading[] = [];
  let offset = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineStart = offset;
    offset += line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    let level = 0;
    let text = "";
    let bodyStart = offset;
    const atx = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    const next = lines[i + 1] ?? "";
    if (atx?.[1] && atx[2]) {
      level = atx[1].length;
      text = atx[2];
    } else if (line.trim() && /^(=+|-+)\s*$/.test(next) && next.trim().length >= 3) {
      level = next.startsWith("=") ? 1 : 2;
      text = line.trim();
      bodyStart = offset + next.length + 1;
    }
    if (!level) continue;
    const match = TOKEN.exec(stripLinks(text));
    const version = match?.[1];
    if (!version || !scheme.valid(version)) continue;
    out.push({ level, version, text: text.trim(), start: lineStart, bodyStart });
  }
  if (!out.length) return out;
  const counts = new Map<number, number>();
  for (const h of out) counts.set(h.level, (counts.get(h.level) ?? 0) + 1);
  const level = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  return out.filter((h) => h.level === level);
}

/** Entries for versions in (from, to], newest first as changelogs list them. */
export function sliceChangelog(
  markdown: string,
  scheme: VersionScheme,
  from: string,
  to: string,
): ChangelogEntry[] {
  const headings = versionHeadings(markdown, scheme);
  const entries: ChangelogEntry[] = [];
  headings.forEach((h, i) => {
    if (scheme.compare(h.version, from) <= 0 || scheme.compare(h.version, to) > 0) return;
    const end = headings[i + 1]?.start ?? markdown.length;
    entries.push({
      version: h.version,
      heading: h.text,
      body: markdown.slice(h.bodyStart, end).trim(),
      start: h.start,
      end,
    });
  });
  return entries;
}
