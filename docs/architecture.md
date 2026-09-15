# Architecture

What happens between `argv` and the Senso API, and which file owns each step.

## One invocation

```
                  $ senso roles list --output json
                              │
                              ▼
  src/cli.ts            the bin entry — the ONLY file that ends the process
    │                   await createProgram().parseAsync(process.argv)
    ▼
  src/program.ts        createProgram(): builds the command tree. No side
    │                   effects, no I/O, no argv read at module scope.
    ▼
  Commander             parses global options, resolves which command runs,
    │                   validates arity. A usage failure throws (exitOverride).
    ▼
  preAction hook        runs once, after the globals are parsed and the command
    │                   is known:  miniBanner() → stderr, unless --quiet or
    │                   --output json;  void checkForUpdate(...) — fired, never
    │                   awaited, skipped for login / logout / uninstall / update.
    ▼
  lib/run-action.ts     runAction(program, handler)
    │                     resolveContext(program) → Ctx { apiKey, baseUrl,
    │                     format, quiet, debug }
    │                     try { await handler(ctx, ...) } catch { report }
    ▼
  src/commands/<group>.ts
    │                   validate flags (parseEnumFlag / parseIntFlag /
    │                   parseJsonFlag) → build path, params, body
    ▼
  lib/api-client.ts     apiRequest({ path, apiKey, baseUrl, ... })
    │                     getApiKey / getBaseUrl (flag → env → config file)
    │                     fetch: X-API-Key, User-Agent: senso-cli/<version>,
    │                     AbortController at 30s
    │                     !res.ok → throw ApiError(status, statusText, body)
    ▼
  lib/output.ts         emit(ctx, data, { columns })
    │                     json  → the payload, unmodified
    │                     table → findRows() decides list vs. single object
    │                     plain → key/value lines, nothing truncated
    │
    ├──────────────────────────────────► stdout   the payload, and nothing else
    │
    └── utils/logger.ts ───────────────► stderr   banner, progress, warnings,
                                                  errors, hints, debug lines

  anything thrown ─► toCliError() ─► reportError() ─► process.exitCode
                     (lib/errors.ts)   (stderr, in     0 1 2 3 4 5
                                        the requested
                                        format)
```

Two properties of that picture are worth stating outright, because everything
else follows from them: the only arrow into stdout comes from `lib/output.ts`,
and the only box that calls `process.exit()` is `src/cli.ts`.

## The layers

### `src/cli.ts` — the bin entry

Three lines of work: build the program, `parseAsync(process.argv)`, and catch
whatever escapes. It is the only file permitted to end the process.

It catches two kinds of thing. An `ExitSignal` means "stop with this code and say
nothing" — `--help` and `--version` have already printed everything they mean to
say, and with `exitOverride` installed Commander's own exit becomes a throw, so
without this the bin entry would append `(outputHelp)` to a successful run as
though it were a failure. Anything else is reported in `plain` format, because
nothing above this point has a resolved context.

### `src/program.ts` — `createProgram()`

Builds the command tree and returns it. **Importing this module must have no side
effects.** The earlier arrangement built the program and called `parseAsync` at
module scope, so anything that imported it ran the CLI — which is why there were
no tests: `tests/helpers.ts` calls `createProgram()` and drives it in-process,
and `scripts/gen-reference.ts` walks the same tree to generate the command
reference. Both of those are only possible because construction and execution are
separate.

The root command declares the global options (`--api-key`, `--base-url`,
`--output`, `--quiet`, `--no-update-check`), the version flag, and the help
epilog carrying the exit-code and environment tables — an agent reads `--help`,
so the contract is printed there and not only in the README.

`exitOverride` is installed for one reason: Commander exits 1 on a usage error,
and 2 is the long-standing convention for "you typed it wrong". Rewriting the
code in a handler keeps `src/cli.ts` the only exiter.

### The `preAction` hook

Commander runs it once per invocation, after the global options are parsed and
after it knows which command is about to run. Both facts are load-bearing, which
is why the banner and the update check live here and not in the bin entry:

