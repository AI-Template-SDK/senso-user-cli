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

## The device-login state file

`device-auth.json`, in the same directory, exists only while a `senso login` is
waiting to be approved. `senso login` and `senso login --complete` are two
processes, and the second needs the `device_code` the first was given:

```json
{
  "deviceCode": "43 characters of base64url — a bearer secret",
  "userCode": "FXGQ-HKTG",
  "verificationUri": "https://app.senso.ai/cli/verify",
  "interval": 5,
  "expiresAt": "2026-09-21T17:09:00.000Z",
  "baseUrl": "https://apiv2.senso.ai/api/v1"
}
```

The `device_code` goes in a file rather than through stdout because stdout in an
agent's shell is a transcript: a live credential printed there outlives the five
minutes it is good for. The file is `0600`, and it is deleted on success, on
denial, on expiry, on Ctrl-C, by the next `senso login`, by `senso logout` and
`senso uninstall`, and by a sweep that runs on every other command.

That sweep only collects a file that is past its expiry by a **full extra TTL**,
and `senso login` itself is exempt from it. Expiry belongs to the server, which
says so with `expired_token`; a local clock running fast must not let `senso
whoami` delete a login someone is in the middle of approving. For the same
reason `--complete` always makes at least one poll, whatever the local clock
says about `expiresAt`.

`baseUrl` is stored resolved, not as the flag: `--complete` is a different
process and may not be given the same `--base-url` or `SENSO_BASE_URL`, and a
poll sent to a different API than the one that issued the code finds nothing
there.

### Permissions

Every write goes through one helper, `writeSecretFile()`, which never writes
the target in place. It creates a fresh file beside it — `wx`, mode `0600` —
and renames it over the top. One mechanism, three properties:

- **Atomic.** A plain write truncates first and fills second, so an interrupted
  one leaves a file that reads as `{}`. For a key the device flow minted that is
  unrecoverable: the authorization was consumed to produce it and the response
  was the only copy. A rename replaces the whole file or nothing.
- **Never through a symlink.** `wx` (`O_CREAT|O_EXCL`) refuses to open a link,
  and `rename` replaces a link at the destination rather than following it.
- **Never on disk with loose permissions.** `mode` applies only when a file is
  created, so rewriting a `config.json` left `0644` by an older version kept
  those bits for the duration of the write. The new file is `0600` from its
  first byte, and the directory is created — and re-`chmod`ed — `0700`.

The directory `chmod` is best-effort: POSIX modes are effectively ignored on
Windows, where the protection is the per-user ACL on `%APPDATA%`, and a config
directory on a filesystem without them should not fail a write that is as safe
as that filesystem allows. On Windows the rename is retried briefly, because an
antivirus scanner holding the file open makes it fail with `EPERM`.

**`login` merges into this file; it does not replace it.** It records the API
the key was verified against — `--base-url`, then `SENSO_BASE_URL`, then the
stored value — because a key belongs to the environment that minted it, and a
later command without the flag or the variable must still reach that
environment. The default is represented as absence, so a login to the default
API clears a stale `baseUrl` rather than pinning today's default into the file.

`updateConfig()` re-reads immediately before writing, in one synchronous block.
The update checker runs concurrently with the command that started it, and that
read-then-write is what stops it from writing back a snapshot taken before
`login` stored a key.

### Credential precedence

Resolved per call by `resolveApiKey()`:

1. `--api-key`
2. `SENSO_API_KEY`
3. `apiKey` in `config.json`

An empty value at any level falls through to the next. If all three are empty the
command exits **3** with `Not authenticated: no API key found.` before making any
request.

The key and the name of the source it came from are resolved in the same pass, so
they cannot disagree — `getApiKey()` is a thin wrapper over that one resolution.
Keys are trimmed there, so a trailing newline from `$(cat key.txt)` or a Docker
`--env-file` neither changes which key is sent nor counts as a different key. A
value that is empty or only whitespace is not a key and falls through.

### Seeing which key is in use

The environment outranks the config file, which means `senso login` can store a
key that no later command sends. That is invisible unless something says so, so
two places do:

- `senso whoami` reports `apiKeySource` — `flag`, `env` or `config` — alongside
  the organization. It re-verifies against the API, so it names the organization
  the key actually reaches, and now also why that key was chosen. Offline, where
  it answers from the cache written by `login`, it says when the cached values
  describe a key that is being ignored.
- `senso whoami` also reports `apiKeyShadowedSources` when a **different** key is
  available from a source that was outranked, and says so on stderr. This is the
  case `login`'s warning cannot reach: someone logs in in their terminal, sees
  the warning, and then hands that shell to an agent that never saw it. Without
  this, "the environment holds the only key" — the ordinary CI setup — and "the
  environment is shadowing the key this user just logged in with" look identical.
  The field is absent, and stderr silent, when nothing is shadowed or when the
  sources hold the same key, so an agent can treat its presence as the signal.
- `senso login` warns when `SENSO_API_KEY` is set to something other than the key
  just stored. Non-fatal, on stderr: the key is still written, and the warning
  names `senso whoami` for checking which organization commands reach.

Both stay quiet when the environment is unset or holds the same key, because
neither changes what any command does.

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
