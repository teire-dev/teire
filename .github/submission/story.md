## Inspiration

Every app leans on things other people change: open-source packages, payment APIs, AI models. When one of them changes, someone on the team has to:

1. notice it happened;
2. work out whether it touches their code;
3. find every line that does;
4. change those lines;
5. prove the app still works.

Nobody owns this chore, so it waits until something breaks. On 2026-04-22 OpenAI announced that `gpt-3.5-turbo`, `gpt-4` and `o3-mini` would shut down on 2026-10-23. That day, seven of inspect_ai's live tests failed with `404 model_not_found`. The next morning, the commit tool gitted failed on every call, because its default model was still `gpt-3.5-turbo`. The notice existed; nothing connected it to the code.

Today's tools stop short. Dependabot and Renovate open a pull request that bumps the version, and fixing whatever the new version breaks is left to you. A retired model is not a new version, so they open nothing at all. Coding agents can make the edits, but only after a person notices the change, starts them, and checks what they did.

## What it does

**When a package, API or model changes, Teire fixes your code.** Teire finds the lines that break, and a Nemotron coding agent on Nebius Token Factory fixes what a plain swap can't. Your own tests run before and after, and a pull request shows the proof.

Teire watches every dependency and API a repository uses:

- six package ecosystems: npm, PyPI, Go, Cargo, RubyGems and Maven/Gradle;
- the AI and payment APIs the code calls: OpenAI, Anthropic, Google Gemini, Nebius Token Factory, Stripe, and any other API host it discovers in the code;
- the Node.js and Python versions it is pinned to.

For each change that reaches the code, Teire:

1. **Notices it.** It reads only what the repository uses: the registry for each locked package, and the change pages of each API the code calls.
2. **Finds the exact lines.** For a major upgrade, it diffs the public API of your version against the target with each ecosystem's own tool, then finds the lines that use what changed.
3. **Fixes them.** The swap the source names comes first. Then NVIDIA Nemotron 3 Ultra works as an agent with six tools for whatever the swap can't fix.
4. **Proves it.** Your own typecheck and tests run in two sandboxes, before and after the change, with the network off.
5. **Opens a pull request.** It carries the quoted source, the call sites, the before/after table and the cost of every model call.

When Teire can't prove a fix, it says so: a draft with the reason, or an issue for a person.

**A real run.** Groq shut down two Llama models on 2026-08-16, and `teire-dev/demo-wrapped-models` keeps both IDs in a tier registry, not in a `model:` argument.

1. Teire found Groq through the installed `groq-sdk`. Groq's `llms.txt` and a Tavily search led to its deprecations page.
2. Nemotron read the page. Code kept each record only because its quote appears word for word on the page.
3. Nemotron traced the registry entry to the request: `src/llm.ts:12 model: t.id`. Code checked that line exists before calling the finding affected.
4. Teire swapped the model with one named replacement. Nemotron chose between the two Groq names for the other.
5. The tests went from 0/4 to 4/4, for $0.095.

You meet Teire in five places:

- **A GitHub App.** An onboarding PR, one fix PR per change, and a Dashboard issue you tick to fix, rebase or rescan.
- **`@teire` commands** in any issue or PR: `rescan`, `fix`, `ignore`, `rebase`, `recreate`, `explain`, `config`, `pause`, `resume`, `wrong` and `help`.
- **A web dashboard,** plus a public catalog of every confirmed change.
- **A public scan with a dry-run fix,** for any public repository, with no install.
- **A CLI and MCP server,** so terminals, CI and coding agents ask the same questions.

## How we built it

