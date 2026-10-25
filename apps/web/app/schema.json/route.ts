import { teireConfigJsonSchema } from "@teire/engine/config";

/**
 * The JSON Schema of `.github/teire.yml` (card C8): editors validate against it through
 * `# yaml-language-server: $schema=https://teire.vercel.app/schema.json`. Generated from the same
 * zod schema the worker reads the file with, so the two never disagree.
 */
export const dynamic = "force-static";

export function GET() {
  return Response.json(teireConfigJsonSchema, {
    headers: { "cache-control": "public, max-age=3600, s-maxage=86400" },
  });
}
