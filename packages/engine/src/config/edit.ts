import { parseDocument } from "yaml";
import { teireConfigSchema } from "./index";
import { type ConfigPrKey, configValue } from "./keys";

export { CONFIG_PR_KEYS, type ConfigPrKey, configValue } from "./keys";

/**
 * `teire.yml` with one key set, its comments and the rest of the file kept: the document is edited in
 * place, then the whole file is checked against the schema so a PR never carries an invalid config.
 */
export function setConfigKey(
  text: string,
  key: ConfigPrKey,
  raw: string,
): { text: string; changed: boolean } | { error: string } {
  const parsed = configValue(key, raw);
  if ("error" in parsed) return parsed;
  const doc = parseDocument(text);
  if (doc.errors.length)
    return { error: `teire.yml doesn't parse: ${doc.errors[0]?.message ?? "a YAML error"}` };
  const path = key.split(".");
  // A parent that isn't a mapping (`upgrades: true`) or an alias can't take the key (U3 review).
  try {
    const before = doc.getIn(path);
    const same = Array.isArray(parsed.value)
      ? JSON.stringify(
          (doc.getIn(path, false) as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? null,
        ) === JSON.stringify(parsed.value)
      : before === parsed.value;
    if (same) return { text, changed: false };
    const others = (js: unknown) => {
      const copy = structuredClone(js ?? {}) as Record<string, unknown>;
      let at: Record<string, unknown> | undefined = copy;
      for (const part of path.slice(0, -1))
        at = at && typeof at[part] === "object" ? (at[part] as Record<string, unknown>) : undefined;
      if (at) delete at[path.at(-1) as string];
      return JSON.stringify(copy);
    };
    const rest = others(doc.toJS());
    doc.setIn(path, parsed.value);
    // Every other setting must read the same after the edit: an anchor shared with another key
    // (`fixes: &a automatic` … `securityFixes: *a`) would change both (U4 review).
    if (others(doc.toJS()) !== rest)
      return {
        error: `${key} shares its value with another setting through a YAML anchor in this file; change it by hand`,
      };
  } catch (error) {
    return {
      error: `${key} can't be set in this file (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const checked = teireConfigSchema.safeParse(doc.toJS() ?? {});
  if (!checked.success)
    return { error: `the file wouldn't be valid: ${checked.error.issues[0]?.message ?? "schema error"}` };
  return { text: doc.toString(), changed: true };
}

/** Whether a `teire.yml` text parses and passes the schema (the starter replaces only one that doesn't). */
export function isValidConfigText(text: string) {
  const doc = parseDocument(text);
  return !doc.errors.length && teireConfigSchema.safeParse(doc.toJS() ?? {}).success;
}
