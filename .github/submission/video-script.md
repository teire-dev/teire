TEIRE — DEMO SCRIPT
One story, in the order a new user meets it. [Brackets] = where you are in the app. Don't read them.
About 520 spoken words: 2:45–2:55 at your pace. Hackathon rule: under 3:00.

1 · OPENING · 0:00
   [Hackathon page → github.com/teire-dev/teire → teire.vercel.app hero]

Howdy to the Nebius and NVIDIA teams. It's Blockchain Oracle, and I bring to you Teire — when a package, API or
model changes, Teire fixes your code.

2 · THE PROBLEM · 0:09
   [OpenAI's deprecations page → the inspect_ai issue → the gitted issue → a Dependabot PR]

Just a quick question. What happens to your app the day OpenAI retires the model it calls? On October twenty-third,
OpenAI shut down GPT three point five turbo. That day, an eval tool's tests failed. Next morning, a commit tool
failed on every call. The notice was six months old. Nothing connected it to the code. Dependabot bumps versions and
leaves the breakage to you — and a retired model isn't a version, so it opens nothing.

3 · THE SOLUTION · 0:32
   [Landing: hero → the example PR card → the five steps]

So I built Teire. It watches every package your repo uses, across six ecosystems, and every AI and payment API it
calls. When one changes, Teire finds the lines it breaks, NVIDIA Nemotron on Nebius Token Factory fixes them, your
own tests run before and after, and you get a pull request with the proof.

Let me show you, from the start.

4 · SCAN A REPO · 0:52
   [Scan a public repo → Sign in with GitHub → paste teire-dev/demo-go-major → the report]

I sign in with GitHub — no access to my repos needed — and paste a Go service. Here's the report: golang-jwt
version five removes thirty-four APIs, and four of my lines use them, found by type, not by guessing. Plus two
security advisories.

5 · FIX IT · 1:10
   [Dry-run a fix → the live Timeline → The PR tab → Verification → Receipt]

Now the fun part. Dry-run a fix. Watch this. Teire upgrades the module and runs my checks in a sandbox. The build
breaks. Now Nemotron 3 Ultra takes over: it reads my file, looks up the new API, edits the code, and reruns the
checks until they pass.

Here's the pull request it would open: why my repo is affected, the release notes quoted, and the diff.

Let's confirm it. Same build, same vet, same tests — four out of four — before and after, with the network off. And
the receipt: every Nemotron call, under twenty-five cents. It matches. You don't have to trust me, or the model.

6 · THE REST OF TEIRE · 1:47
   [GitHub: Configure Teire PR → a Teire PR → the Dashboard issue → an @teire reply → /changes → Groq provider page → /app → CLI in a terminal → /trust]

And that's just one upgrade. Install the GitHub App and Teire opens one PR per change, ready only when your checks
prove it. A Dashboard issue tracks every deadline; tick a box, or just comment at teire. It catches AI models too:
Groq retired two Llama models, Nemotron traced them through a config registry, picked a replacement, and the tests
went from zero to four. Every change it reads is public, quoted from the source. Plus a dashboard for all your
repos, a CLI for CI, and an MCP server for your coding agent.

7 · UNDER THE HOOD · 2:20
   [Docs → Nemotron on Token Factory → the system diagram → /trust]

Under the hood, it's Nebius Token Factory and NVIDIA Nemotron all the way. Nemotron 3 Ultra writes the fixes, reads
change pages, traces model IDs and reviews its own fixes. Nemotron 3 Super steps in if Ultra is down. Every call is
priced on the receipt.

8 · DOCS AND X · 2:35
   [teire.vercel.app/docs → Anatomy of a Teire PR → x.com/<handle>]

Want to see how it all works? Every ecosystem, every command, the evaluation — it's all in the docs. teire dot
vercel dot app slash docs. And follow us on X, at <handle>.

9 · CLOSE · 2:46
   [teire.vercel.app hero, full face]

It's live right now at teire dot vercel dot app, and it's open source. Teire — when a package, API or model
changes, Teire fixes your code.

---
Have ready
- Signed in on teire.vercel.app with your own GitHub account; one dry run per person per day, so record part 5 in one take, or scan and dry-run first and cut the waiting.
- For part 6, install teire-bot on teire-dev/demo-ai-web beforehand and merge Configure Teire, so a real Teire PR, the Dashboard issue and an @teire reply exist on GitHub.
- The Groq beat and the Nemotron trace are in the docs (Teire / Introduction) if you'd rather not scan a second repo live.
- Fill in the X handle in part 8 (Teire has no X account yet); cut part 8's X line if you don't make one.
