import { docsLlms } from "@/lib/source";

/** An index of every docs page for language models. */
export async function GET() {
  return new Response(await docsLlms.index(), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