- **Nebius Token Factory and NVIDIA Nemotron.** Every model call goes through Token Factory's OpenAI-compatible API, with the AI SDK and structured outputs. Nemotron 3 Ultra has five jobs, and code checks each one:
  - **Fixing code as an agent.** Its tools are `read_file`, `search`, `edit_file`, `run_check`, `lookup_docs` and `finish`. It gets up to 24 steps per attempt and 4 attempts, with a fresh plan after 2 failures. It may edit only the files the change reaches, never manifests, lockfiles or CI.
  - **Reading release notes.** Each note must quote the fetched text.
  - **Reading a discovered provider's deprecation pages.** A quote gate checks every record against the page.
  - **Tracing model IDs kept in registries.** The cited line must exist and name a model.
  - **Reviewing each passing diff.** It looks for weakened tests or widened validators.

  Nemotron 3 Super is the failover. Prices from Token Factory's public `models_info` give every PR an exact receipt, and a daily budget pauses model work instead of overspending.
- **Finding the lines.** Each ecosystem uses its own tools:
  - **npm:** TypeScript declarations and the TypeScript type checker.
  - **PyPI:** griffe and jedi.
  - **Go:** apidiff, go/types and govulncheck.
  - **Cargo:** cargo-semver-checks.
  - **RubyGems:** Prism.
  - **Maven/Gradle:** japicmp, and references read from your compiled classes.

  ast-grep finds model IDs and URLs in seven languages.
- **Proving it.** Two sandboxes on Cloudflare Containers start from the same commit. Installs may reach only package registries, checks run with the network off, and no secret enters. Fixed rules, never a model, turn the results into the evidence that decides ready, draft or issue.
- **Running it.** A Next.js web app on Vercel holds the GitHub webhook, a Postgres outbox, the dashboard, the catalog and the docs. A Node worker on Coolify runs the scans and fixes from pg-boss queues. A reliability ticker reaps stuck runs and redelivers missed webhooks.

## Challenges we ran into

- **Saying "not affected" honestly.** Most breaking changes don't touch a given codebase. Teire says "not affected" only when every use was resolved by type. Where the search is syntax-level, it says "inconclusive" and lets the sandbox decide.
- **Model text can't be trusted on its own.** A model can misquote a deprecation page or invent a call site. Every Nemotron output is checked by code: quotes against the fetched page, traced lines against the files it was shown, fixes against the repository's own tests.
- **Agents that pass tests the wrong way.** In our evaluation, Nemotron 3 Super once passed the tests by replacing the model call with a keyword rule. We added the review step after seeing it.
- **Real bugs found by real runs.** Each one was found by a failing case, fixed, and rerun:
  - Gradle skipped "up to date" test tasks;
  - one transient install failure cost a whole run;
  - the docs tool pointed the agent at files it couldn't open;
  - two sandboxes reporting at once collided in the run's event log.

## Accomplishments that we're proud of

- **Evaluation.** 12 package majors across all six ecosystems and 3 model retirements, each verified end to end with Nemotron 3 Ultra as the agent. No false positive across 6 clean repositories.
- **Every PR carries its own proof:** quotes, call sites, a before/after table, and a receipt down to the cent.
- **Discovery.** Teire finds providers with no hand-written reader from the code itself, and reads their notices with Nemotron under a quote gate.
- **A complete product.** GitHub App, dashboard, public scan, dry run, catalog, CLI, MCP, a live trust page, and docs with real captures of every screen.

## What we learned

- Verification is the hard part, not the edit. "The tests pass" only means something next to the same tests on the unchanged code.
- Nemotron 3 Ultra is a capable coding agent when it gets real tools and real feedback. Its output still needs code checking it.
- Most of the value is in saying no correctly: not affected, not applicable, or can't prove it.

## What's next

- Move verification to Token Factory Sandboxes.
- A type-level locator for Rust.
- Android projects.
- Open the change catalog to provider contributions.

## Honest limits

- Checks run on Cloudflare Containers, not Token Factory Sandboxes.
- Only major upgrades get an API diff and a line search.
- Rust, Ruby, and Java/Kotlin at scan time are searched by syntax.
- Model and API fixes are verified in JavaScript/TypeScript or Python projects.
- Android is not supported.
- There are no real users yet: the evaluation repositories are Teire's own demos, built to reproduce real breakages.
