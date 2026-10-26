# teire-cli

Teire from the terminal. `teire scan` checks a repository for the dependency and API changes that affect it. It covers every package across npm, PyPI, Go, Cargo, RubyGems and Maven/Gradle, the API hosts and model IDs the code calls, and the Node.js and Python versions it runs on. It reports each change with the exact lines it reaches. `teire check` turns the result into a CI gate, and `teire mcp` gives coding agents the same tools.

The scan uses the same engine calls as the Teire GitHub App, so the findings match the dashboard.

```bash
npx teire-cli scan
```

Or install it once, and the command is `teire`:

```bash
npm install -g teire-cli
teire scan
```

```
Teire ~/src/support-bot
PyPI 2 direct + 20 transitive · 6 files · 10.9 s
APIs: Anthropic

Deadlines
  2025-07-21  claude-2.1 shutdown  passed · affected

Affected (2)
  ● claude-2.1 shutdown  priority 1 · 1 site
    models/anthropic
    app/support.py:15
  ● anthropic 1.15.0 removes 70 API(s)  priority 3 · 4 sites
    pypi/anthropic/1.15.0
    app/support.py:3
    app/support.py:14
    …
```

## Commands

| Command                                                                          | What it does                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teire scan [path] [--json] [--all]`                                             | Scans a checkout (default: the current directory). `--all` also lists the changes that don't reach your code.                                                                                   |
| `teire check [path] [--fail-on affected\|deadline\|any] [--within 90]`           | Exits 1 when the gate fails. `affected`: any change reaches your code. `deadline`: an affected change has a shutdown date within `--within` days. `any`: anything affected or left for a human. |
| `teire explain <change-id> [--json]`                                             | Shows one change record: summary, replacement, migration notes, and the quoted sources it was confirmed against.                                                                                |
| `teire changes [--provider p] [--ecosystem e] [--kind k] [--subject s] [--json]` | Lists Teire's public catalog of confirmed changes.                                                                                                                                              |
| `teire mcp`                                                                      | Serves `scan_path`, `explain_finding`, `list_changes` and `get_change` to coding agents over stdio.                                                                                             |

## In CI

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx -y teire-cli check --fail-on deadline --within 60
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## For coding agents (MCP)

Claude Code:

```bash
claude mcp add teire -- npx -y teire-cli mcp
```

Cursor, Windsurf and other clients take the same command in their MCP config:

```json
{ "mcpServers": { "teire": { "command": "npx", "args": ["-y", "teire-cli", "mcp"] } } }
```

The agent can then scan the repository it is editing, ask why a finding matters (`explain_finding` returns the change with its quoted source and every call site), and look up a provider's deprecations before it writes code against them.

## Where the answers come from

- **Packages.** Teire reads the registries directly and diffs the API surface of your installed version against the target. That uses the same tools the service runs: TypeScript declarations, griffe for Python, apidiff for Go, cargo-semver-checks for Rust, Prism for Ruby, and japicmp for JVM bytecode. It locates every use in your code. Security advisories come from OSV (which carries RustSec and the Go vulnerability database), GitHub's advisory database and ruby-advisory-db.
- **API hosts and models.** Teire answers from its public catalog, where each change is confirmed against a quote from the provider's own page. For a provider the service hasn't read yet, the CLI reads that provider's pages itself through the same quote gate. Hand-written readers (OpenAI, Anthropic, Google Gemini, Nebius Token Factory, Stripe) need no key. Discovered providers need Nemotron (`TOKENFACTORY_API_KEY`).
- **Runtimes.** End-of-life dates for the Node.js and Python versions the repo pins.

If a toolchain is missing, the scan says which one and how to get it. It never guesses past one.

| To read         | Needs                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| Python packages | [uv](https://docs.astral.sh/uv) (it supplies Python 3.12 and the helper's pinned packages) |
| Go modules      | Go (`TEIRE_GO` points at a specific binary)                                                |
| Rust crates     | `cargo install cargo-semver-checks --version 0.51.0 --locked`                              |
| Maven/Gradle    | Java 17 or newer (`TEIRE_JAVA`); japicmp is downloaded once and checked against its SHA-1  |

## Environment

| Variable               | Effect                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`         | Higher GitHub rate limits (release notes, advisories, spec history)                                     |
| `TOKENFACTORY_API_KEY` | Nemotron traces model IDs passed through wrappers and registries, and reads discovered providers' pages |
| `TAVILY_API_KEY`       | Searches for the notices of an API host neither the catalog nor the hand-written readers cover          |
| `TEIRE_URL`            | Another Teire deployment (default `https://teire.vercel.app`)                                           |

`.github/teire.yml` (or `teire.yml`) is honoured as the service honours it: `ignore`, `ecosystems`, `paths`, `ignorePaths`, `upgrades.cooldownDays` and declared `sources`.

Requires Node.js 22 or newer. MIT licensed.
