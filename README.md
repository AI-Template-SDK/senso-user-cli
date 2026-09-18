# Senso CLI

[![Testing](https://github.com/AI-Template-SDK/senso-user-cli/actions/workflows/testing.yml/badge.svg)](https://github.com/AI-Template-SDK/senso-user-cli/actions/workflows/testing.yml)
[![npm version](https://img.shields.io/npm/v/@senso-ai/cli.svg)](https://www.npmjs.com/package/@senso-ai/cli)
[![npm downloads](https://img.shields.io/npm/dm/@senso-ai/cli.svg)](https://www.npmjs.com/package/@senso-ai/cli)
[![Node](https://img.shields.io/node/v/@senso-ai/cli.svg)](https://nodejs.org)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

> Infrastructure for the Agentic Web

The command-line interface for [Senso](https://docs.senso.ai). Search your
knowledge base, manage content, run the generation engine and read your GEO
analytics — from a terminal, a script, or an AI agent.

Built for **agents** (Claude Code, Gemini CLI, Codex) as much as for people:
stdout carries only the payload, `--output json` is available on every command,
and failures exit with a code that says what went wrong.

## Install

Requires **Node.js 20.12 or newer**. Works on Linux, macOS and Windows.

```bash
npm install -g @senso-ai/cli
senso --version
```

Or without installing:

```bash
npx @senso-ai/cli --help
```

## 60 seconds

```bash
# 1. Authenticate. Get a key from https://docs.senso.ai
export SENSO_API_KEY=tgr_your_key_here     # or run: senso login

# 2. Ask your knowledge base a question
senso search "what is our refund policy?"

# 3. The same thing, for a program
senso search "what is our refund policy?" --output json | jq -r .answer
```

That third line is the point of this tool. There is no `--quiet` in it because
none is needed: stdout carries the payload and nothing else.

## Using it from an agent

The whole contract, in one place.

**Streams.** stdout is the payload. Everything else — progress, warnings,
errors, the banner — goes to stderr. Redirecting stdout to a file gives you data
or an empty file, never a sentence you have to strip.

**Formats.** Every command takes `--output`:

| Format  | For                | Notes                                           |
| ------- | ------------------ | ----------------------------------------------- |
| `json`  | scripts and agents | The API payload, unmodified. Implies `--quiet`. |
| `table` | reading a list     | Aligned columns; long cells truncated.          |
| `plain` | reading one thing  | Complete and untruncated. The default.          |

**Exit codes.** Branch on these rather than on message text.

| Code | Meaning                        | What to do           |
| ---- | ------------------------------ | -------------------- |
| 0    | Success                        | —                    |
| 1    | The API or the runtime refused | Read the message     |
| 2    | Usage error                    | Fix the command line |
| 3    | Authentication                 | Fix the credential   |
| 4    | Not found                      | Check the ID         |
| 5    | Network failure or timeout     | Retry                |

**Errors are structured too.** Under `--output json`, a failure writes JSON to
stderr and leaves stdout empty:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Authentication failed: the API key was rejected.",
    "status": 401,
    "hint": "Run `senso login` to store a new key, or check SENSO_API_KEY."
  }
}
```

`error.code` is stable. Messages may be reworded; codes are part of the
interface.

**Environment.**

| Variable                  | Purpose                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `SENSO_API_KEY`           | The API key, if you would rather not run `senso login`       |
| `SENSO_BASE_URL`          | Point at a different API                                     |
| `SENSO_CONFIG_DIR`        | Relocate the config file (per-project credentials, or tests) |
| `SENSO_DEBUG=1`           | Log every request and its status to stderr, key redacted     |
| `SENSO_NO_UPDATE_CHECK=1` | Never check npm for a newer version                          |
| `SENSO_GAP_SIGNALS=off`   | Keep every search out of the gap report (probes and tests)   |
| `NO_COLOR`                | Disable color (any value)                                    |

**Teaching an agent to use Senso.** The official agent skills install in one
command:

```bash
senso skills install --all
```

## Commands

**[Full command reference →](docs/reference/commands.md)** — every command,
argument and flag, generated from the CLI itself.

| Group                                                                    | What it does                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `login` `logout` `whoami`                                                | Authentication and the current organization                                     |
| `search`                                                                 | Ask the knowledge base, with an AI answer, raw chunks, or streaming             |
| `kb` `ingest` `content` `website-import`                                 | The knowledge base: upload, browse, organize, verify                            |
| `ctas`                                                                   | Call-to-action cards on published pages                                         |
| `generate` `engine` `generated-content` `destinations` `publish-records` | Generate content and publish it                                                 |
| `analytics`                                                              | GEO metrics for your own organization                                           |
| `industries` `history-imports`                                           | The industry catalog: brand leaderboards, citations, prompt import              |
| `partner`                                                                | Partner-network competitive intelligence (needs a partner key)                  |
| `prompts` `questions` `competitors` `tracked-sources`                    | What gets monitored                                                             |
| `brand-kit` `content-types` `product-lines` `tags`                       | How content is shaped                                                           |
| `evals`                                                                  | Judge text and content against your knowledge base and brand kit                |
| `gaps`                                                                   | What the knowledge base could not answer or back up, and what was done about it |
| `org` `users` `members` `roles` `permissions` `api-keys` `credits`       | Organization administration                                                     |
| `run-config`                                                             | Which models run, and on which days                                             |
| `skills`                                                                 | Install the Senso agent skills                                                  |
| `update`                                                                 | Update this CLI                                                                 |
| `uninstall`                                                              | Remove this CLI, the skills it installed, and the stored API key                |

A few worth knowing about:

```bash
senso search "..." --output json          # answer + sources, for a program
senso search stream "..."                 # tokens as they arrive
senso ingest upload ./policy.pdf          # into the knowledge base
senso analytics summary                   # headline GEO metrics
senso analytics glossary                  # what every metric means
```

### Reading the analytics numbers

`senso analytics` reports how often AI models name your brand and which pages
they cite. The metrics are easy to misread, so
**[docs/analytics.md](docs/analytics.md)** states what each one divides by. The
short version:

- **Share of Voice** divides by mentions of _every_ brand the models named, not
  just your tracked competitors.
- **Citation Rate** and **Coverage** divide by answers that carried at least one
  citation. **Citation Share** divides by total citation instances. They are
  different metrics on different denominators.
- A metric shown as `—` means _not measured_ — its denominator was zero. That is
  not the same as 0%.
- `analytics answers` is a snapshot, not a window: narrowing the dates hides
  results rather than returning older ones.

`senso analytics glossary` is the canonical definition of each metric, its
denominator and its gotcha, straight from the API.

## Configuration

`senso login` stores your key in a JSON file with owner-only permissions:

| Platform | Location                                  |
| -------- | ----------------------------------------- |
| Linux    | `~/.config/senso/config.json`             |
| macOS    | `~/Library/Preferences/senso/config.json` |
| Windows  | `%APPDATA%\senso\Config\config.json`      |

Set `SENSO_CONFIG_DIR` to put it somewhere else. Credentials resolve in this
order: `--api-key`, then `SENSO_API_KEY`, then the config file. `senso login`
needs a terminal; in CI or an agent, set the environment variable.

Because the environment outranks the file, `senso login` can store a key that no
later command sends. `senso whoami` reports which of the three sources supplied
the key it used, and `login` warns when `SENSO_API_KEY` is set to something else.

The CLI checks npm for a newer version once a day and prints a notice on stderr.
`senso update` upgrades it; `SENSO_NO_UPDATE_CHECK=1` turns the check off.

## Development

```bash
nvm use                 # Node 22, per .nvmrc
npm ci
make all                # everything CI runs
```

`make all` is the whole pipeline, and CI invokes the same targets in the same
order — a green `make all` and a green pipeline cannot mean different things.

| Stage      | Command          | What it checks                                            |
| ---------- | ---------------- | --------------------------------------------------------- |
| Lint       | `make lint`      | ESLint (type-aware) and Prettier                          |
| Typecheck  | `make typecheck` | `tsc --noEmit` over src, tests and scripts                |
| Security   | `make security`  | `npm audit`, semgrep, and gitleaks over the full history  |
| Unit       | `make unit`      | Unit, command and policy tests, behind a coverage gate    |
| End-to-end | `make e2e`       | The built bundle, as a subprocess, against a mock API     |
| Build      | `make build`     | The tsup bundle                                           |
| Smoke      | `make smoke`     | Packs the tarball, installs it clean, and runs the binary |

**No test touches the network.** `tests/setup.ts` installs an MSW server with
`onUnhandledRequest: 'error'`, so a request nobody mocked fails the test rather
than quietly reaching a real Senso API with whatever key is in your environment.
That is enforced mechanically, which is why CI needs no secrets and why pull
requests from forks run the full suite.

Run `make help` for every target.

## Repository layout

```
src/
  cli.ts            The bin entry — the only file that ends the process
  program.ts        createProgram(): builds the command tree, no side effects
  commands/         One file per command group
  lib/              api-client, config, errors, output, run-action
  utils/            logger, branding, updater
tests/
  unit/             Library modules, in isolation
  commands/         Each command group, in-process, against a mock API
  e2e/              The built bundle, as a subprocess
  policy/           This repository's own rules
docs/               How it works, and the generated command reference
scripts/            Reference generator, smoke test, pre-commit checks
```

## Documentation

| Document                                                 | Read it when you want to know                                  |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| [docs/README.md](docs/README.md)                         | How this CLI works, in 60 seconds and then in depth            |
| [docs/reference/commands.md](docs/reference/commands.md) | Every command and flag                                         |
| [docs/configuration.md](docs/configuration.md)           | Every environment variable and file it touches                 |
| [docs/architecture.md](docs/architecture.md)             | What happens between argv and the API                          |
| [docs/analytics.md](docs/analytics.md)                   | What every GEO metric divides by, and how to not misread one   |
| [CONTRIBUTING.md](CONTRIBUTING.md)                       | How to make a change, and what a review will send back         |
| [SECURITY.md](SECURITY.md)                               | What this tool holds, and what it does not do                  |
| [CHANGELOG.md](CHANGELOG.md)                             | What changed and when                                          |
| [CLAUDE.md](CLAUDE.md)                                   | Conventions, and the behaviors that look like bugs but are not |

## License

[AGPL-3.0-or-later](LICENSE)
