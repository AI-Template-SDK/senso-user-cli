# Configuration

Everything that changes what the CLI does without changing its arguments: eight
environment variables, six global flags, and one file.

## Environment variables

| Variable                | Purpose                                                                                           | Default                          | What happens without it                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `SENSO_API_KEY`         | The organization API key, when you would rather not `login`                                       | unset                            | The stored key in `config.json` is used. If there is none either, every command exits 3 |
| `SENSO_BASE_URL`        | Point the CLI at a different Senso API                                                            | `https://apiv2.senso.ai/api/v1`  | The production API. Set it to reach a staging environment or a local mock               |
| `SENSO_CONFIG_DIR`      | Relocate the directory holding `config.json`                                                      | the platform config path (below) | The platform default. Set it for per-project credentials, and for tests                 |
| `SENSO_DEBUG`           | `1` logs every request, status and duration to stderr, and prints the underlying stack on failure | unset                            | No request logging. This is the first thing to turn on when a command misbehaves        |
| `SENSO_NO_UPDATE_CHECK` | `1` never contacts the npm registry                                                               | unset                            | The registry is asked once every 24 hours, on stderr, best-effort                       |
| `SENSO_GAP_SIGNALS`     | `off` sends `X-Senso-Signals: off` on every search, keeping it out of the gap report              | unset                            | Searches stay eligible: an answering search that finds nothing is filed as a gap        |
| `NO_COLOR`              | Any non-empty value disables ANSI color on both streams                                           | unset                            | Color when the stream is a TTY (see the note below)                                     |
| `FORCE_COLOR`           | Any non-empty value enables color even when stdout is not a TTY                                   | unset                            | Color is decided by TTY detection                                                       |

Only `SENSO_*` and the two color variables are read. Exhaustively, the reads in
`src/`:

| Read at                                                | Variable                |
| ------------------------------------------------------ | ----------------------- |
| `src/lib/config.ts` (module load)                      | `SENSO_CONFIG_DIR`      |
| `src/lib/config.ts` `getApiKey`                        | `SENSO_API_KEY`         |
| `src/lib/config.ts` `getBaseUrl`                       | `SENSO_BASE_URL`        |
| `src/lib/api-client.ts` `debugEnabled`                 | `SENSO_DEBUG`           |
| `src/lib/run-action.ts` `resolveContext` and its catch | `SENSO_DEBUG`           |
| `src/cli.ts` (top-level catch)                         | `SENSO_DEBUG`           |
| `src/utils/updater.ts` `checkForUpdate`                | `SENSO_NO_UPDATE_CHECK` |
| `src/lib/gap-signals.ts` `envDisablesSignals`          | `SENSO_GAP_SIGNALS`     |

`NO_COLOR` and `FORCE_COLOR` are not read by this codebase directly; picocolors
reads them, and `src/utils/branding.ts` inherits the same decision through
`gradient-string` and `boxen`. An end-to-end test asserts that `NO_COLOR=1`
produces no ANSI escape on either stream.

Notes on the ones with sharp edges:

- **`SENSO_CONFIG_DIR` is resolved once, at module load.** Nothing in a single
  invocation changes it, and re-reading the environment per call invites a test
  that passes only because of the order its cases ran in. Changing it mid-process
  requires re-importing `src/lib/config.ts`.
- **`SENSO_API_KEY=` (empty) falls through** to the stored key rather than
  authenticating with `""`. `getApiKey` and `getBaseUrl` use `||`, not `??`, with
  an `eslint-disable` on exactly those two functions saying why.
- **`SENSO_DEBUG=1` prints every request URL, query parameters included.** The
  API key is never printed, not even a prefix — a prefix identifies an
  organization, and debug output gets pasted into support threads. Only the exact
  string `1` enables it.
- **`SENSO_GAP_SIGNALS` refuses a value it does not recognize.** `off`, `false`,
  `0`, `no`, `skip` and `none` opt out; `on`, `true`, `1`, `yes`, `record` and an
  empty value leave searches eligible; anything else makes every search exit 2.
  The API reads any value that is not a "no" as eligible, so a typo accepted
  silently would file every probe as a gap while the caller believed they had
  opted out. It can only turn signals off — `--no-gap-signals` does the same for
  one search, and nothing forces signals on against it.
- **`SENSO_NO_UPDATE_CHECK` likewise only recognizes `1`.** Any other value, `0`
  included, leaves the check on.
- **`FORCE_COLOR` is truthiness-checked by picocolors**, so `FORCE_COLOR=0` turns
  color _on_. Use `NO_COLOR=1` to turn it off; `NO_COLOR` wins over `FORCE_COLOR`.
  picocolors also enables color when `CI` is set, and on Windows.