- The banner needs `--quiet` and `--output` already resolved. It is suppressed
  entirely under `--output json` — even on stderr it is noise an agent has to be
  told to ignore.
- The update check needs the command's name, because it is skipped for `login`,
  `logout`, `uninstall` and `update`. The first three own the config file for
  the duration of their run and a concurrent update-check write would be a
  second writer — for `uninstall` that writer would recreate the file the
  command just deleted; the fourth asks the registry itself.
- Commander handles `--version` and `--help` without dispatching an action, so
  the hook never fires for them. `senso --version` therefore makes no request and
  creates no config directory, which is what makes it usable as a healthcheck —
  and there is an end-to-end test asserting exactly that.

`checkForUpdate` is fired without being awaited. An outstanding fetch keeps the
event loop alive after the command has printed, which is why its timeout is 3
seconds rather than the client's 30: that timeout is the worst-case delay between
the last line of output and the process exiting.

### `lib/run-action.ts` — the wrapper every action goes through

`runAction(program, handler)` returns the function Commander calls. It does three
things: resolve the context once, run the handler, and turn anything thrown into
a reported error and an exit code.

`resolveContext` reads the global options off the root command — Commander has
already parsed them, including the `--output=json` equals form that the
hand-rolled argv scan this replaced used to miss — validates `--output` against
the three known formats, and returns a `Ctx`:

| Field               | Source                                            |
| ------------------- | ------------------------------------------------- |
| `apiKey`, `baseUrl` | The global flags, passed straight to `apiRequest` |
| `format`            | `--output`, defaulting to `plain`                 |
| `quiet`             | `--quiet`, **or** `format === "json"`             |
| `debug`             | `SENSO_DEBUG === "1"`                             |

JSON output implies quiet: a caller that asked for a machine-readable payload did
not also ask for progress commentary beside it.

**Commands throw instead of exiting, and that is the single decision this file
exists to enforce.** Before it, roughly 150 actions each repeated the same
try/catch/`process.exit(1)`, with three consequences. Every failure exited 1, so a
caller could not tell a bad flag from an expired key from a DNS outage. An action
that calls `process.exit()` cannot be tested in-process, because the test runner
dies with it — which is most of why this repository had no tests for two years.
And 27 of 30 command files never read `--output` at all.

On failure the wrapper sets `process.exitCode` rather than calling
`process.exit()`. Exiting outright truncates buffered stdout when it is a pipe;
setting the code lets Node exit with it once the event loop drains, which is the
same observable result without the truncation or the untestability.

### The command body

A command file registers its group on the program and gives each subcommand an
action wrapped in `runAction`. The body is short by design: validate, request,
emit.

Validation comes first, and before any request. `parseEnumFlag`, `parseIntFlag`
and `parseJsonFlag` raise a `CliError` with `EXIT.USAGE` naming the valid values,
so a typo exits 2 in milliseconds rather than round-tripping to the API. One of
these was worse than a wasted round trip: `generated-content --status` used to map
any unrecognized value to `published`, so a typo returned a plausible-looking
wrong list.

The `no-unnecessary-condition` lint rule is off for `src/commands/` on purpose.
`apiRequest<T>` is a cast, not a validator, so the response interfaces are
assertions the compiler treats as facts — with the rule on it argued for deleting
the `?? []` guards around upload responses, which turns a malformed body into a
"not iterable" TypeError.

### `lib/api-client.ts` — the only place a request is made

`apiRequest<T>` resolves the credential and base URL through `lib/config.ts`,
builds the URL, sets `X-API-Key`, `Accept: application/json` and a `User-Agent`
naming the CLI version, and aborts after 30 seconds. The timeout is generous
because report generation and search over a large knowledge base are genuinely
slow, and a timeout that fires on a working request is worse than a slow one.

A non-2xx response becomes an `ApiError` carrying the status and the parsed body.
The message is dug out of the body in a fixed order — `error`, `message`,
`detail`, then a field-level `errors[]` array flattened to `field: message` — with
the HTTP status text as the fallback. Each part is stringified defensively,
because this is the error path and an unexpected shape here must not throw on top
of the failure it is reporting.

