# Resolver pilot

Real jobs through the resolver service, as the worker sends them (`packages/engine/scripts/resolver-pilot.ts`), on 2026-10-28. Each `cases-N.json` is a batch; `results-N.jsonl` is what came back, one line per case: the result kind, the lead version, the files and every package the updater moved, or the typed stop.

Run a batch again with the service reachable:

```bash
TEIRE_RESOLVER_URL=http://127.0.0.1:8788 TEIRE_RESOLVER_SECRET=… \
  pnpm --filter @teire/engine exec tsx scripts/resolver-pilot.ts smoke/resolver/pilot-2026-10-28-cases-1.json
```

What the batches found, and what Teire changed because of it:

- **pnpm v5.4 lockfiles** stop inside dependabot-core's pnpm helper (`results-2`), so they keep Teire's transaction.
- **A binary `bun.lockb`** comes back with only `package.json` changed (`results-2`), so it keeps Teire's transaction.
- **Cargo** stopped below the target when the target removed a feature the repo enables (`results-1`, `results-cargo-rerun`); with the feature dropped from the input first, it reaches the target (`results-3`).
- **Maven** keeps a version's suffix (guava 19.0 → 23.0, not 33.7.2-jre), so the run's target becomes 23.0 and the PR says why.
- **A version job whose versions are all ignored** returns nothing, as Dependabot does; only security jobs raise `all_versions_ignored`.
