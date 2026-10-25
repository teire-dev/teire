import type { SurfaceChange, SurfaceChangeKind, SymbolKind } from "./types";

/**
 * cargo-semver-checks reports (plan S06, research rust.md Job 4): text only (its issue #6 for JSON
 * has been open since 2022), as blocks:
 *
 *   --- failure inherent_method_missing: pub method removed or renamed ---
 *   …description…
 *   Failed in:
 *     Client::assistants, previously in file /…/src/client.rs:264
 *     mod async_openai::types::assistants, previously in file …/mod.rs:1
 *     feature assistant in the package's Cargo.toml
 *
 * Each "Failed in" line becomes one change keyed by its Rust path, the key the locator searches for.
 * `--release-type minor` is always passed, or a 0.x bump reports nothing (verified in the research).
 */
const LINT_KIND: [RegExp, SurfaceChangeKind, SymbolKind][] = [
  [
    /^(?:function|inherent_method|trait_method|struct|enum|union|trait|module|constant|static|type_alias|macro|declarative_macro|proc_macro|struct_pub_field|enum_variant|feature|exported_function|pub_module_level_const)[a-z_]*_missing$/,
    "removed",
    "unknown",
  ],
  [/parameter_count_changed|method_parameter_count_changed/, "arity-changed", "function"],
  [/requires_different_generic_type_params|generic_type_param|generic_lifetime/, "signature-changed", "type"],
  [
    /constructible_struct_adds_field|struct_pub_field_now_doc_hidden|trait_added_supertrait|trait_method_added|trait_newly_sealed|pub_api_sealed_trait_became_unconditionally_sealed|unit_struct_changed_kind|struct_marked_non_exhaustive|enum_marked_non_exhaustive|enum_variant_added/,
    "required-added",
    "type",
  ],
  [/now_doc_hidden|deprecated/, "deprecated", "unknown"],
];

function kindOf(lint: string): { kind: SurfaceChangeKind; symbolKind: SymbolKind } {
  for (const [re, kind, symbolKind] of LINT_KIND)
    if (re.test(lint)) {
      const sk: SymbolKind =
        lint.startsWith("inherent_method") || lint.startsWith("trait_method")
          ? "method"
          : lint.startsWith("function") || lint.startsWith("exported_function")
            ? "function"
            : lint.startsWith("module")
              ? "module"
              : lint.startsWith("struct_pub_field")
                ? "property"
                : lint.startsWith("trait")
                  ? "interface"
                  : lint.startsWith("struct") || lint.startsWith("enum") || lint.startsWith("union")
                    ? "class"
                    : symbolKind;
      return { kind, symbolKind: sk };
    }
  return { kind: "signature-changed", symbolKind: "unknown" };
}

/**
 * The item a "Failed in" line names, as a Rust path: `Client::assistants, previously in file …`,
 * `mod a::b, …`, `method choose of trait SliceRandom, …` (→ `SliceRandom::choose`),
 * `trait method rand::Fill::fill_slice in file …`, `associated type SliceRandom::Item, …`,
 * `type StdRng no longer derives Clone, …`, `feature x in the package's Cargo.toml`.
 */
function itemOf(line: string) {
  const text = line.trim();
  const feature = /^feature (\S+) in the package's Cargo\.toml/.exec(text);
  if (feature?.[1]) return { path: `feature:${feature[1]}`, isFeature: true };
  const ofTrait = /^(?:method|associated (?:type|constant|const)) (\S+?),? of trait (\S+?)[,\s]/.exec(
    `${text} `,
  );
  if (ofTrait?.[1] && ofTrait[2]) return { path: `${ofTrait[2]}::${ofTrait[1]}`, isFeature: false };
  const m =
    /^(?:(?:trait method|associated type|associated constant|associated const|mod|struct|enum|trait|fn|function|type|macro|const|static|union|variant|field)\s+)?([^,\s]+(?:<[^>]*>)?)(?:,|\s|$)/.exec(
      text,
    );
  return m?.[1] ? { path: m[1].replace(/<.*>$/, ""), isFeature: false } : null;
}

export function parseSemverChecks(output: string): SurfaceChange[] {
  const changes: SurfaceChange[] = [];
  const blocks = output.split(/^--- failure /m).slice(1);
  for (const block of blocks) {
    const head = /^(\S+): (.*?) ---$/m.exec(block);
    if (!head?.[1]) continue;
    const lint = head[1];
    const { kind, symbolKind } = kindOf(lint);
    const failed = block.split(/^Failed in:\s*$/m)[1] ?? "";
    for (const raw of failed.split("\n")) {
      // Items are indented two spaces; cargo's right-aligned status lines (`     Summary …`) end the list.
      if (!/^ {2}\S/.test(raw)) {
        if (raw.trim() === "") continue;
        break;
      }
      const item = itemOf(raw);
      if (!item || changes.some((c) => c.path === item.path && c.guidance?.startsWith(`${lint}:`))) continue;
      changes.push({
        path: item.path,
        declKey: item.path,
        kind,
        symbolKind: item.isFeature ? "module" : symbolKind,
        severity: kind === "deprecated" ? "deprecation" : kind === "signature-changed" ? "drift" : "breaking",
        before: null,
        after: null,
        guidance: `${lint}: ${head[2] ?? ""}`,
      });
    }
  }
  return changes;
}

/** Features removed between two versions (research rust.md Job 4b): they break `cargo add` and the build. */
export function removedFeatures(before: Record<string, unknown>, after: Record<string, unknown>) {
  return Object.keys(before).filter((f) => !(f in after) && !f.startsWith("_"));
}
