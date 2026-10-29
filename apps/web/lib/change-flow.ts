import type { ChangeV2 } from "@teire/engine/contract";
import { ecosystemOf, STACK } from "./brands";
import type { FlowGraph } from "./flow/model";
import { providerLogo } from "./logos";
import { until } from "./time";

/**
 * A change's life as a flow (plan revision 3.4, V5): its source, what changes, the date, your code,
 * the fix. The change page draws it and its link preview (`/og/change/…`) draws the same tiles.
 */
export function changeLife(record: ChangeV2, names: Record<string, string>) {
  const a = record.applicability;
  const provider = record.subject.provider ?? null;
  const eco = ecosystemOf(record.subject.ecosystem);
  const logo = provider ? providerLogo(provider) : eco ? { light: eco.light, dark: eco.dark } : null;
  const ownerHref = provider
    ? `/providers/${provider}`
    : record.subject.ecosystem
      ? `/packages/${record.subject.ecosystem}/${encodeURIComponent(record.subject.name)}`
      : null;
  const ownerName = provider ? (names[provider] ?? provider) : record.subject.name;
  const from = record.signatures.find((s) => s.kind === "string-literal")?.value ?? a.fromVersion ?? null;

  const host = record.sources[0] ? new URL(record.sources[0].url).host : null;
  const when = a.effectiveOn ?? null;
  const graph: FlowGraph = {
    tiles: [
      {
        id: "source",
        entity: "change",
        state:
          record.status === "quarantined"
            ? "failed"
            : record.status === "candidate"
              ? "not_proven"
              : "proven",
        label: host ?? "Its source",
        meta:
          record.status === "quarantined"
            ? "quote failed"
            : record.status === "candidate"
              ? "computed"
              : "quote checked",
        ...(logo ? { brand: { label: ownerName, light: logo.light, dark: logo.dark } } : {}),
      },
      {
        id: "what",
        entity: "update",
        state: "done",
        label: record.replacement
          ? record.replacement.value
          : (a.toVersion ?? record.kind.replace(/-/g, " ")),
        ...(from ? { meta: `from ${from}` } : {}),
      },
      ...(when
        ? [
            {
              id: "when",
              entity: "check" as const,
              state: "not_proven" as const,
              label: when.slice(0, 10),
              caption: until(when),
            },
          ]
        : []),
      {
        id: "code",
        entity: "code",
        state: record.signatures.length ? "done" : "skipped",
        label: "Your code",
        meta: record.signatures.length
          ? `${record.signatures.length} thing${record.signatures.length === 1 ? "" : "s"} to find`
          : "by hand",
      },
      {
        id: "fix",
        entity: "fix",
        state: "pending",
        label: record.replacement?.codemod ? "Swapped in code" : "Nemotron fixes",
        ...(record.replacement?.codemod ? {} : { brand: STACK.nemotron }),
      },
    ],
    links: [],
  };
  graph.links = graph.tiles.slice(1).map((t, i) => ({
    from: graph.tiles[i]?.id as string,
    to: t.id,
    state: t.state === "skipped" ? "skipped" : t.state === "pending" ? "pending" : "done",
  }));
  return { graph, logo, ownerName, ownerHref, provider, a };
}
