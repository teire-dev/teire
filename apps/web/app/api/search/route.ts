import { docsSearch } from "@/lib/docs-search";

/** The docs' search index (Orama), built from every page. */
export const GET = (request: Request) => docsSearch.GET(request);
