# Contributing

## Setup

```bash
nvm use          # Node 22, per .nvmrc
npm ci
```

Optional but recommended:

```bash
npx husky        # installs the pre-commit hook
```

`make help` lists every target.

## Before you open a pull request

```bash
make all
```

That runs lint, typecheck, security, unit, end-to-end, build and smoke — the
same targets CI runs, in the same order. If it passes here it passes there.

`make security` needs Docker (semgrep and gitleaks run from pinned images).
`make e2e` and `make smoke` need a build, which they do themselves.

`main` is protected. Work on a branch and open a pull request.

## The rules that are not negotiable

A review will send a pull request back for any of these.

1. **stdout carries the payload; everything else is stderr.** Only
   `lib/output.ts`, `utils/logger.ts` and `utils/branding.ts` may write to a
   stream, and ESLint blocks the rest. This is not style: a stray `console.log`
   in a command is how the banner ended up on stdout and broke
   `--output json | jq` for every caller who did not also pass `--quiet`.

2. **No `process.exit()` outside `src/cli.ts`.** Throw a `CliError` with the
   right exit code and let `runAction` report it. An action that exits cannot be
   tested in-process — the test runner dies with it — which is most of why this
   repository had no tests for its first two years.

3. **Every command goes through `runAction`, and honors `--output`.** A command
   that prints with `JSON.stringify` ignores the flag and skips the error
   contract. `tests/policy/output-contract.test.ts` fails the build if one does.

4. **No test may touch the network.** `tests/setup.ts` installs an MSW server
   with `onUnhandledRequest: 'error'`. If you need a response, register a
   handler. This is why CI needs no secrets and why fork pull requests work.

5. **A new or renamed command means `make reference`** and a README table entry
   if it is a new group. A policy test compares the committed reference against
   the live command tree.

6. **American English.** organization, not organisation. canceled, not
   cancelled. Checked by a test, because the rule was written down and drifted
   anyway.

7. **Do not lower a coverage gate to make a change pass.** The gate already sits
   below what the suite achieves, so there is room to add code in one commit and
   its tests in the next. If you are hitting it, the change needs tests.

8. **Add checks to the Makefile first, then have CI call them.** CI must never
   run something a developer cannot run locally with the same command.

9. **No credential in a tracked file, ever.** gitleaks scans the full history on
   every pull request and its allowlist is empty on purpose. If you leak a key,
   the fix is to **rotate it** — not to silence the scanner.

## Adding a command

1. **Find the endpoint.** `senso-contextos/docs/specs/sdk-api.yaml` is the
   customer-facing contract. If the endpoint is not there, ask before shipping a
   command for it.
2. **Register it** in the right group file under `src/commands/`, wrapped in
   `runAction(program, async (ctx, ...) => ...)`.
3. **Make the request** with `apiRequest`, passing `apiKey: ctx.apiKey` and
   `baseUrl: ctx.baseUrl`.
4. **Print with `emit(ctx, data, { columns })`** — or `emitConfirmation` when
   there is no payload. Supply `columns` for a list; the generic renderer handles
   the rest.
5. **Validate constrained input** with `parseEnumFlag` / `parseIntFlag`, and
   `--data` with `parseJsonFlag`. A typo should exit 2 before a request is made.
6. **Write the test** in `tests/commands/`, covering the failure branches first:
   no key, 401, 404, a malformed body, then the exact request, then the
   rendering in all three formats.
7. **`make reference`**, and add a CHANGELOG entry.
8. **`make all`.**

## Tests

The interesting cases in a CLI are almost all failure cases: an expired key, no
credits, a malformed upstream body, a flag that is not a valid value. Cover
those before the happy path.

| Layer      | Where             | What belongs there                                                 |
| ---------- | ----------------- | ------------------------------------------------------------------ |
| Unit       | `tests/unit/`     | Library modules in isolation                                       |
| Command    | `tests/commands/` | A command group, in-process, against MSW                           |
| End-to-end | `tests/e2e/`      | The built bundle as a subprocess: exit codes, streams, the shebang |
| Policy     | `tests/policy/`   | This repository's own rules                                        |

Every test file opens with a comment saying what layer it covers and **what is
worth protecting there** — not a restatement of the filename. Test names are
sentences: `it("exits 2 when --data is not valid JSON")`.

Policy-test failure messages must name the offender. `expected [] to deeply
equal []` helps nobody.

## Comment style

Comment **why, not what**. The best comments here record a decision someone
would otherwise have to make twice — why a guard exists, why `||` and not `??`,
why a timeout is 3 seconds and not 10. A comment restating the code is noise; a
comment explaining why the obvious implementation was wrong saves the next
person a bug. Known limitations are written down as decisions rather than
omitted — see the end of SECURITY.md.

## Commit messages

Gitmoji prefix, lowercase imperative subject:

```
:sparkles: add senso ctas commands for the CTA endpoints
:bug: stop the banner reaching stdout under --output json
:memo: document every environment variable in docs/configuration.md
:wrench: pin gitleaks to a released image tag
:recycle: route every command through runAction
:white_check_mark: cover the streaming search parser across chunk boundaries
:lock: redact the api key from SENSO_DEBUG output
:arrow_up: bump commander to 15
```

## Releasing

See [docs/releasing.md](docs/releasing.md). In short: update the CHANGELOG,
`npm version <patch|minor|major>`, `git push --follow-tags`, and the tag
triggers a publish that refuses to run unless CI is green and the CHANGELOG has
an entry for that version.
