# Senso CLI — how it works

The [root README](../README.md) is the user-facing introduction: install it, use
it, and the contract an agent depends on. These documents are the other half —
how the thing is built, and why it is built that way.

## The 60-second version

- **One bundle, one process, no state.** `npm install -g @senso-ai/cli` puts a
  single tsup-built ESM file at `dist/cli.js`. An invocation parses argv, makes
  one or two HTTP requests, prints, and exits. Nothing runs between invocations
  and nothing is left behind except the config file.
- **One config file.** `config.json` in the platform's configuration directory,
  mode `0600`, holding the API key, which organization it belongs to, and when
  npm was last asked for a newer version. That is the whole on-disk footprint.
- **One HTTP client.** Every command is flag validation plus a call to
  `apiRequest()` in `src/lib/api-client.ts`: one `fetch`, an `X-API-Key` header,
  a 30-second timeout, and a cast of the parsed JSON body.
- **One output contract, one error path.** stdout carries the payload and
  nothing else; the banner, progress, warnings and errors are stderr. `emit()`
  renders the payload as `json`, `table` or `plain`. A command that fails throws
  a `CliError`, and its exit code — not its message — is what a caller branches
  on.

## The documents

| Document                                       | Read it when you want to know                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)             | What happens between argv and the API, and what each layer owns                       |
| [configuration.md](configuration.md)           | Every environment variable, global flag and file the CLI reads or writes              |
| [development.md](development.md)               | Setup, the `make` stages, what each test layer covers, and how to add a command       |
| [releasing.md](releasing.md)                   | How a version is cut, what the publish workflow checks, and how to undo a bad release |
| [reference/commands.md](reference/commands.md) | Every command, argument and flag. Generated from the command tree by `make reference` |

The command reference is generated, never hand-edited: it was the README's
hand-maintained command list drifting 89 subcommands behind the code that made
generating it worth the script.

Design notes and the hardening plan this documentation set came from live in
[`plans/`](plans/). They record what was decided and why, and they are not kept
current with the code — when a plan and one of the documents above disagree, the
document is the one that was checked against the source.

## Where the rest is

The root documents cover the surrounding rules rather than the mechanism:
[CONTRIBUTING.md](../CONTRIBUTING.md) for how to make a change,
[SECURITY.md](../SECURITY.md) for what the tool holds and what leaves your
machine, [CLAUDE.md](../CLAUDE.md) for the conventions and the behaviors that
look like bugs but are not, and [CHANGELOG.md](../CHANGELOG.md) for what changed
and when.
