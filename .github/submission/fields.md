# Devpost submission: Teire

Prepared against the owner's live Nebius x NVIDIA Global AI Hackathon form on 2026-10-30. The form allows 200 characters for the elevator pitch, up to 25 Built with tags, 15 gallery images (JPG/PNG/GIF, 5 MB each), and a YouTube or Vimeo demo URL. The long story is in [story.md](story.md); the organizer answers are in [additional-info.md](additional-info.md). The project details page saved the story, tags, and links as a draft; the video and gallery remain open.

## Project name

Teire · 手入れ

## Elevator pitch (174 characters, saved in Devpost)

When a package, API or AI model changes, Teire finds and fixes the code it breaks. Nemotron on Nebius Token Factory writes the fix; your own tests prove it in a pull request.

## Track

Coding and Agentic Engineering Track

## Built with

Nebius, nebius-token-factory, token-factory-sandboxes, nvidia-nemotron, nemotron-3-ultra, nemotron-3-super, tavily, typescript, next.js, react, postgresql, pg-boss, drizzle, github-apps, dependabot-core, gvisor, ast-grep, cloudflare-containers, vercel, coolify, node.js, mcp

## Try it out

- https://teire.vercel.app
- https://teire.vercel.app/scan (public scan and dry run, sign in with GitHub)
- https://teire.vercel.app/docs
- https://github.com/teire-dev/teire
- https://www.npmjs.com/package/teire-cli (`npx teire-cli scan`)

## Video

The owner records and uploads it: a public or unlisted YouTube video under 3 minutes. The Devpost video field is empty; a URL is needed before final submission.

The current [official rules](https://nebiusglobalaihackathon.devpost.com/rules) give a 2026-10-30 10:00 PDT submission deadline (18:00 WAT) and a judging period ending 2026-12-23. Keep the working demo free and unrestricted through that date. The older local hackathon context still says 2026-12-15 and needs updating before relying on it for access planning.

## Image gallery (in this order)

Files are in `.github/assets/` and `.github/assets/captures/`.

| # | File | Caption |
|---|---|---|
| 1 | `banner-dark.png` | When upstream breaks, Teire fixes your code. Beside the line, the live run of a real Teire fix: zod 3.25.76 → 4.6.6 in teire-dev/examples, proven 4/4 → 4/4. |
| 2 | `captures/report-wrapped-models-desktop.png` | A public scan: Groq retired two Llama models; Nemotron traced the IDs through a tier registry to the request. |
| 3 | `captures/dryrun-go-timeline-desktop.png` | A live run: Teire upgrades golang-jwt v4 → v5, the checks fail, and Nemotron 3 Ultra reads, searches and edits until they pass. |
| 4 | `captures/dryrun-go-pr-desktop.png` | The pull request Teire composed: why this repo, what changed upstream (quoted), changes, verification, receipt. |
| 5 | `captures/dryrun-go-verification-desktop.png` | Build, typecheck and 4/4 tests pass before and after the Go fix. This captured run verified on Cloudflare Containers. |
| 6 | `captures/dryrun-go-receipt-desktop.png` | Every Nemotron call on Token Factory, with tokens and $0.1807 model cost; the verification sandbox was Cloudflare Containers. |
| 7 | `model-retirement-dark.png` | The model-retirement journey, numbered, with the real values of the run. |
| 8 | `fix-loop-dark.png` | The fix loop: a deterministic change and checks first, then Nemotron's tools and repeated checks, final review, and the evidence-gated PR. |
| 9 | `system-light.png` | The system: GitHub, web app, Postgres outbox, worker, Nemotron on Token Factory, dependency sources, and verification backends. |
| 10 | `captures/dashboard-desktop.png` | The dashboard as one map: the changes reaching your code, your repositories and what is open now; drag a change onto a repository to fix it there. |
| 11 | `captures/repo-prs-desktop.png` | Every pull request as a breadcrumb trail of its run: the package, dependabot-core, Token Factory, your checks before → after, the review and the PR. |
| 12 | `captures/changes-desktop.png` | The public catalog, live: every source Teire watches with its last check, what is new, and 30 days of pickups. |
| 13 | `captures/trust-desktop.png` | Live status from production: the worker's heartbeat, Token Factory credits and which Nemotron model is answering. |

## Feedback on Nebius Token Factory and NVIDIA models

**The owner should read this and adjust it to their own experience before submitting.**

**What we used them for.**
- Every model call in Teire goes to Token Factory.
- Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`) is the coding agent and the reader: release notes, provider deprecation pages, tracing wrapped model IDs, and reviewing fixes.
- Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) is the failover.
- Token Factory Sandboxes verifies public repositories' upgrades and dry runs (Cloudflare Containers when Token Factory isn't available to the worker). Teire builds its six sandbox images inside Token Factory from its own Dockerfiles, then runs the install and each check as microVMs.

**What worked well.**
- Token Factory's OpenAI-compatible endpoint worked with the AI SDK's OpenAI-compatible provider on the first try. Structured outputs (`json_schema`) worked with Nemotron 3 Ultra.
- One endpoint for all three roles means moving a role between Ultra and Super is a config change.
- The public `models_info` endpoint gives per-token prices, so every pull request carries an exact receipt.
- Token Factory Sandboxes' model fit verification well: a kept microVM's result is the next image, so the install's image is where the checks start and each check starts from the image the one before it left, and `networking.enabled: false` gives the checks no network interface at all. Importing public images worked on the first call, and `whoami` states the limits, which Teire reads and keeps to, instead of leaving us to guess them.
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
  - CPU and memory per instance aren't documented or settable; `whoami` gives the timeout, concurrency and layer size only. We measured them from inside: 4 CPUs, 3.9 GB of memory and a 2 GB `/dev/shm`.
  - The microVM's root filesystem (virtiofs) loses a file that a process writes while a child it started holds the same file open: every Ruby native extension failed with `Errno::EBADF` on `mkmf.log` (reproduced with `gem install bigdecimal -v 3.1.9`). The same build passes on the VM's tmpfs, so Teire builds gems there and copies them into place.

**Would we build with them again?** Yes. Nemotron 3 Ultra did real multi-step repository work, and Token Factory made it a drop-in API.

## Prior work

Teire was started on 2026-10-24, inside the submission period: the repository's first commit is that day. Nothing existed before.

## Builders & Brews city

Leave empty unless the owner attended one.