- **picocolors honors a `--no-color` argument too, but you cannot use it here.**
  It is not a registered option, and Commander rejects unknown flags with exit 2.
  `NO_COLOR=1` is the supported way.

## Global flags

Accepted by every command; the generated
[command reference](reference/commands.md#global-options) lists them alongside
each command's own options.

| Flag                | Effect                                                                    |
| ------------------- | ------------------------------------------------------------------------- |
| `--api-key <key>`   | The credential for this invocation. Highest precedence                    |
| `--base-url <url>`  | The API base for this invocation, including the `/api/v1` path prefix     |
| `--output <format>` | `json`, `table` or `plain`. Defaults to `plain`; an unknown value exits 2 |
| `--quiet`           | Suppresses non-essential stderr output. Never changes stdout              |
| `--no-update-check` | Declared, but currently not read — see below                              |
| `-v, --version`     | Prints the version to stdout and exits 0. No request, no config directory |
| `-h, --help`        | Prints help, the exit-code table and the environment table, and exits 0   |

Three things about these are worth knowing:

- **`--output json` implies `--quiet`.** A caller that asked for a
  machine-readable payload did not also ask for progress commentary next to it,
  and the banner is suppressed entirely rather than merely moved.
- **`--api-key` and `--base-url` are read once** into the context and passed to
  `apiRequest`; a command never reaches for them itself.
- **`--no-update-check` has no effect today.** It is registered on the root
  command, but the `preAction` hook decides whether to check by looking at
  `--quiet` and `--output` only, and never consults the parsed value. What does
  suppress the check: `SENSO_NO_UPDATE_CHECK=1`, `--quiet`, `--output json`, the
  commands `login`, `logout`, `uninstall` and `update`, and `--version` /
  `--help`, which never dispatch an action.

## The config file

One JSON file named `config.json`. `SENSO_CONFIG_DIR` overrides the directory
outright; otherwise the location comes from `env-paths("senso", { suffix: "" })`:

| Platform | Directory                                      |
| -------- | ---------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/senso`, or `~/.config/senso` |
| macOS    | `~/Library/Preferences/senso`                  |
| Windows  | `%APPDATA%\senso\Config`                       |

`senso whoami` prints the resolved path, which is the reliable way to find it on
a machine you are debugging.

### Shape

Every field is optional, and every one is re-derivable. `login` writes the
credential and the organization fields; the update checker writes the last two.

```json
{
  "apiKey": "tgr_...",
  "baseUrl": "https://apiv2.senso.ai/api/v1",
  "orgName": "Acme",
  "orgId": "0d9b...",
  "orgSlug": "acme",
  "isFreeTier": false,
  "lastUpdateCheck": "2026-09-09T12:00:00.000Z",
  "latestVersion": "0.12.0"
}
```

A missing file is the normal first-run state, and a corrupt one is not worth
failing a command over: `readConfig()` returns `{}` for both, and the CLI behaves
as though nothing was stored.

### Permissions

The file is created with mode `0600` — owner read/write, nothing else. Node
applies a mode only when it creates the file, which is why every write goes
through the single `writeConfig()` function rather than being open-coded.

`updateConfig()` re-reads immediately before writing, in one synchronous block.
The update checker runs concurrently with the command that started it, and that
read-then-write is what stops it from writing back a snapshot taken before
`login` stored a key.

### Credential precedence

Resolved per call by `getApiKey()`:

1. `--api-key`
2. `SENSO_API_KEY`
3. `apiKey` in `config.json`

An empty value at any level falls through to the next. If all three are empty the
command exits **3** with `Not authenticated: no API key found.` before making any
request.

`getBaseUrl()` follows the same order with one more step at the end:
`--base-url`, `SENSO_BASE_URL`, `baseUrl` in `config.json`, then
`https://apiv2.senso.ai/api/v1`.

`senso login` needs a terminal — without one it exits 2 immediately and names the
two ways to authenticate that do not, rather than waiting forever on a keypress
that cannot arrive. In CI and in an agent, set `SENSO_API_KEY`.

## Things the CLI does not read

There is no config file format beyond the one above: no `.sensorc`, no
`senso.config.js`, no per-directory config discovery, and no profile support. A
second set of credentials is a second `SENSO_CONFIG_DIR`.

`HTTP_PROXY` and `HTTPS_PROXY` are not read either. `fetch` in Node does not honor
them without an explicit dispatcher, and the CLI installs none.
