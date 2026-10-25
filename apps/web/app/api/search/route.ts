import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

/** The docs' search index (Orama), built from every page. */
export const { GET } = createFromSource(source);
