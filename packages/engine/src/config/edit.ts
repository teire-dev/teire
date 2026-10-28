import { parseDocument } from "yaml";
import { teireConfigSchema } from "./index";
import { CONFIG_PR_KEYS, type ConfigPrKey } from "./keys";

export { CONFIG_PR_KEYS, type ConfigPrKey } from "./keys";

/** The value as YAML wants it, or why it isn't one this key takes. */
export function configValue(
  key: ConfigPrKey,
  raw: string,
): { value: string | number | boolean } | { error: string } {
  const spec = CONFIG_PR_KEYS[key];
  const text = raw.trim();
  if (spec.kind === "enum")
    return (spec.values as readonly string[]).includes(text)
      ? { value: text }
      : { error: `${key} takes ${spec.values.join(", ")}` };
  if (spec.kind === "boolean")
    return text === "true" || text === "false"
      ? { value: text === "true" }
      : { error: `${key} takes true or false` };
  const n = Number(text);
  return Number.isInteger(n) && n >= spec.min && n <= spec.max
    ? { value: n }
    : { error: `${key} takes a whole number from ${spec.min} to ${spec.max}` };
}

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
  const before = doc.getIn(path);
  if (before === parsed.value) return { text, changed: false };
  doc.setIn(path, parsed.value);
  const checked = teireConfigSchema.safeParse(doc.toJS() ?? {});
  if (!checked.success)
    return { error: `the file wouldn't be valid: ${checked.error.issues[0]?.message ?? "schema error"}` };
  return { text: doc.toString(), changed: true };
}
