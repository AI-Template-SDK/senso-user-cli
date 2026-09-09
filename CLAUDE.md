# Claude instructions

## What this is

`senso-user-cli` is the command-line interface for Senso, published to npm as
`@senso-ai/cli`. It is a single TypeScript bundle built with tsup, wrapping the
Senso organization API in about 186 commands across 32 groups.

Its primary consumer is an AI agent, not a person. That shapes almost every
decision below.

```
src/
  cli.ts          the bin entry — the ONLY file that may end the process
  program.ts      createProgram(): builds the command tree, no side effects
  commands/       one file per command group; analytics/ is a directory
  lib/            api-client, config, errors, output, run-action, json-arg, enum-arg
  utils/          logger, branding, updater
tests/
  unit/           library modules in isolation
  commands/       each command group, in-process, against MSW
  e2e/            the built bundle, as a subprocess, against a mock server
  policy/         this repository's own rules
docs/             how it works; docs/reference/commands.md is GENERATED
```

## Before you finish

```bash
make all      # lint, typecheck, security, unit, e2e, build, smoke — what CI runs
```

Add checks to the `Makefile` first and have CI call them, never the other way
round.

Add a `CHANGELOG.md` entry under `## [Unreleased]` for anything a user or an
agent would notice.

## The output contract

This is the thing to understand before changing anything.

**stdout carries the payload. Everything else is stderr.** No exceptions. That
is what makes `senso ... --output json | jq` work without `--quiet`, and what
lets an agent treat stdout as parseable.

- Payload → `emit(ctx, data, { columns })` from `lib/output.ts`
- A mutation with no payload → `emitConfirmation(ctx, "...")`
- Everything else → `utils/logger.ts`, which is stderr-only by construction
- Streamed payload → `writeStdout()` from `lib/output.ts`

Only `lib/output.ts`, `utils/logger.ts` and `utils/branding.ts` may touch a
stream. ESLint blocks the rest and `tests/policy/output-contract.test.ts` fails
if the exemption list grows.

## Non-negotiables

1. **No `process.exit()` outside `src/cli.ts`.** Throw a `CliError` with an exit
   code from `EXIT`. An action that exits cannot be tested in-process.
2. **Every action is `runAction(program, async (ctx, ...) => ...)`.** It resolves
   the context, catches, reports in the requested format, and sets the exit code.
3. **Every command honors `--output`** in all three formats.
4. **No test may touch the network.** Register an MSW handler on the server in
   `tests/setup.ts`.
5. **Validate constrained flags before the request** — `parseEnumFlag`,
   `parseIntFlag`, `parseJsonFlag`. A typo should exit 2, not round-trip.
6. **American English.** organization, canceled, behavior.
7. **`make reference` after adding or renaming a command.**
8. **Do not lower a coverage gate to make a change pass.**

## Exit codes

Part of the public interface. Changing one is a breaking change.

| Code | Meaning                                    |
| ---- | ------------------------------------------ |
| 0    | Success                                    |
| 1    | The API or the runtime refused             |
| 2    | Usage error                                |
| 3    | Authentication (no key, 401, 403)          |
| 4    | Not found (404)                            |
| 5    | Network failure or timeout (including 429) |

`error.code` in the JSON error payload is likewise stable. Reword a message
freely; changing a code is a breaking change.

## Testing conventions

| Layer      | Where             | What belongs there                                                          |
| ---------- | ----------------- | --------------------------------------------------------------------------- |
| Unit       | `tests/unit/`     | Library modules, pure logic                                                 |
| Command    | `tests/commands/` | One group, in-process, asserting the exact request and all three renderings |
| End-to-end | `tests/e2e/`      | The bundle as a subprocess: real exit codes, real streams, the shebang      |
| Policy     | `tests/policy/`   | Rules about the repository itself                                           |

- Every file opens with a comment naming the layer and **what is worth
  protecting there**.
- Test names are sentences: `it("exits 2 when --data is not valid JSON")`.
- **Failure branches before happy paths.** The interesting cases here are 401,
  402, 404, a malformed body, and a flag that is not a valid value.
- Policy-test failure messages name the offender.
- `tests/helpers.ts` exports `runCli()`, which captures stdout, stderr and the
  exit code. Use it rather than driving Commander by hand.

## Things that look like bugs but are not

- **`getApiKey` and `getBaseUrl` use `||`, not `??`, and that is deliberate.**
  An empty string is not a usable key: `SENSO_API_KEY=` in CI must fall through
  to the stored value rather than authenticate with `""`. There is an
  `eslint-disable` on exactly those two functions saying so.

- **`no-unnecessary-condition` is off for `src/commands/`.** `apiRequest<T>` is
  a cast, not a validator, so the response interfaces are assertions the compiler
  treats as facts. With the rule on, it argued for deleting the `?? []` guards
  around upload responses — which turns a malformed body into a "not iterable"
  TypeError. The rule stays on for `lib/` and `utils/`, where the types are ours.

- **`findRows` in `lib/output.ts` requires a list envelope, not just an array
  property.** A payload counts as a list only when it is a list plus pagination
  metadata. `/org/me` returns the organization with a `locations: [...]` field,
  and the earlier "first array wins" rule rendered the locations while silently
  dropping the organization's name, slug and tier.

- **The banner is on stderr and suppressed entirely under `--output json`.**
  Even on stderr it is noise an agent has to be told to ignore.

- **The update check does not run for `--version`, `--help`, `login`, `logout`
  or `update`,** and its timeout is 3 seconds rather than 10. It is fired without
  being awaited, so an outstanding fetch keeps the event loop alive after the
  command has printed — that timeout is the worst-case delay before the process
  exits.

- **`version.ts` walks up directories looking for a `package.json`.** The layout
  inside `node_modules` is not the layout in the repository, so a fixed relative
  path works in one and not the other.

- **tsup adds the shebang via its `banner` option.** Do not add one to
  `src/cli.ts` as well; two shebangs make `dist/cli.js` a syntax error, and
  nothing but the smoke test catches it.

- **`senso` with no arguments exits 2** and prints help to stderr. Nothing was
  named to run, so it is a usage error.

- **TypeScript is pinned at 5.9.** 7.0 works and found a real bug, but no
  typescript-eslint release supports it, and the type-aware linter is what
  enforces the output contract. Dependabot ignores the major on purpose.

## API drift

The customer-facing contract is `docs/specs/sdk-api.yaml` in the
**senso-contextos** repository. `docs/reference/excluded-endpoints.md` lists the
endpoints deliberately not exposed here, with reasons. Before adding a command
for an endpoint that is not in the spec, ask — the spec may be behind, or the
endpoint may not be public.

## Git

Gitmoji prefix, lowercase imperative subject. Work on a branch; `main` is
protected by the Testing workflow.
