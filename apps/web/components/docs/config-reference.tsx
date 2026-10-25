import { teireConfigJsonSchema } from "@teire/engine/config";

/**
 * Every `teire.yml` key with its type, default and description, read from the JSON schema the
 * worker validates the file with (`/schema.json`), so the reference cannot drift from the code.
 */
interface Node {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, Node>;
  items?: Node;
  anyOf?: Node[];
}

function typeOf(n: Node): string {
  if (n.enum) return n.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (n.anyOf) return n.anyOf.map(typeOf).join(" | ");
  if (n.type === "array") return `${n.items ? typeOf(n.items) : "unknown"}[]`;
  return Array.isArray(n.type) ? n.type.join(" | ") : (n.type ?? "object");
}

function rows(
  props: Record<string, Node>,
  prefix = "",
): { key: string; type: string; description: string; default?: unknown }[] {
  return Object.entries(props).flatMap(([k, n]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    const item = n.type === "array" && n.items?.properties ? n.items : null;
    if (n.properties)
      return [{ key, type: "object", description: n.description ?? "" }, ...rows(n.properties, key)];
    if (item?.properties)
      return [
        { key, type: "object[]", description: n.description ?? "" },
        ...rows(item.properties, `${key}[]`),
      ];
    return [{ key, type: typeOf(n), description: n.description ?? "", default: n.default }];
  });
}

export function ConfigReference() {
  const schema = teireConfigJsonSchema as unknown as Node;
  const list = rows(schema.properties ?? {});
  return (
    <div className="not-prose my-6 overflow-x-auto rounded-lg border border-fd-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-fd-muted text-xs text-fd-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Key</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">What it does</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.key} className="border-t border-fd-border align-top">
              <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{r.key}</td>
              <td className="px-3 py-2 font-mono text-xs text-fd-muted-foreground">{r.type}</td>
              <td className="px-3 py-2 text-fd-muted-foreground">
                {r.description}
                {r.default !== undefined ? (
                  <span className="ml-1 font-mono text-xs">(default {JSON.stringify(r.default)})</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
