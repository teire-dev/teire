"use client";

import { useEffect, useState } from "react";

/**
 * The one client-side docs search (plan revision 3.4, V6): ⌘K and the signed-out docs panel both ask
 * `/api/search` (the same Orama index Ask Teire's `searchDocs` reads) through this hook, with the same
 * debounce, the same filter and the same cleaned text. Works outside the app's query provider.
 */
export interface DocHit {
  id: string;
  type: "page" | "heading" | "text";
  content: string;
  breadcrumbs?: string[];
  url: string;
}

const cache = new Map<string, DocHit[]>();

/** A hit's words without markup, table pipes or rules. */
export function hitText(h: Pick<DocHit, "content">) {
  return h.content
    .replace(/<[^>]+>/g, "")
    .replace(/\|/g, " ")
    .replace(/-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Pages and headings first; a text hit only when it reads as a sentence, not a table row or code.
const readable = (h: DocHit) =>
  h.type !== "text" || (h.content.length > 20 && !/^\s*(\||```|-{3})/.test(h.content));

export function useDocsSearch(query: string, { enabled = true, limit = 6 } = {}) {
  const q = query.trim();
  const [hits, setHits] = useState<DocHit[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!enabled || q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    const known = cache.get(q);
    if (known) {
      setHits(known.slice(0, limit));
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const t = setTimeout(() => {
      fetch(`/api/search?query=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then(async (r) => (r.ok ? ((await r.json()) as DocHit[]) : []))
        .then((all) => {
          const found = all.filter(readable);
          cache.set(q, found);
          setHits(found.slice(0, limit));
          setSearching(false);
        })
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, enabled, limit]);
  return { hits, searching };
}