`204` returns `undefined`. A body that will not parse becomes
`Invalid JSON response from <path>`, which is the error you get when something
between you and the API returns an HTML error page.

`apiStreamRequest` is the same request with `Accept: text/event-stream` and **no
timeout**: it stays open for the length of an answer, so an inactivity budget
would have to be per-chunk rather than per-request. The caller sees tokens as
they arrive and can interrupt.

### `lib/output.ts` — stdout

Three formats, and the difference between the last two is real:

| Format  | For                | Behavior                                                              |
| ------- | ------------------ | --------------------------------------------------------------------- |
| `json`  | scripts and agents | The payload, pretty-printed, unmodified. Never decorated or truncated |
| `table` | scanning a list    | Aligned columns, at most 8 of them, cells truncated at 48 characters  |
| `plain` | reading one thing  | `key: value` lines. Nothing is truncated. The default                 |

`emit(ctx, data, { columns })` is the only function most commands need. `json` is
always the raw payload, so a command that supplies a nicer `plain` rendering
cannot accidentally change what a script sees.

**How the generic renderer decides between a list and a single object** is
`findRows()`, and the rule is narrower than it looks. A bare array of objects is a
list. An object is a list only when it is _nothing but_ a list plus pagination
metadata: exactly one array-of-objects property, and every other key drawn from a
fixed envelope set (`total`, `count`, `limit`, `offset`, `page`, `has_more`,
`next`, `cursor`, and friends). Anything carrying its own fields is a single
object that happens to contain a list.

The earlier "first array property wins" rule is what makes this worth spelling
out: `/org/me` returns the organization with a `locations: [...]` field, so
`senso org get` rendered the locations and silently dropped the organization's
name, slug and tier from both `plain` and `table`. Only `--output json` was
unaffected, which is why nobody noticed.

When there is no list, `table` still has a useful rendering: two columns, one row
per field. It used to fall back to JSON there, which meant `--output table`
silently ignored the flag on most commands.

Two more details that were bugs first. Table columns are the union of every row's
keys in first-seen order, not `Object.keys(rows[0])` — API list responses
routinely omit a null field on some rows, and keying off the first row dropped a
column most of the results had. And a nested object or array in a cell is rendered
as JSON rather than `[object Object]`.

`emitConfirmation(ctx, message)` is for a mutation with no payload: under `json`
it emits `{ ok: true, message }` so a caller has something to parse; otherwise it
writes a green tick to **stderr**, because there is no payload and a caller piping
the command should receive an empty stream rather than a sentence.

`writeStdout()` is the one sanctioned bypass, for streamed answers where showing
tokens as they arrive is the point. What it writes is still payload, so the
contract holds.

### `utils/logger.ts` and `utils/branding.ts` — stderr

Everything that is not payload: `success`, `error`, `warn`, `info`, `dim`, `hint`
and `raw`, all `console.error`, without exception. `branding.ts` holds the banner
and the update box, both stderr for the same reason.

Within `src/`, ESLint permits `console.*` and direct stream writes in
`lib/output.ts`, `utils/logger.ts`, `utils/branding.ts` and `src/cli.ts`, and
nowhere else; `tests/` and `scripts/` are exempt because asserting on streams and
printing reports is their job.
`tests/policy/output-contract.test.ts` reads the source and the ESLint config and
fails if that exemption list grows — a lint rule can be disabled inline and
neither shows up as a behavior change in review, so widening the contract has to
be a deliberate edit to a file with that name.

### `lib/errors.ts` — where a failure becomes an exit code

`toCliError()` maps anything thrown into a `CliError` carrying an exit code, a
stable `code` string, the HTTP status when there was one, and a hint.

