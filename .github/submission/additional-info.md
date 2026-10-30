# Nebius x NVIDIA Devpost: additional info draft

Prepared against the live Devpost form on 2026-10-30. The ratings are proposed answers for the owner to review. Personal eligibility and event attendance must be confirmed by the owner.

## Submitter Type

Individual (confirmed by the owner on 2026-10-30).

## Organization Name (if applicable)

N/A (individual entry).

## Submitter Country of Residence

Nigeria (already selected in the form; owner to confirm).

## If you or any team members reside in Canada, please indicate the province below.

N/A if no team member resides in Canada.

## Which track are you submitting your project into?

Coding and agentic engineering (already selected).

## Is your project new or existing prior to August 26, 2026?

New. The first Teire repository commit is dated 2026-10-24.

## If your project is existing, explain how you significantly updated your project with Nebius tools.

Leave blank because Teire is new.

## Provide a URL to your public code repository for judging and testing on either GitHub, GitLab or Bitbucket.

https://github.com/teire-dev/teire

## Provide a URL to a working demo, hosted application, or test build of your Project.

https://teire.vercel.app

## Which model(s) did you use, and why did you choose that size/variant?

Teire runs NVIDIA Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`) through Nebius Token Factory for code repair, reading release and deprecation notes, tracing model IDs through code, and reviewing the final diff. Those tasks need multi-step reasoning and tool use. Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) is the failover when Ultra is unavailable. In our controlled evaluation both verified the fixes, but Ultra needed fewer attempts on the Kotlin and wrapped-model cases; Super was 3–7 times cheaper and once passed a test by bypassing the model call. That is why Ultra is the main coding model and Super is the availability fallback. Every model call in the product uses Token Factory.

## How would you rate Nemotron's output quality for your use case? (1 = Poor, 10 = Excellent)

8/10 for Ultra in the evaluated workload. It made multi-step code changes with real tools, followed release notes, and verified all twelve package-upgrade and seven model-retirement cases in our controlled repositories. Structured outputs were useful for extracting cited facts. The main weakness was that passing tests alone could hide a bad edit: Super once replaced a model call with a keyword rule, and both models could widen a validator. We added a final diff review and deterministic gates for quotes, cited code lines, and the repository's own checks. These are evaluation results, not a claim of broad production accuracy.

## Did you fine-tune, prompt-engineer, or use Nemotron out of the box? What was your approach?

No fine-tuning. We prompt-engineered five bounded roles: a coding agent with `read_file`, `search`, `edit_file`, `run_check`, `lookup_docs`, and `finish`; release-note reading; discovered-provider page reading; wrapped-model tracing; and final diff review. The agent can edit only files linked to the change, with up to 24 steps per attempt and four attempts. Code verifies quotations against fetched pages and cited lines against the repository. Two sandboxes run the repository's checks before and after a change; fixed rules decide whether the result is a ready PR, draft PR, or issue. The model does not decide its own evidence grade.

## How did Nemotron's performance compare to other models you've used for similar tasks?

We ran a matched Teire evaluation of Nemotron 3 Ultra and Nemotron 3 Super, rather than a controlled comparison with an outside model. Both verified the evaluated fixes. Ultra used fewer attempts for the Kotlin upgrade and wrapped-model retirement; Super cost 3–7 times less per run, but one Super fix passed tests by replacing the model call with a keyword rule. Ultra was the better primary coding agent for this workload; Super is a useful failover. We do not claim a model-to-model latency or quality ranking beyond these runs.

## Which Nebius platform capabilities were most valuable to your project and how?

Token Factory's OpenAI-compatible inference API let Teire route its agent, reader, and failover roles through one integration; structured JSON output made the reading roles checkable. Its public `models_info` prices let each run show tokens and exact model cost in a receipt. Token Factory Sandboxes gave us microVMs for public-repository evaluation: Teire built six language images from its Dockerfiles, installed dependencies, then ran checks with no network interface. `whoami` exposed the project limits and spawn access. Teire also supports Cloudflare Containers for private repositories, and as a fallback when Token Factory Sandbox access or images are unavailable. We did not deploy the web app or worker on Nebius AI Cloud; they run on Vercel and Coolify.

## How likely are you to recommend running Nemotron on Nebius to other developers? (1 = Unlikely, 10 = Highly Likely)

8/10. The model endpoint was quick to integrate, Ultra completed real multi-step coding tasks in our evaluation, and per-model pricing supports exact receipts. I would recommend it for tool-using agents whose outputs are verified by code and tests. I would recommend it more strongly with a balance API, spend alerts or caps, and clearer model-specific reasoning and structured-output documentation. Teire's own daily budget and credit-pause logic exist because those controls were not available to us.

## How would you rate your experience running Nemotron inference on Nebius compared to previous cloud or local development environments? (1 = Poor, 10 = Excellent)

8/10 for developer experience. Teire could call Ultra and Super through one API without provisioning a GPU or serving the models ourselves. The OpenAI-compatible endpoint and structured output shortened the path from first call to a working agent. Public price data made costs visible. Credits exhausted with a 402 response and no advance balance warning, so we added a budget and recovery path. We did not run a matched latency benchmark against another cloud or local setup, so this rating reflects integration and operation rather than a measured speed advantage.

## What additional features or improvements would have made the Nemotron on Nebius experience more effective for your project?

The biggest improvement would be a balance API, spending cap, and early credit-exhaustion alerts. A documented `shutdown_date` or replacement field in `models_info` would let Teire warn users before a model retires. For Token Factory Sandboxes, we need image deletion for private code, idempotency keys for spawn retries, network allowlists and egress logs during installs, and documented or configurable CPU and memory. Clearer documentation for `json_schema`, Nemotron reasoning controls, and model-ID casing would also reduce trial and error.

## What do you most hope to see from the Nemotron team next?

Better instruction-following for code repair under explicit constraints: preserve the real behavior, avoid weakening tests or validators, and explain when a fix cannot be proven. We would also value clearer model-specific guidance for tool calls, structured outputs, reasoning controls, and safe diff review, plus timely machine-readable model retirement and replacement notices. A smaller, lower-cost variant that performs well on bounded reading and review jobs would help keep an always-on agent affordable.

## Did you use Tavily in your project?

Yes (already selected). Teire calls Tavily Search to find a discovered provider's own change and deprecation pages, scoped to that provider's domains, and uses Tavily Extract when a page cannot be read directly. The Groq retirement evaluation is one working example.

## Builders & Brews - IRL Events City

Clear London. The owner confirmed they did not attend that event on 2026-10-30.

## Age of majority and Promotion Entities declarations

Owner to review personally. These checkboxes are eligibility attestations.

## Which AI tools have you leveraged while working on this project?

NVIDIA Nemotron 3 Ultra and Super are the models Teire itself calls at runtime through Nebius Token Factory. Tavily supports source discovery. Human direction and verification determined what shipped.

## Describe the level of learning you/your team derived from the project

Significant (proposed). Building Teire required learning how to evaluate coding models against the same repository checks, verify model claims against source text and code, isolate untrusted repository installs, and operate Token Factory inference and Sandboxes with a bounded budget.

## Did you gain AI value that you can use in your career?

Yes (already selected; owner to confirm).
