# Devpost submission: Teire

Ready-to-paste text for each field of the Nebius x NVIDIA Global AI Hackathon form. The form itself was not readable without the owner's login, so field limits are unverified. Devpost's usual limit of 200 characters for the elevator pitch is respected. The long story is in [story.md](story.md).

## Project name

Teire

## Elevator pitch (189 characters)

When a package, API or model changes, Teire fixes your code: a Nemotron agent on Nebius Token Factory edits what a swap can't, your own tests run before and after, and a PR shows the proof.

## Track

Coding and Agentic Engineering Track

## Built with

nebius-token-factory, token-factory-sandboxes, nvidia-nemotron, nemotron-3-ultra, nemotron-3-super, dependabot-core, gvisor, tavily, typescript, node.js, next.js, react, postgresql, pg-boss, drizzle, cloudflare-containers, github-apps, ast-grep, vercel, coolify, fumadocs

## Try it out

- https://teire.vercel.app
- https://teire.vercel.app/scan (public scan and dry run, sign in with GitHub)
- https://teire.vercel.app/docs
- https://github.com/teire-dev/teire
- https://www.npmjs.com/package/teire-cli (`npx teire-cli scan`)

## Video

The owner records and uploads it: a public YouTube video under 3 minutes. Paste its link here.

## Image gallery (in this order)

Files are in `.github/assets/` and `.github/assets/captures/`.

| # | File | Caption |
|---|---|---|
| 1 | `banner-dark.png` | When a package, API or model changes, Teire fixes your code. Beside the line, a real Teire PR replacing a retired OpenAI model, verified 1/3 → 3/3. |
| 2 | `captures/report-wrapped-models-desktop.png` | A public scan: Groq retired two Llama models; Nemotron traced the IDs through a tier registry to the request. |
| 3 | `captures/dryrun-go-timeline-desktop.png` | A live run: Teire upgrades golang-jwt v4 → v5, the checks fail, and Nemotron 3 Ultra reads, searches and edits until they pass. |
| 4 | `captures/dryrun-go-pr-desktop.png` | The pull request Teire composed: why this repo, what changed upstream (quoted), changes, verification, receipt. |
| 5 | `captures/dryrun-go-verification-desktop.png` | Your own checks, before and after, in two sandboxes with the network off. |
| 6 | `captures/dryrun-go-receipt-desktop.png` | Every Nemotron call on Token Factory, with tokens and cost: $0.1807 for this fix. |
| 7 | `model-retirement-dark.png` | The model-retirement journey, numbered, with the real values of the run. |
| 8 | `system-dark.png` | The system: GitHub, the web app, the Postgres outbox, the worker, Nemotron on Token Factory, dependabot-core's updater under gVisor, and verification on Token Factory Sandboxes (public) or Cloudflare Containers (private). |
| 9 | `captures/dashboard-desktop.png` | The dashboard: every repository, deadline and run. |
| 10 | `captures/trust-desktop.png` | Live status from production: the worker's heartbeat, Token Factory credits and which Nemotron model is answering. |

## Feedback on Nebius Token Factory and NVIDIA models

**The owner should read this and adjust it to their own experience before submitting.**

**What we used them for.**
- Every model call in Teire goes to Token Factory.
- Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`) is the coding agent and the reader: release notes, provider deprecation pages, tracing wrapped model IDs, and reviewing fixes.
- Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) is the failover.
- Token Factory Sandboxes verifies every public repository's upgrade and every dry run. Teire builds its six sandbox images inside Token Factory from its own Dockerfiles, then runs the install and each check as microVMs.

**What worked well.**
- Token Factory's OpenAI-compatible endpoint worked with the AI SDK's OpenAI-compatible provider on the first try. Structured outputs (`json_schema`) worked with Nemotron 3 Ultra.
- One endpoint for all three roles means moving a role between Ultra and Super is a config change.
- The public `models_info` endpoint gives per-token prices, so every pull request carries an exact receipt.
- Token Factory Sandboxes' model fit verification well: a kept microVM's result is the next image, so the install becomes the image every check starts from, and `networking.enabled: false` gives the checks no network interface at all. Importing public images worked on the first call, and `whoami` states the limits instead of leaving us to guess them.
- Nemotron 3 Ultra as a coding agent was the standout. In our evaluation it verified every fix across npm, PyPI, Go, Rust, Ruby, Java and Kotlin, with fewer attempts than Super on the Kotlin and wrapped-model cases. Super was 3 to 7 times cheaper and a solid failover, but once it passed the tests by bypassing the model call.

**What needs work.**
- **No balance API or spend cap.** On 2026-10-25 every call started returning `402 credit_balance_exhausted` with no warning, so we built our own daily budget and a credits pause.
- **Reasoning controls aren't documented for Nemotron.** We found `enable_thinking` and `force_nonempty_content` in NVIDIA's model card, not in the Token Factory docs.
- **Two docs inconsistencies:**
  - The spec's `response_format` description says only `json_object` or `text` are supported, but `json_schema` works.
  - Model ID casing differs between Ultra (`Nemotron-3-Ultra…`) and Super (`nemotron-3-super…`).
- **No retirement fields in `models_info`.** Retirements are only in prose notices linked from `llms.txt`. A `shutdown_date` field would let tools like Teire warn every user before a model goes away.
- **Onboarding friction.**
  - Billing setup needs a card from a supported country, and Nigeria is not supported.
  - The hackathon promo code arrived in Gmail's Promotions tab, where it was easy to miss.
- **Token Factory Sandboxes gaps that shaped our design.**
  - No call to delete an image, and images are kept 180 days, so a private repository's code can't go there: private repositories verify on Cloudflare Containers.
  - No idempotency key on spawns, so a spawn whose response is lost can't be retried safely; Teire never retries one.
  - No egress log and no allowlist for an instance's network, so the install's network is either fully open or off.
  - CPU and memory per instance aren't documented or settable; `whoami` gives the timeout, concurrency and layer size only.

**Would we build with them again?** Yes. Nemotron 3 Ultra did real multi-step repository work, and Token Factory made it a drop-in API.

## Prior work

Teire was started on 2026-10-24, inside the submission period: the repository's first commit is that day. Nothing existed before.

## Builders & Brews city

Leave empty unless the owner attended one.
