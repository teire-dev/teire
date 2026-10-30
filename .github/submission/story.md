# Teire · 手入れ — When upstream breaks, Teire fixes your code

![Teire: the live zod fix goes from a breaking dependency through Nemotron and the repository's own checks to a pull request](https://raw.githubusercontent.com/teire-dev/teire/main/.github/assets/banner-dark.png)

**Found, fixed by Nemotron, proven by your own tests.** [Try Teire](https://teire.vercel.app) · [Scan a public repository](https://teire.vercel.app/scan) · [Docs](https://teire.vercel.app/docs) · [Source code](https://github.com/teire-dev/teire) · [Live status](https://teire.vercel.app/trust)

Built for the **Coding and Agentic Engineering Track** with NVIDIA Nemotron 3 Ultra on Nebius Token Factory. *Teire* (手入れ) means care and upkeep: tending the tools you rely on so they keep working.

## Inspiration

Every app leans on things other people change: open-source packages, payment APIs, AI models. When one of them changes, someone on the team has to:

1. notice it happened;
2. work out whether it touches their code;
3. find every line that does;
4. change those lines;
5. prove the app still works.

Nobody owns this chore, so it waits until something breaks. On 2026-04-22 OpenAI announced that `gpt-3.5-turbo`, `gpt-4` and `o3-mini` would shut down on 2026-10-23. That day, [seven of inspect_ai's live tests failed](https://github.com/meridianlabs-ai/inspect_ai/issues/601) with `404 model_not_found`. The next morning, [the commit tool gitted failed on every call](https://github.com/yegor256/gitted/issues/176), because its default model was still `gpt-3.5-turbo`. The notice existed; nothing connected it to the code.

Today's tools stop short. Dependabot and Renovate open a pull request that bumps the version, and fixing whatever the new version breaks is left to you. A retired model is not a new version, so they open nothing at all. Coding agents can make the edits, but only after a person notices the change, starts them, and checks what they did.

## What it does

**When upstream breaks, Teire fixes your code.** When a package, an API or an AI model your code depends on changes, Teire finds the lines that break, and a Nemotron coding agent on Nebius Token Factory fixes what a plain swap can't. Your own tests run before and after, and a pull request shows the proof.

Teire watches every dependency and API a repository uses:

- six package ecosystems: npm, PyPI, Go, Cargo, RubyGems and Maven/Gradle;
- the AI and payment APIs the code calls: OpenAI, Anthropic, Google Gemini, Nebius Token Factory, Stripe, and any other API host it discovers in the code;
- the runtime versions it is pinned to: Node.js, Python, Java, Go, Rust and Ruby, with end-of-life notices.

For each change that reaches the code, Teire:

1. **Notices it.** It reads only what the repository uses: the registry for each locked package, and the change pages of each API the code calls.
2. **Finds the exact lines.** For a major upgrade, it diffs the public API of your version against the target with each ecosystem's own tool, then finds the lines that use what changed.
3. **Fixes them.** The swap the source names comes first. Then NVIDIA Nemotron 3 Ultra works as an agent with six tools for whatever the swap can't fix.
4. **Proves it.** Your own typecheck and tests run in two sandboxes, before and after the change, with the network off.
5. **Opens a pull request.** It carries the quoted source, the call sites, the before/after table and the cost of every model call.

When Teire can't prove a fix, it says so: a draft with the reason, or an issue for a person.

**A real evaluation run.** Groq shut down two Llama models on 2026-08-16, and `teire-dev/examples/wrapped-models` keeps both IDs in a tier registry, not in a `model:` argument.

1. Teire found Groq through the installed `groq-sdk`. Groq's `llms.txt` and a Tavily search led to its deprecations page.
2. Nemotron read the page. Code kept each record only because its quote appears word for word on the page.
3. Nemotron traced the registry entry to the request: `src/llm.ts:12 model: t.id`. Code checked that line exists before calling the finding affected.
4. Teire swapped the model with one named replacement. Nemotron chose between the two Groq names for the other.
5. The tests went from 0/4 to 4/4, for $0.095.

![The public scan finds the two retired models in this repository and shows the exact lines that use them](https://raw.githubusercontent.com/teire-dev/teire/main/.github/assets/captures/report-wrapped-models-desktop.png)

The example repository reproduces a real retirement. [Open the product walkthrough](https://teire.vercel.app/docs/guide/public-scan) or [inspect the evaluation](https://teire.vercel.app/docs/nemotron/evaluation). On an installed repository, Teire also opens a real PR: [this security fix on `serve-handler`](https://github.com/teire-dev/serve-handler/pull/10) shows the source advisory and 70/70 tests before and after. A [draft PR on `konkyo`](https://github.com/Blockchain-Oracle/konkyo/pull/4) shows Teire withholding a ready label when it has a passing typecheck but no behavioral tests.

You meet Teire in five places:

- **A GitHub App.** An onboarding PR, one fix PR per change, and a Dashboard issue you tick to fix, rebase or rescan.
- **`@teire` commands** in any issue or PR: `rescan`, `fix`, `ignore`, `rebase`, `recreate`, `explain`, `config`, `pause`, `resume`, `wrong` and `help`.
- **A web dashboard drawn as flows:** your whole estate as one map (changes → repositories → what is open; drag a change onto a repository to fix it), every PR as a breadcrumb trail of its run, and **Ask Teire** beside it, answering with the same flows and acting only when you click Confirm. Plus a public catalog that shows Teire checking its sources.
- **A public scan with a dry-run fix,** for any public repository, with no install.
- **A CLI and MCP server,** so terminals, CI and coding agents ask the same questions.

## Inside the working product

The captures below come from Teire's public evaluation repositories, built to reproduce breaking changes. They show real product runs, not customer adoption.

**The coding agent in the loop.** A Go upgrade from `golang-jwt` v4 to v5 broke the repository's checks. The run shows Nemotron 3 Ultra reading the affected files, looking up the new API, editing the code and rerunning checks. This captured run used Cloudflare Containers for verification; the model calls went through Nebius Token Factory.

![Teire's Go fix timeline, including failing checks and Nemotron's first agent steps](https://raw.githubusercontent.com/teire-dev/teire/main/.github/assets/captures/dryrun-go-timeline-desktop.png)

**The proof is in the repository's own checks.** The same build, typecheck and four tests ran on the unchanged code and on the fix. The receipt names each Nemotron call, its tokens and its $0.1807 model cost.

![The Go run's before and after verification table: build and typecheck pass, four of four tests pass on both sides](https://raw.githubusercontent.com/teire-dev/teire/main/.github/assets/captures/dryrun-go-verification-desktop.png)

![The run receipt lists Nemotron 3 Ultra calls on Token Factory and the sandbox commands](https://raw.githubusercontent.com/teire-dev/teire/main/.github/assets/captures/dryrun-go-receipt-desktop.png)

**The rest of the product keeps the work visible.** The dashboard maps changes to repositories and PRs; Ask Teire answers from those flows and requires a click before acting. The public catalog shows each source's last check and new notices.

![Teire's dashboard maps upstream changes to repositories and open work](https://raw.githubusercontent.com/teire-dev/teire/main/.github/assets/captures/dashboard-desktop.png)

## How we built it

- **Nebius Token Factory and NVIDIA Nemotron.** Every model call goes through Token Factory's OpenAI-compatible API, with the AI SDK and structured outputs. Nemotron 3 Ultra has five jobs, and code checks each one:
  - **Fixing code as an agent.** Its tools are `read_file`, `search`, `edit_file`, `run_check`, `lookup_docs` and `finish`. It gets up to 24 steps per attempt and 4 attempts, with a fresh plan after 2 failures. It may edit only the files the change reaches, never manifests, lockfiles or CI.
  - **Reading release notes.** Each note must quote the fetched text.
  - **Reading a discovered provider's deprecation pages.** A quote gate checks every record against the page.
  - **Tracing model IDs kept in registries.** The cited line must exist and name a model.
  - **Reviewing each passing diff.** It looks for weakened tests or widened validators.

  Nemotron 3.5 Super is the failover (it replaced Nemotron 3 Super, which Token Factory retires on 2026-11-09). Prices from Token Factory's public `models_info` give every PR an exact receipt, and a daily budget pauses model work instead of overspending.
- **Finding the lines.** Each ecosystem uses its own tools:
  - **npm:** TypeScript declarations and the TypeScript type checker.
  - **PyPI:** griffe and jedi.
  - **Go:** apidiff, go/types and govulncheck.
  - **Cargo:** cargo-semver-checks.
  - **RubyGems:** Prism.
  - **Maven/Gradle:** japicmp, and references read from your compiled classes.

  ast-grep finds model IDs and URLs in seven languages.
- **Changing the dependency files.** dependabot-core's own updater (MIT) makes the manifest and lockfile change, through GitHub's `dependabot` CLI on a second Docker daemon under gVisor, firewalled and one job at a time. Where Dependabot stops, Teire keeps its own change: Go majors, aliases, a removed Cargo feature, Gradle locks for one coordinate, an override for a transitive fix, and the Java a new version needs.
- **Proving it.** Two sandboxes start from the same commit. For public repositories and dry runs, Teire chooses Nebius Token Factory Sandboxes when the project has spawn access and images configured; it falls back to Cloudflare Containers otherwise. Private repositories use Cloudflare Containers because Token Factory images are retained for 180 days with no delete call. Installs need network access; checks run with it off. Fixed rules, never a model, turn the results into the evidence that decides ready, draft or issue.
- **Running it.** A Next.js web app on Vercel holds the GitHub webhook, a Postgres outbox, the dashboard, the catalog and the docs. A Node worker on Coolify runs the scans and fixes from pg-boss queues. A reliability ticker reaps stuck runs and redelivers missed webhooks.

![System diagram: GitHub, web app, worker, Token Factory and Nemotron, dependency sources, and verification sandboxes](https://raw.githubusercontent.com/teire-dev/teire/main/.github/assets/system-light.png)

![Fix loop: deterministic edits, sandbox checks, Nemotron's tool loop, review, and evidence-gated pull request](https://raw.githubusercontent.com/teire-dev/teire/main/.github/assets/fix-loop-light.png)

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

- **Evaluation.** 12 package majors across all six ecosystems and 7 model retirements (in TypeScript, Python, Go, Java, Ruby and Rust), each verified end to end: two fixed by Nemotron 3 Ultra as the agent, five by a deterministic swap, four of them with Ultra reviewing the diff. No false positive across 6 clean repositories.
- **Every PR carries its own evidence:** quotes, call sites, a before/after table, and a receipt down to the cent. A PR opens ready only when that evidence verifies it; otherwise it's a draft or an issue that says why.
- **Discovery.** Teire finds providers with no hand-written reader from the code itself, and reads their notices with Nemotron under a quote gate.
- **One product across several entry points.** GitHub App, dashboard, Ask Teire, public scan, dry run, catalog, CLI, MCP, a live trust page, and docs show the same changes and evidence in the place a developer works.

## What we learned

- Verification is the hard part, not the edit. "The tests pass" only means something next to the same tests on the unchanged code.
- Nemotron 3 Ultra is a capable coding agent when it gets real tools and real feedback. Its output still needs code checking it.
- Most of the value is in saying no correctly: not affected, not applicable, or can't prove it.

## What's next

- A type-level locator for Rust.
- Android instrumented tests on an emulator.
- Open the change catalog to provider contributions.

## Honest limits

- Private repositories verify on Cloudflare Containers: Token Factory keeps a run's saved sandbox images for 180 days, after which untagged ones may be deleted, with no call to delete them sooner.
- dependabot-core decides the dependency files in all six ecosystems on the deployed worker; real-repository PRs don't cover every package manager yet (`smoke/forks/` records each fork's result).
- Only major upgrades get an API diff and a line search.
- Rust, Ruby, and Java/Kotlin at scan time are searched by syntax.
- Model and API fixes run in all six ecosystems; the evaluation proves them in JavaScript/TypeScript and Python only.
- Android runs its debug unit tests; instrumented tests need a device and don't run.
- The 12 package and 7 model cases are evaluation on Teire-controlled repositories. One installed fork has a verified PR and an owner-controlled repository has a draft PR; broader external adoption has not been established.
- An October 30 first-use walk found GitHub onboarding and action-recovery failures. Fixes have been deployed or are deploying, but a clean end-to-end retest of the full automatic queue is still open.
