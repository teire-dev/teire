---

name: teire-cli
description: Scan a repository with Teire for dependency, API, model, and runtime changes that reach its code. Use when investigating an upgrade, deprecation, breaking release, or upcoming shutdown, or when setting a CI gate. Guides the teire-cli npm package and its read-only MCP tools.
---

# Teire CLI

Teire connects upstream change records to the exact code they affect. Use the [CLI](https://teire.vercel.app/docs/build/cli) for a one-off local or public GitHub scan, or the [MCP server](https://teire.vercel.app/docs/build/mcp) if it is already connected to your agent. The skill supplies the workflow; `teire-cli` performs the scan.

## Scan the relevant target

Run from the repository root, or pass a folder. A public GitHub `owner/name` or URL also works without a clone.

```bash
npx -y teire-cli scan
npx -y teire-cli scan owner/name
```

Read **Affected**, **Needs a human**, **Decided by running your checks**, **What Teire could not check**, and **Notes** before calling a repository clean. `--all` shows changes that do not reach the installed versions or code. Use `--json` when you need machine-readable `groups`, `changes`, `coverage`, and call sites, or a computed package change ID. A large scan may take a minute or two.

## Explain before editing

For a relevant finding, use its change ID from `scan --json`:

```bash
npx -y teire-cli explain <change-id> [target]
```

This returns the change summary, replacement, migration notes, and quoted sources. Package-computed IDs live in the scan that found them, so pass the same target to `explain`. Check the cited call sites and source record before deciding what to change. Teire's CLI reports and gates; it does not edit files, run a fix, or open a PR.

For a provider or package change before writing new code, query the public catalog:

```bash
npx -y teire-cli changes --provider openai
npx -y teire-cli changes --ecosystem npm --subject <package>
```

If the catalog lacks a provider with a built-in reader, Teire may read that provider's pages live. Treat missing toolchains, unpinned versions, unavailable advisory sources, and `check_by_hand` findings as unresolved, not as evidence of safety.

## Gate CI when requested

```bash
npx -y teire-cli check --fail-on deadline --within 60
```

`--fail-on affected` is the default; `deadline` fails on an affected change with a date within the chosen number of days or already past; `any` includes findings needing a person or manual check. Exit 0 means the chosen gate passed, 1 that it failed, and 2 that usage or the scan errored. A passing gate is limited by the scan's coverage and notes.

## If Teire MCP is connected

Call `scan_path` with the repository path. Use a returned group `key` with `explain_finding` on the same path for quoted sources and call sites. Use `list_changes` for catalog research and `get_change` for a catalog ID. A package-computed ID from a scan may not exist in the public catalog: use `explain_finding` for it. `scan_path` caches a target for five minutes; set `fresh: true` after the repository changes. All four MCP tools are read-only.

To connect the server in a client that supports MCP, run `npx -y teire-cli mcp` over stdio. See the [MCP setup](https://teire.vercel.app/docs/build/mcp) for client configuration.
