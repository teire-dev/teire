<p align="center">
  <a href="https://teire.vercel.app">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset=".github/assets/banner-light.png" />
      <img src=".github/assets/banner-dark.png" width="960" alt="Teire 手入れ. When upstream breaks, Teire fixes your code. Dependabot bumps the version; Teire fixes the code it breaks and proves it with your own tests. Beside it, the live run of a real Teire fix: zod 3.25.76 to 4.6.6 in teire-dev/examples, PR #30, proven with typecheck and 4 of 4 tests passing before and after." />
    </picture>
  </a>
</p>

<h1 align="center">Teire · 手入れ</h1>
<p align="center"><b>When upstream breaks, Teire fixes your code.</b><br />When a package, an API or an AI model your code depends on changes, Teire finds the lines that break, fixes them, and proves the fix with your own tests.</p>

<p align="center">
  <a href="https://teire.vercel.app"><b>Open the app</b></a>
  &nbsp;·&nbsp;
  <a href="#demo"><b>Demo</b></a>
  &nbsp;·&nbsp;
  <a href="https://teire.vercel.app/docs"><b>Docs</b></a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/teire-cli"><b>CLI on npm</b></a>
  &nbsp;·&nbsp;
  <a href="https://teire.vercel.app/scan"><b>Scan a public repo</b></a>
  &nbsp;·&nbsp;
  <a href="https://teire.vercel.app/trust"><b>Live status</b></a>
</p>

Teire finds the lines that break, and a Nemotron coding agent on Nebius Token Factory fixes what a plain swap can't. Your own tests run before and after, and a pull request shows the proof.

Teire watches the dependencies and APIs a repository uses: six package ecosystems (npm, PyPI, Go, Cargo, RubyGems, Maven/Gradle), the AI and payment APIs the code calls, and the runtimes it is pinned to. What it can't check on a scan (an advisory source that was down, a registry that didn't answer, Maven's transitive tree) is listed, never read as "nothing found". Model calls go to **NVIDIA Nemotron 3 Ultra on Nebius Token Factory** (Nemotron 3 Super takes over while Ultra fails): it reads the change pages Teire has no parser for, traces model IDs hidden in registries, and edits the code a swap can't fix. You meet Teire in five places:
- a **GitHub App** that opens one pull request per change and keeps a Dashboard issue;
- **`@teire` commands** in issues and PRs;
- a **web dashboard** drawn as flows (your estate as changes → repositories → open PRs, every PR as a breadcrumb trail of its run), with **Ask Teire** beside it: questions answered with those same flows, and actions only on your click;
- a **public scan with a dry-run fix**, for any public repository;
- a **CLI and MCP server** for terminals and coding agents.