| Failure                                       | Exit | `error.code`           |
| --------------------------------------------- | ---- | ---------------------- |
| Success                                       | 0    | —                      |
| 402 insufficient credits                      | 1    | `insufficient_credits` |
| 409 conflict                                  | 1    | `conflict`             |
| 5xx                                           | 1    | `server_error`         |
| Any other non-2xx below 500                   | 1    | `error`                |
| Bad flag, unknown command, invalid `--output` | 2    | `usage`                |
| Malformed `--data`                            | 2    | `invalid_json`         |
| No credential anywhere                        | 3    | `unauthorized`         |
| 401                                           | 3    | `unauthorized`         |
| 403                                           | 3    | `forbidden`            |
| 404                                           | 4    | `not_found`            |
| 429                                           | 5    | `rate_limited`         |
| Connection failure                            | 5    | `network`              |
| Timeout or abort                              | 5    | `timeout`              |

Three of those mappings are decisions rather than transcription. **401 and 403
both exit 3** — one says "who are you", the other says "not you", and a script's
reaction to either is to fix its credential — while keeping distinct codes.
**402 is deliberately not an auth failure**: the key is fine, the account is out of
credits, and retrying with a different key is the wrong response. **429 exits 5,
with the network failures**, because the useful thing to know about a rate limit
is that waiting and retrying is the correct reaction.

Connection failures are detected on the message and on the cause. Node reports
every connection-level failure as a bare `fetch failed` with the real reason on
`cause`, but "Failed to fetch" is the same failure worded the way the WHATWG spec
says it, which is what a non-undici fetch or a test double raises. Matching only
Node's wording meant an equivalent failure exited 1 and the caller lost the retry
signal that exit 5 carries.

`reportError()` writes the failure to **stderr in the format the caller asked
for** — a JSON object under `--output json`, a red line plus a dimmed hint
otherwise. Always stderr, including in JSON mode: stdout stays empty on failure so
that `cmd --output json > out.json` leaves an empty file rather than a file
containing an error object that a later read would mistake for data. Under
`SENSO_DEBUG=1` the underlying error's stack follows.

Exit codes and `error.code` values are part of the public interface. Reword a
message freely; changing a code is a breaking change.

### `lib/config.ts` and `utils/updater.ts` — the two things that persist

`config.ts` owns one small JSON file and the credential precedence
(`--api-key` → `SENSO_API_KEY` → the file). See
[configuration.md](configuration.md) for its location, shape and permissions.

`updater.ts` is the only part of the CLI that talks to anything other than the
Senso API. Once every 24 hours it asks `registry.npmjs.org` for this package's
`dist-tags.latest`, stores the answer and the timestamp in the config file, and
prints a box on stderr if it is newer than the running version. Between checks it
prints the cached answer. It sends no key and no identifier, it swallows every
error, and `SENSO_NO_UPDATE_CHECK=1` turns it off.

## What is deliberately not here

The CLI is a thin client. Each of these is an absence someone might mistake for
an oversight.

**No daemon, no background process, no watcher.** An invocation is a process that
starts, prints and exits. There is nothing to install, restart, or leave running
with a credential in memory.

**No response cache.** Every command asks the API. A cache would need
invalidation the CLI has no way to observe, and a stale answer from a knowledge
base tool is worse than a slow one. The only thing stored between runs is the
update check's timestamp and the version it saw.

**No telemetry, no analytics, no crash reporting.** The two hosts this tool
contacts are the Senso API and, once a day, the npm registry. Both are listed in
[SECURITY.md](../SECURITY.md).

**No retry logic.** A failed request fails, once, with an exit code that says
whether retrying is worth anything: 5 means the API was unreachable, timed out or
rate-limited you; 3 means fix the credential first; 4 means the ID is wrong.
Retries belong to the caller because only the caller knows the budget — a shell
loop, an agent's tool policy and a CI job all want different backoff, and a CLI
that retried silently would spend a minute of someone's timeout without saying so.
That is what the exit codes are for.

**No `--quiet`-dependent stdout.** `--quiet` silences stderr chatter and never
changes stdout, so no caller has to pass it to get parseable output. That is the
whole reason the stream split exists.
