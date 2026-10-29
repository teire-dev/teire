TEIRE — DEMO SCRIPT
One story, in the order a new user meets it. [Brackets] = where you are in the app. Don't read them.
About 537 spoken words: about 2:53 at your pace. Hackathon rule: under 3:00.

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
   [Landing: hero → scroll the run down the line, station by station, to PR #30]

So I built Teire. It watches every package your repo uses, across six ecosystems, and every AI and payment API it
calls. When one changes, Teire finds the lines it breaks, NVIDIA Nemotron on Nebius Token Factory fixes them, your
own tests run before and after, and you get a pull request with the proof.

Let me show you, from the start.

4 · SCAN A REPO · 0:52
   [Scan a repo → Sign in with GitHub → paste teire-dev/examples → the report's flow → the golang-jwt v4 → v5 row: change → your code → fix → PR preview]

I sign in with GitHub — no access to my repos needed — and paste a Go service. Here's the report: golang-jwt
version five removes thirty-four APIs, and four of my lines use them, found by type, not by guessing. Plus two
security advisories.

5 · FIX IT · 1:10
   [Dry-run a fix → the run canvas, tiles lighting one by one → click the checks tile: before → after in the inspector → Receipt tab]

Now the fun part. Dry-run a fix. Watch this. Dependabot's own updater changes the dependency files, and my checks
run in Nebius Token Factory Sandboxes. The build breaks. Now Nemotron 3 Ultra takes over: it reads my file, looks up
the new API, edits the code, and reruns the checks until they pass.

Here's the pull request it would open: why my repo is affected, the notes quoted, the diff.

Let's confirm it. Same build, same vet, same tests — four out of four — before and after, in microVMs with no network
at all. And the receipt: every Nemotron call, under twenty-five cents. It matches. You don't have to trust me, or the
model.

6 · THE REST OF TEIRE · 1:47
   [github.com/teire-dev/serve-handler/pull/10 → the Dashboard issue → an @teire reply → /changes (the watching band) → Groq's retirement timeline → /app: the estate map, drag a change onto a repo → ⌘I Ask Teire → CLI in a terminal]

And that's just one upgrade. Install the GitHub App and Teire opens real pull requests, like this one on a fork of
Vercel's serve-handler: a security fix Dependabot couldn't make, so Teire pinned it, and seventy tests proved it. A
Dashboard issue tracks every deadline; tick a box, or comment at teire. It catches AI models too, in all six
languages: Groq retired two Llama models, Nemotron traced them through a config registry, and the tests went from
zero to four. Plus a dashboard that draws everything as one map, Ask Teire to question it, a CLI for CI, and an MCP server for your coding agent.

7 · UNDER THE HOOD · 2:20
   [Docs → Nemotron on Token Factory → the system diagram → /trust]

Under the hood, it's Nebius and NVIDIA all the way. Nemotron 3 Ultra on Token Factory writes the fixes, reads change
pages and reviews its own work, with Super as the failover. Token Factory Sandboxes runs your checks, on images
Teire builds inside it. Every call is priced on the receipt.

8 · DOCS AND X · 2:35
   [teire.vercel.app/docs → How Teire works (its flow) → x.com/<handle>]

Want to see how it all works? It's all in the docs: teire dot vercel dot app slash docs. And follow us on X, at <handle>.

9 · CLOSE · 2:46
   [teire.vercel.app hero, full face]

It's live right now at teire dot vercel dot app, and it's open source. Teire — when a package, API or model
changes, Teire fixes your code.

---
Have ready
- Signed in on teire.vercel.app with your own GitHub account; one dry run per person per day, so record part 5 in one take, or scan and dry-run first and cut the waiting.
- For part 6, the real PR is github.com/teire-dev/serve-handler/pull/10, and its Dashboard issue is #5 on the same fork (teire-bot is installed on teire-dev).
- The dry run in part 5 verifies on Token Factory Sandboxes: the run page's Sandbox row says so.
- The Groq beat and the Nemotron trace are in the docs (What Teire does) if you'd rather not scan a second repo live.
- Ask Teire in part 6 needs a signed-in account with today's $0.50 allowance left; ask "What needs me today?" once before recording so the answer is warm.
- Fill in the X handle in part 8 (Teire has no X account yet); cut part 8's X line if you don't make one.
