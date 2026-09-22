# Security

## Reporting a vulnerability

Email **security@senso.ai**. Please do not open a public issue.

Include what you found, how to reproduce it, and what you think the impact is.
We will acknowledge within two business days and keep you updated until it is
resolved.

## What this tool holds

One credential: an organization API key, which can read and write everything in
that Senso organization — knowledge base content, generated content, members and
other API keys.

| Where                                                      | What                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/senso/config.json` (or the platform equivalent) | The API key, the organization name and id, and the last update check. Mode `0600`, replaced atomically — never rewritten in place, never written through a symlink. |
| `device-auth.json`, beside it                              | Only while a `senso login` is in flight: the `device_code` for that login, mode `0600`, deleted the moment the flow ends or expires.                                |
| `SENSO_API_KEY`                                            | The same key, when supplied by environment instead                                                                                                                  |
| `--api-key`                                                | The same key, when supplied per command                                                                                                                             |

`SENSO_CONFIG_DIR` relocates the file. Nothing else is stored: no knowledge base
content, no cache, no history, no telemetry.

`senso logout` deletes the file — and first revokes the key, if `senso login`
minted it through the browser flow, so signing out does not leave a seven-day
credential live. A key you supplied yourself is only forgotten, because it may be
in use elsewhere; the CLI records which kind it stored and never revokes on a
guess. `senso uninstall` does the same, removes the agent skills
`senso skills install` put on the machine, and then removes the CLI package
itself; a key supplied through `SENSO_API_KEY` is outside its reach, and it says
so.

## What leaves your machine

Two destinations, both over HTTPS, and nothing else.

| To                                 | When                | Carrying                                                                                                               |
| ---------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apiv2.senso.ai` (or `--base-url`) | Every command       | `X-API-Key`, a `User-Agent` naming the CLI version, and whatever that command sends                                    |
| `apiv2.senso.ai`, unauthenticated  | `senso login` only  | The two device-flow calls, which carry no key because none exists yet: an optional device name, then the `device_code` |
| `registry.npmjs.org`               | Once every 24 hours | Nothing but the request for this package's version metadata                                                            |

The update check sends no key and no identifier. `SENSO_NO_UPDATE_CHECK=1`
disables it.

`ingest upload` and `kb upload` additionally `PUT` your file bytes to a
presigned S3 URL that the Senso API returns. The URL comes from the API; the
credential is in the URL and is short-lived.

## What runs on every change

| Stage    | Tool                              | Catches                                                          |
| -------- | --------------------------------- | ---------------------------------------------------------------- |
| Lint     | ESLint, type-aware                | Unsafe patterns; the stdout/stderr contract                      |
| Security | `npm audit`                       | Known vulnerable dependencies (high and critical)                |
| Security | semgrep                           | Static analysis of our own code                                  |
| Security | gitleaks, full history            | Committed credentials, including deleted-but-still-clonable ones |
| Unit     | MSW `onUnhandledRequest: 'error'` | Any test that tries to reach the network                         |
| Smoke    | `scripts/smoke-test.sh`           | What the published tarball actually contains                     |

`npm audit` is gated at high and critical. Moderate advisories in transitive
build-time dependencies would otherwise block every pull request on something
nobody can act on, and a gate that is routinely overridden stops being read.

**This repository's git history is clean.** A full-history gitleaks scan on
2026-09-09 across all 42 commits found nothing, and `.gitleaks.toml` has an empty
allowlist on purpose so that every future finding is a real one. If a credential
is ever committed, the fix is to **rotate it** — an allowlist entry silences the
scanner without making the key in the history any less readable.

## Known limitations

Recorded here so they are decisions rather than oversights.

- **The API key is stored in plaintext**, in a `0600` file. This is the usual
  arrangement for a developer CLI (`npm`, `gh` and `aws` all do the same) and it
  is what makes the key usable from a script without a prompt. It means any
  process running as your user can read it. Using the OS keychain instead is a
  real feature rather than a fix — it needs a per-platform backend and a fallback
  for headless Linux — and it is not implemented.

- **`senso skills install` passes the API key in the child process's argv**,
  where it is visible in `ps` output and in shell history on a shared machine.
  This cannot be fixed from this side: shipables 0.1.2 uses `--env` to populate
  the installed skill's MCP server environment and never falls back to
  `process.env` for a value, so passing the key through the child's own
  environment would install a skill with an empty credential. The fix belongs
  upstream — an `--env-from-env NAME` flag, or reading `process.env[name]` when
  no value is supplied. Until then, prefer `senso skills install` on a machine
  you control.

- **POSIX file modes do not apply on Windows.** `config.json` and
  `device-auth.json` are written `0600`, which Windows effectively ignores;
  protection there comes from the per-user ACL on `%APPDATA%` instead. That is
  reasonable, but it is not the same guarantee.

- **A `device_code` is on disk while a login is in flight.** It is a bearer
  secret: anyone who can read it within five minutes can redeem the approval
  that login is waiting for. It is owner-readable, single-use, and deleted on
  success, denial, expiry, Ctrl-C, `senso logout` and by a sweep on any later
  command. The alternative was passing it through stdout between the two halves
  of the flow, which in an agent's shell means a live credential in a transcript
  that outlives it.

- **No certificate pinning.** The CLI trusts the system certificate store, so an
  interception proxy with a trusted root can read traffic. That is also what
  makes the tool work behind a corporate proxy, which is the more common need.

- **`--api-key` on the command line** has the same `ps` and shell-history
  exposure as any other credential passed as an argument. `SENSO_API_KEY` or
  `senso login` avoid it.

- **`SENSO_DEBUG=1` prints every request URL**, including query parameters, to
  stderr. The API key is never printed — not even a prefix, because a prefix is
  enough to identify an organization and debug output gets pasted into support
  threads. Query parameters may still contain search terms you consider
  sensitive.

- **No key rotation command.** `api-keys create` and `api-keys revoke` exist, but
  rotating the key this CLI itself uses is a manual sequence: create, `senso
login` with the new key, revoke the old one.

- **The update check reaches npm on a 24-hour cadence** without asking. It sends
  no identifying information, but it is a network call some environments do not
  expect. `SENSO_NO_UPDATE_CHECK=1` turns it off permanently.