Built for the **Nebius x NVIDIA Global AI Hackathon** · **Coding and Agentic Engineering Track**. Jump to [how Teire meets the hackathon](#how-teire-meets-the-hackathon).

_Teire_ (手入れ) is Japanese for care and upkeep, the way you tend tools or a garden so they keep working.

## The problem

Every app leans on things other people change: open-source packages, payment APIs, AI models. When one of them changes, someone on the team has to:
1. notice it happened;
2. work out whether it touches their code;
3. find every line that does;
4. change those lines;
5. prove the app still works.

Nobody owns this chore, so it waits until something breaks. On 2026-04-22 OpenAI announced that `gpt-3.5-turbo`, `gpt-4` and `o3-mini` would shut down on 2026-10-23. That day, seven of [inspect_ai's live tests failed](https://github.com/meridianlabs-ai/inspect_ai/issues/601) with `404 model_not_found`. The next morning, the commit tool gitted [failed on every call](https://github.com/yegor256/gitted/issues/176), because its default model was still `gpt-3.5-turbo`. The notice existed; nothing connected it to the code.

Today's tools stop short. Dependabot and Renovate open a pull request that bumps the version, and fixing whatever the new version breaks is left to you. A retired model is not a new version, so they open nothing at all. Coding agents can make the edits, but only after a person notices the change, starts them, and checks what they did.

## The idea

Teire does the whole chore, for packages and APIs alike:
1. It reads only what a repository uses: registries for each locked package, and the change pages of each API the code calls.
2. It finds the exact lines a change reaches, resolved by type where the language allows.
3. It fixes them: the swap the source names first, then a Nemotron coding agent for the rest.
4. It runs your own typecheck and tests in a sandbox, before and after, with the network off.
5. It opens a pull request that carries the quotes, the call sites, the verification table and every model call's cost.

Your job becomes reviewing a pull request. When Teire can't prove the fix, it says so: a draft with the reason, or an issue for a person.

### One change, end to end

Groq shut down `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` on 2026-08-16. [teire-dev/examples/wrapped-models](https://github.com/teire-dev/examples/tree/main/wrapped-models) keeps both IDs in a tier registry, not in a `model:` argument, so a text search can't tell whether they reach a request.

<p align="center">
  <a href="https://teire.vercel.app/docs/guide">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/model-retirement-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset=".github/assets/model-retirement-light.png" />
      <img src=".github/assets/model-retirement-light.png" width="960" alt="Sequence: Teire scans the repository, finds Groq's deprecations page through the SDK and Tavily, has Nemotron read it with verbatim quotes, traces the registry IDs to the request, swaps one and has Nemotron choose the other's replacement, verifies 0/4 then 4/4 tests in the sandbox, and composes a ready PR." />
    </picture>
  </a>
</p>
<p align="center"><a href="https://teire.vercel.app/docs/guide">Open the walkthrough</a> · <a href=".github/diagrams/readme-model-retirement.mmd">Edit the Mermaid source</a></p>

1. **Notice.** `groq-sdk` is installed, and Teire has no hand-written reader for Groq. The SDK's own code names `api.groq.com`. Groq's `llms.txt` and a [Tavily](https://tavily.com) search led to its deprecations page. Nemotron read that page into records, and code kept only those whose quote appears word for word on the page.
2. **Impact.** Nemotron traced `TIERS.quick.id` to the request: _"src/llm.ts:12 `model: t.id,`"_. Code checked that the cited line exists and names a model, and only then called the finding affected.
3. **Fix.** Teire swapped `llama-3.1-8b-instant` for the one replacement Groq names. For `llama-3.3-70b-versatile` Groq names two, so Nemotron 3 Ultra chose `openai/gpt-oss-120b` and raised a token limit so the new model has room to answer: 1 attempt, 12 steps, $0.095.
4. **Verify.** Tests passed 0/4 on the baseline, because the models are gone, and 4/4 after.
5. **Pull request.** Evidence `verified` means a ready PR that opens with **Verified.** This run is from Teire's evaluation, through the same code path an installed repository takes; PRs on real installed repositories are linked under Proof as they open.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/captures/wrapped-models-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/captures/wrapped-models-light.png" />
    <img src=".github/assets/captures/wrapped-models-light.png" width="960" alt="The public report for teire-dev/demo-wrapped-models: 64 dependencies read, 2 changes reaching this code; the llama-3.1-8b-instant shutdown quoted from console.groq.com and traced to src/models.ts:7 and :9, and Node.js 20's end of life at package.json:8 from endoflife.date." />
  </picture>
</p>

Every model fix and every package fix follows the same loop. The [Go major](https://teire.vercel.app/docs/guide/anatomy-of-a-pr) (`golang-jwt/jwt` v4 → v5) is a second worked example: the agent moved `StandardClaims` to `RegisteredClaims` and the expiry check to `errors.Is(err, jwt.ErrTokenExpired)`, then verified 4/4 for $0.181.

## Demo

<p align="center">
  <a href="https://teire.vercel.app/demo">
    <img src=".github/assets/demo-cover.png" width="960" alt="Watch the demo: Dependabot bumps. Teire fixes. Beside it, the zod 3 → 4 run: typecheck exit 2 and tests exit 1 after the upgrade, then pass and 4/4 after Nemotron's fix. Nemotron on Nebius Token Factory." />
  </a>
</p>
<p align="center"><a href="https://teire.vercel.app/demo"><b>Watch the 2:50 demo</b></a> · <a href="https://youtu.be/s3VyWZnEVqc">youtu.be/s3VyWZnEVqc</a></p>

### See it

Every claim is one click from its proof. These are live pages; open any of them.

<table>
<tr>
<td width="50%" valign="top"><a href="https://teire.vercel.app/runs/d1b0c4d8-a46e-4e9d-b057-30b6d12be23b?tile=code"><picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/captures/run-dark.png" /><img src=".github/assets/captures/run-light.png" alt="The zod 3.25.76 to 4.6.6 run behind PR #30: the run as tiles and, for Your code, where zod is declared and the lines the fix had to change, each linked at the commit the run read." /></picture></a><br /><sub><b>Your code, as lines.</b> The zod run behind PR #30: where it's declared and the lines the fix changed, linked at the commit it read.</sub></td>
<td width="50%" valign="top"><a href="https://teire.vercel.app/runs/d1b0c4d8-a46e-4e9d-b057-30b6d12be23b"><picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/captures/run-pr-dark.png" /><img src=".github/assets/captures/run-pr-light.png" alt="The same run's PR tab: why this repo, what changed upstream quoted with each source, the commits between the versions, the changes, verification and receipt." /></picture></a><br /><sub><b>The PR, as its text.</b> Why this repo, what changed upstream (quoted and linked), the checks before and after, the receipt.</sub></td>
</tr>
<tr>
<td width="50%" valign="top"><a href="https://teire.vercel.app/scan/1cd512ab-1426-4c3f-913b-4345f8605692"><picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/captures/report-dark.png" /><img src=".github/assets/captures/report-light.png" alt="gin-gonic/gin's public report: 32 Go dependencies read, one advisory reaching the code, quoted with its osv.dev link and traced to gin.go:806 and render/json.go:187." /></picture></a><br /><sub><b>A public scan.</b> gin-gonic/gin: an advisory traced to the two lines that call it, with its source.</sub></td>
<td width="50%" valign="top"><a href="https://teire.vercel.app/app"><picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/captures/dashboard-dark.png" /><img src=".github/assets/captures/dashboard-light.png" alt="The dashboard Overview: ready to merge, needs you, open pull requests and reaching your code, then the estate: changes, repositories and outcomes as one flow." /></picture></a><br /><sub><b>The dashboard.</b> Every change, repository and pull request as one estate.</sub></td>
</tr>
</table>

Follow the proof yourself on [teire.vercel.app](https://teire.vercel.app):
1. **Scan.** On [/scan](https://teire.vercel.app/scan), sign in with GitHub and paste `teire-dev/examples`. In a few minutes the report shows every example's findings; among them, OpenAI's `gpt-4.1-nano` shutdown reaching `ai-web/src/summarize.ts:13`.
2. **Dry-run the fix.** Press **Dry-run a fix**. The run page shows each step live: the swap, then your checks in two sandboxes. Nothing is written to GitHub.
3. **Read the PR.** The **The PR** tab is the pull request Teire would open. **Verification** and **Receipt** show the before/after results and every model call.
4. **Watch it run.** [/trust](https://teire.vercel.app/trust) shows the worker's live heartbeat, Token Factory credits, which Nemotron model is answering, and the spend.
5. **Go deeper.** The [docs](https://teire.vercel.app/docs) walk through every surface, with real captures of each.

## How it works

<p align="center">
  <a href="https://teire.vercel.app/docs/build">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/system-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset=".github/assets/system-light.png" />
      <img src=".github/assets/system-light.png" width="960" alt="System: developers install the GitHub App and use the web app; GitHub webhooks reach the web app, which writes to a Postgres outbox; the worker claims them, reads registries, provider pages and Tavily, calls Nemotron on Token Factory, runs dependabot-core's updater under gVisor for each upgrade, verifies public repositories on Token Factory Sandboxes and private ones on Cloudflare Containers, and writes branches, PRs, check runs and issues back to GitHub." />
    </picture>
  </a>
</p>
<p align="center"><a href="https://teire.vercel.app/docs/build">Open the architecture</a> · <a href=".github/diagrams/readme-system.mmd">Edit the Mermaid source</a></p>

**Notice.** Every active repository is rescanned daily (or weekly, or never, as `teire.yml` says) and on each push that changes its dependency files or code, like Dependabot's per-repo schedule. Nothing is read for a provider or package no connected repository uses: a provider's pages are read only when a scanned repository calls it, at most once every 6 hours, shared by every repository, and a new record there rescans the other repositories that use it. Advisories come from OSV and GitHub's advisory database. ([Providers](https://teire.vercel.app/docs/ecosystems/providers))

**Impact.** For a major upgrade, Teire diffs the public API of your version against the target with each ecosystem's own tool, then finds the lines that use what changed:

| Ecosystem      | API diff                           | Finds your lines with                              |
| -------------- | ---------------------------------- | -------------------------------------------------- |
| npm            | TypeScript declarations (TS 6.0.3) | the TypeScript type checker                        |
| PyPI           | griffe 2.4.1                       | jedi                                               |
| Go             | apidiff                            | go/types                                           |
| Cargo          | cargo-semver-checks 0.51.0         | a syntax-level search                              |
| RubyGems       | Prism                              | Prism, syntax level                                |
| Maven · Gradle | japicmp 0.26.3                     | imports, then your compiled classes during the fix |

Model IDs and API URLs are found with ast-grep in JS/TS, Python, Go, Rust, Ruby, Java and Kotlin. ([How Teire works](https://teire.vercel.app/docs/guide/how-it-works))

**Fix.** The manifest and lockfile change comes from **dependabot-core's own updater** (MIT), run on Teire's server under gVisor with no secrets and no route out but its proxy. On the deployed worker it decides the dependency files in all six ecosystems. Where Dependabot stops, Teire keeps its own change: Go majors, aliased packages, a Cargo feature the new version removed, Gradle locks for one coordinate, an override for a transitive fix, and the Java a new version needs. ([How Teire updates dependency files](https://teire.vercel.app/docs/build/dependency-files)) Deterministic edits come next: a model swap, or, for npm packages, a rename a quoted migration note names. If your checks then pass, the agent never starts. Otherwise Nemotron 3 Ultra works as an agent with six tools (`read_file`, `search`, `edit_file`, `run_check`, `lookup_docs`, `finish`), edits only the files the change reaches and never manifests, lockfiles, config or CI. It has up to 24 steps per attempt and 4 attempts, with a fresh plan after 2 failures. A review pass reads each passing diff for weakened tests or widened validators.

<p align="center">
  <a href="https://teire.vercel.app/docs/guide/how-it-works">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/fix-loop-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset=".github/assets/fix-loop-light.png" />
      <img src=".github/assets/fix-loop-light.png" width="960" alt="Fix loop: upgrade transaction, deterministic edits, your checks before vs after; a pass goes to the pull request, a failure to the Nemotron agent, which retries until checks pass or attempts run out; a passing fix goes through the review." />
    </picture>
  </a>
</p>
<p align="center"><a href="https://teire.vercel.app/docs/guide/how-it-works">Open the fix loop</a> · <a href=".github/diagrams/readme-fix-loop.mmd">Edit the Mermaid source</a></p>

**Verify.** Two sandboxes start from the same commit, the baseline and the change. Each installs, then runs your checks with the network off. A public repository's run, and every dry run, happens on **Nebius Token Factory Sandboxes**: a microVM per command, images Teire builds inside Token Factory, checks with no network interface at all. A private repository's runs on Cloudflare Containers, with only registries reachable during the install. Rules decide the evidence, never a model. ([Verification](https://teire.vercel.app/docs/build/verification) · [Token Factory Sandboxes](https://teire.vercel.app/docs/build/token-factory-sandboxes))

| Evidence                                                                                                     | Opens                             |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `verified`                                                                                                   | a ready PR                        |
| `typecheck_only`, `pre_existing_failure`, `needs_live_access`, `needs_local_service`, `environment_mismatch` | a draft PR naming the reason      |
| `regression`, `unverified`, `timeout`                                                                        | an issue, **Teire needs a human** |

### Built on

| Piece                                                             | What it does in Teire                                                                                                                                                                                                                            | Where                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nebius Token Factory**                                          | Every model call, through its OpenAI-compatible API (`api.tokenfactory.nebius.com/v1`) with structured outputs. Prices come from its public `models_info`, so every call has a cost on the receipt. A 402 pauses model work until credits return | [`llm/index.ts`](packages/engine/src/llm/index.ts)                                                                                                                                                                                                                                                            |
| **NVIDIA Nemotron 3 Ultra** (`nvidia/Nemotron-3-Ultra-550b-a55b`) | The fix agent; reads release notes and the pages of providers Teire discovers; traces wrapped model IDs; reviews passing fixes                                                                                                                   | [`fix/agent.ts`](packages/engine/src/fix/agent.ts) · [`fix/review.ts`](packages/engine/src/fix/review.ts) · [`notes/extract.ts`](packages/engine/src/notes/extract.ts) · [`impact/triage.ts`](packages/engine/src/impact/triage.ts) · [`vendor-page.ts`](packages/engine/src/catalog/adapters/vendor-page.ts) |
| **NVIDIA Nemotron 3.5 Super** (`nvidia/Nemotron-3.5-Super-VL`)    | Failover: takes a role for 10 minutes while Ultra fails, and reruns a failed agent attempt                                                                                                                                                       | [`llm/index.ts`](packages/engine/src/llm/index.ts) · [`fix/agent.ts`](packages/engine/src/fix/agent.ts)                                                                                                                                                                                                       |
| **Tavily**                                                        | Finds the deprecation pages of a provider Teire has no reader for, limited to its own domains                                                                                                                                                    | [`discover/tavily.ts`](packages/engine/src/discover/tavily.ts)                                                                                                                                                                                                                                                |
| **Context7**                                                      | Version-pinned docs for npm packages, behind the agent's `lookup_docs`                                                                                                                                                                           | [`fix/context7.ts`](packages/engine/src/fix/context7.ts)                                                                                                                                                                                                                                                      |
| **Nebius Token Factory Sandboxes**                                | The verification sandbox for public repositories and dry runs: Teire builds its six images inside Token Factory from its Dockerfiles, then runs the install (network on) and each check (no network interface) as microVMs                       | [`verify/tokenfactory.ts`](packages/engine/src/verify/tokenfactory.ts)                                                                                                                                                                                                                                        |
| **dependabot-core** (MIT)                                         | The dependency-file change: its updater, through GitHub's `dependabot` CLI, on a second Docker daemon under gVisor, firewalled, one job at a time                                                                                                | [`apps/resolver`](apps/resolver) · [`resolver/`](packages/engine/src/resolver)                                                                                                                                                                                                                                |
| **Cloudflare Containers**                                         | The sandbox for private repositories: one container per side, install with registry-only access, checks with the network off, no secrets inside                                                                                                  | [`apps/sandbox`](apps/sandbox)                                                                                                                                                                                                                                                                                |
| **GitHub App**                                                    | Reads repositories, pushes one `teire/…` branch per fix, opens PRs, check runs and the Dashboard issue, answers `@teire` commands                                                                                                                | [`github/`](packages/engine/src/github) · [`jobs/`](apps/worker/src/jobs)                                                                                                                                                                                                                                     |

**Where Token Factory helped.** One OpenAI-compatible endpoint serves all three roles (agent, reader and failover), so moving a role between Ultra and Super is an environment variable, not a code change. Its structured outputs keep every reading machine-checkable before code trusts it. Its public price list lets each pull request carry an exact receipt.

## How Teire meets the hackathon

The required build, in the organisers' words: _"a working software application that runs on either Nebius Token Factory or Nebius AI Cloud and uses at least one NVIDIA open source model"_. The track: _"Build coding agents and developer tools: agents that write, run, and test code in Token Factory."_

| Requirement or criterion                                                                                                                                                                                                                  | How Teire meets it                                                                                                                                                                                                                                                        | Check it here                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runs on Nebius Token Factory, uses an NVIDIA open model**                                                                                                                                                                               | Every model call goes to Token Factory: Nemotron 3 Ultra, with Nemotron 3 Super as failover. No other model provider is used                                                                                                                                              | [`llm/index.ts`](packages/engine/src/llm/index.ts) · model rows on [/trust](https://teire.vercel.app/trust) · [Nemotron on Token Factory](https://teire.vercel.app/docs/nemotron)                           |
| **Track: "agents that write, run, and test code in Token Factory"**, pushed further: _"an agent that plans, writes, tests, and iterates on a real repo with minimal human input"_                                                         | Teire notices the change itself and finds the lines. Nemotron writes the fix and runs the repo's own checks through `run_check`. It replans after two failures and is reviewed before a PR. No human starts it                                                            | [`fix/run.ts`](packages/engine/src/fix/run.ts) · a real run's timeline in [Public scan and dry run](https://teire.vercel.app/docs/guide/public-scan)                                                        |
| **Technological Implementation** — _"How well is the project built, and how effectively does it use Nebius Token Factory or AI Cloud model(s), and NVIDIA Nemotron or other NVIDIA open source models as part of the solution?"_          | Nemotron has five jobs, each checked by code: quotes must be in the fetched page, traced lines must exist, fixes must pass the repo's own tests. Failover, retries, a daily budget and a credits pause. Six ecosystems each read with their own tooling. 154 engine tests | [Evaluation](https://teire.vercel.app/docs/nemotron/evaluation) · [Verification](https://teire.vercel.app/docs/build/verification) · [Receipts and budget](https://teire.vercel.app/docs/nemotron/receipts) |
| **Design** — _"Does the project deliver a complete, coherent product experience not just a technical proof of concept?"_                                                                                                                  | Install → onboarding PR → fix PRs with evidence → Dashboard issue → commands. A public scan and dry run for anyone. A web dashboard, a public change catalog, a CLI and MCP server, a live trust page, and docs                                                           | [teire.vercel.app](https://teire.vercel.app) · [Quickstart](https://teire.vercel.app/docs/guide/quickstart) · [Dashboard](https://teire.vercel.app/docs/guide/dashboard)                                    |
| **Potential Impact** — _"Does the project make a credible, specific case for solving a real problem for a real audience and does the solution actually address it based on what's demonstrated?"_                                         | Any team whose code calls AI models or depends on packages. OpenAI's October 2026 shutdowns broke real projects the day they happened. Teire turns a notice into a verified PR, and says when it can't                                                                    | [The problem](#the-problem) · [Compared with Dependabot and Renovate](https://teire.vercel.app/docs/guide/comparison)                                                                                       |
| **Quality of the Idea** — _"Is this a creative, non-obvious use of Nebius Token Factory or AI Cloud model(s), and NVIDIA Nemotron or other NVIDIA open source models and does the team show genuine understanding of the problem space?"_ | Nemotron is used where text has to become structured fact (change pages, release notes, wrapped IDs), and code checks everything it says. Teire says "not affected" only with type-level coverage. Evidence, never a model, decides ready vs draft                        | [Providers and the quote gate](https://teire.vercel.app/docs/ecosystems/providers) · [Troubleshooting: why no PR?](https://teire.vercel.app/docs/guide/troubleshooting)                                     |
| **README: "highlight how you've used NVIDIA Nemotron … and where Token Factory accelerated your workflow"**                                                                                                                               | See [Built on](#built-on) and _Where Token Factory helped_ above                                                                                                                                                                                                          | this README                                                                                                                                                                                                 |
| **Open source licence, visible in About**                                                                                                                                                                                                 | MIT                                                                                                                                                                                                                                                                       | [LICENSE](LICENSE)                                                                                                                                                                                          |

## Proof

**The evaluation.** Each case ran the engine's fix path, the one the worker calls, with each model as the agent: fetch, assess, fix, verify in the sandbox. Every case's repository is public as a folder of [teire-dev/examples](https://github.com/teire-dev/examples).

|                                                 | Cases | Nemotron 3 Ultra     | Nemotron 3 Super                           |
| ----------------------------------------------- | ----- | -------------------- | ------------------------------------------ |
| Package majors across all six ecosystems        | 12    | 12 verified          | 12 verified                                |
| Model retirements (OpenAI, Groq, Token Factory) | 3     | 3 verified           | 3 verified, 1 rejected on reading the diff |
| Model retirements in Go, Java, Ruby and Rust    | 4     | 4 verified           | not run                                    |
| Clean repositories (should not be affected)     | 6     | none called affected | —                                          |

Super costs 3 to 7 times less per run, but on one case it passed the tests by replacing the model call with a keyword rule. So Ultra writes the fixes and Super is the failover. Token Factory retires Nemotron 3 Super on 2026-11-09; its replacement, Nemotron 3.5 Super, is the failover now and passed the fix job 3 of 3 times ([measured](https://teire.vercel.app/docs/nemotron/evaluation#the-failover-since-2026-10-30-nemotron-35-super)). Every row, with attempts, steps and cost: [Evaluation](https://teire.vercel.app/docs/nemotron/evaluation).

**On a real repository.** [teire-dev/serve-handler#10](https://github.com/teire-dev/serve-handler/pull/10), opened by the installed App on a fork of `vercel/serve-handler`: a transitive `browserslist` had two advisories, dependabot-core's updater couldn't move it within its parents' ranges, so Teire pinned the fix with a Yarn `resolutions` override, and the repo's own 70 tests passed before and after.

**Verification on Token Factory Sandboxes**, one baseline per ecosystem on images built inside Token Factory: npm, Python, Go, Cargo, Bundler and Maven all pass ([measured](https://teire.vercel.app/docs/build/token-factory-sandboxes)).

**Live.** [/trust](https://teire.vercel.app/trust) reads the worker's heartbeat, credits, model routing and spend from the running system.

## The rest of Teire

| Surface                  | What it does                                                                                                                                                                                                                                                                                 | Guide                                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding PR            | **Configure Teire** lists what Teire found and the PRs it will open; merging it turns Teire on                                                                                                                                                                                               | [Quickstart](https://teire.vercel.app/docs/guide/quickstart)                                                                                                     |
| Dashboard issue          | One issue per repository: deadlines, what's affected, open PRs; tick a box to fix, rebase or rescan                                                                                                                                                                                          | [Dashboard](https://teire.vercel.app/docs/guide/dashboard)                                                                                                       |
| `@teire` commands        | `rescan`, `fix`, `ignore`, `rebase`, `recreate`, `explain`, `config`, `pause`, `resume`, `wrong`, `help`                                                                                                                                                                                     | [Commands](https://teire.vercel.app/docs/guide/commands)                                                                                                         |
| Web dashboard            | Your estate as one map (changes → repositories → what is open; drag a change onto a repository to fix it), every PR and run as a breadcrumb trail, config as a board, and buttons for the main commands                                                                                      | [Dashboard](https://teire.vercel.app/docs/guide/dashboard)                                                                                                       |
| Ask Teire                | Ask about your repositories, findings, runs and changes; answers come back as the dashboard's own flows, and it changes something only when you click Confirm (Nemotron 3 Ultra on Token Factory)                                                                                            | [Ask Teire](https://teire.vercel.app/docs/guide/ask-teire)                                                                                                       |
| Public change catalog    | Every confirmed change Teire has read, quoted from its source: [/changes](https://teire.vercel.app/changes) shows each source Teire watches with its last check, what is new and 30 days of pickups; provider pages draw a retirement timeline, package pages a version rail; and a JSON API | [Providers](https://teire.vercel.app/docs/ecosystems/providers)                                                                                                  |
| `teire.yml`              | What to upgrade, PR limits, custom checks, your own API's changelog or OpenAPI spec                                                                                                                                                                                                          | [Configuration](https://teire.vercel.app/docs/guide/configuration)                                                                                               |
| CLI, MCP and Agent Skill | `npx teire-cli scan` in any checkout or on any public repository (`scan owner/name`), `teire check` for CI, the same tools over MCP, and `npx skills add teire-dev/teire --skill teire-cli` for coding agents ([`teire-cli` on npm](https://www.npmjs.com/package/teire-cli))                | [CLI](https://teire.vercel.app/docs/build/cli) · [MCP](https://teire.vercel.app/docs/build/mcp) · [Agent Skill](https://teire.vercel.app/docs/build/agent-skill) |
| Runtimes                 | End-of-life notices for Node.js, Python, Go, Ruby, Java and Rust                                                                                                                                                                                                                             | [Runtimes](https://teire.vercel.app/docs/ecosystems/runtimes)                                                                                                    |

## Run it locally

You need Node.js 22+, pnpm 11, Docker for Postgres, a [Token Factory](https://tokenfactory.nebius.com) API key, a Cloudflare account with Containers for the sandbox, and a GitHub organisation for the App.

```bash
pnpm install
cp .env.example .env.local
ln -s ../../.env.local apps/web/.env.local

# Postgres 17; the worker applies migrations when it starts
docker run -d --name teire-pg -e POSTGRES_PASSWORD=teire -e POSTGRES_DB=teire -p 5432:5432 postgres:17
# .env.local: DATABASE_URL=postgres://postgres:teire@127.0.0.1:5432/teire

# A GitHub App for your organisation; its credentials and a smee.io webhook URL go into .env.local
TEIRE_GITHUB_ORG=your-org node scripts/register-github-app.mjs

# The verification sandbox on Cloudflare Containers
cd apps/sandbox && npx wrangler deploy && npx wrangler secret put TEIRE_SANDBOX_KEY && cd ../..
# .env.local: TEIRE_SANDBOX_URL=<the Worker URL>, TEIRE_SANDBOX_KEY=<the same key>

# Optional: the dependency updater (dependabot-core under gVisor) on a Linux host with Docker.
# It installs a second Docker daemon beside yours and checks yours still works; read
# apps/resolver/THREAT-MODEL.md first.
#   sudo apps/resolver/host/install.sh install
# .env.local: TEIRE_RESOLVER_URL=http://<the host's address>:8787, TEIRE_RESOLVER_SECRET from /etc/teire-resolver/env,
#   TEIRE_RESOLVER_ECOSYSTEMS=npm,pypi,go,cargo,rubygems,maven (the ecosystems whose dependency files the updater decides; for
#   them a stop is final and an unreachable updater queues). Ecosystems not listed, or no updater at
#   all, use Teire's own manifest and lockfile edits.

pnpm --parallel --filter ./apps/web --filter ./apps/worker dev   # web on :3000, worker on :8080
npx smee-client --url <SMEE_URL from .env.local> --target http://localhost:3000/api/github/webhooks
```

Then install your App on a repository from its GitHub page. Every variable is described in [`.env.example`](.env.example).

```bash
pnpm typecheck && pnpm lint && pnpm test   # engine, worker and web
```

## Repository layout

| Path                                   | What lives here                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`apps/web`](apps/web)                 | The Next.js app: landing, public scan and dry runs, run pages, the change catalog, dashboard, trust, docs, and the GitHub webhook endpoint |
| [`apps/worker`](apps/worker)           | Webhooks from the outbox, scans, fix runs, `@teire` commands, the Dashboard issue, the reliability ticker                                  |
| [`apps/sandbox`](apps/sandbox)         | The Cloudflare Containers sandbox: six images (Node, Python, Go, Rust, Ruby, JVM) and its egress policy                                    |
| [`packages/engine`](packages/engine)   | Everything that reads, diffs, locates, fixes and verifies; the worker, the CLI and the MCP server all call it                              |
| [`packages/db`](packages/db)           | Postgres schema and migrations                                                                                                             |
| [`packages/cli`](packages/cli)         | `teire scan`, `teire check`, `teire mcp`                                                                                                   |
| [`packages/helpers`](packages/helpers) | The Python and Go helpers the engine runs for griffe, jedi, apidiff and go/types                                                           |
| [`catalog/schema`](catalog/schema)     | JSON Schemas of a change record, a provider and a dependency instance                                                                      |
| [`fixtures`](fixtures)                 | Small repositories and pages the engine's tests run against                                                                                |

## Credits

- Registry data from [deps.dev](https://deps.dev), advisories from [OSV](https://osv.dev), the [GitHub Advisory Database](https://github.com/advisories) and [ruby-advisory-db](https://github.com/rubysec/ruby-advisory-db), runtime dates from [endoflife.date](https://endoflife.date).
- Provider changes are quoted from each provider's own pages.
- Code adapted from other open-source projects is credited, with its licence, in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Honest limits

- **Private repositories verify on Cloudflare Containers, not Token Factory Sandboxes.** A run chains saved sandbox images (checkout, install, each check) and needs them only while it runs, but Token Factory keeps them for 180 days (after that, untagged ones may be deleted) and has no call to delete them sooner. Public code is public anyway, so public repositories and dry runs verify there.
- **Real-repository PRs don't cover every package manager yet.** dependabot-core's updater decides the dependency files in all six ecosystems on the deployed worker, and every manager passed the updater pilot; the fork files in [`smoke/forks/`](smoke/forks) record which have a PR on a real repository so far.
- **Only major upgrades** get an API diff and a line search; minor and patch upgrades are plain bumps the sandbox decides.
- **Ruby at scan time is matched by name,** so a site that only shares a removed method's name reads "inconclusive", and the upgrade's sandbox run decides. Rust and Java/Kotlin are resolved by type at scan time when the sandbox can build the project (rust-analyzer's index, the compiled classes); when it can't, their sites stay syntactic and never read "not affected".
- **Model and API fixes** are detected and verified in all six ecosystems' projects. The evaluation proves them in JavaScript/TypeScript and Python; real forks add Go ([teire-dev/nlsh#6](https://github.com/teire-dev/nlsh/pull/6)) and Ruby ([teire-dev/bristow#9](https://github.com/teire-dev/bristow/pull/9), 143 of 143 tests). Rust and Java/Kotlin aren't proven on a real repository yet.
- **Android projects run their debug unit tests;** instrumented tests (`androidTest`) need a device or emulator and don't run.
- **Provider parameter and API-version records** don't become findings on their own.
- **Runtimes come from the repository** (`.nvmrc`/`engines`, `.python-version`/CI/`requires-python`, `rust-toolchain`, Go's `toolchain`, Ruby pins and lockfiles, the JDK from CI), within what the sandbox provides: Node 18–24, Python 3.10–3.13, any Rust channel, Go via `GOTOOLCHAIN`, Ruby 3.2–4.0. A version outside that runs on the nearest one, and the PR says so.

The full list, per ecosystem, is in the [docs](https://teire.vercel.app/docs/ecosystems).

## License

[MIT](LICENSE)
