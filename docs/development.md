# Development

Setting the repository up, what each stage of the pipeline checks, where a new
test goes, and how to see what a command is actually sending.

## Getting set up

Node 22, per `.nvmrc`. The published package supports Node 20.12 and up; 22 is what
this is developed and released on.

```bash
nvm use
npm ci
npx husky          # optional: installs the pre-commit hook
make help          # every target, with its one-line description
```

Run the CLI from source without building, with `tsx`:

```bash
npm run dev -- whoami
npm run dev -- search "refund policy" --output json
```

`make security` needs Docker: semgrep and gitleaks run from pinned images rather
than marketplace actions, so the ruleset cannot change under you and no third
party has write access to the pipeline. Everything else is npm and Node.

## The pipeline

`make all` is the whole thing, and `.github/workflows/testing.yml` invokes the
same targets in the same order — a green `make all` locally and a green pipeline
cannot mean different things. Add a check to the `Makefile` first and have CI call
it, never the other way round.

| Stage     | Command          | What it checks                                                                            |
| --------- | ---------------- | ----------------------------------------------------------------------------------------- |
| Lint      | `make lint`      | ESLint (type-aware, including the stream-ownership rules) and `prettier --check`          |
| Typecheck | `make typecheck` | `tsc --noEmit` over `src`, `tests` and `scripts`                                          |
| Security  | `make security`  | `npm audit --audit-level=high`, semgrep over our own code, gitleaks over the full history |
| Unit      | `make unit`      | `vitest run --coverage`: the unit, command and policy suites, behind the coverage gate    |
| E2E       | `make e2e`       | Builds, then drives `dist/cli.js` as a subprocess against a local mock API                |
| Build     | `make build`     | The tsup bundle                                                                           |
| Smoke     | `make smoke`     | `npm pack`, install into a throwaway prefix, run the installed binary                     |

Supporting targets: `make install` (`npm ci`), `make format` (Prettier and
ESLint `--fix`; never run in CI), `make reference` (regenerate the command
reference), `make clean`.

Two targets are deliberately outside `all`. `e2e-matrix` is CI-only — three
operating systems and four Node versions, where locally you have one of each.
`make live` runs `scripts/live-canary.ts`: read-only commands (`whoami`,
`org get`, and other reads) against a real organization, driving the built
`dist/cli.js` with a real key from `SENSO_API_KEY`. It is never a pull-request
gate, because it needs a secret — so it cannot run on a fork — and a check that
silently skips when the secret is absent reports green without having run, which
is worse than no check.

Two jobs run on a schedule rather than on a pull request, both because they need
the network and a pull-request gate must not depend on a third party being up:
`.github/workflows/live-canary.yml` runs the canary daily (and per pull request
if you add the `live-api` label), and `.github/workflows/spec-drift.yml` runs
`scripts/spec-drift.ts` weekly, diffing the published API spec against the paths
this CLI reaches and opening an issue when they disagree.

`npm audit` is gated at high and critical only. Moderate advisories in transitive
build-time dependencies would otherwise block every pull request on something
nobody can act on, and a gate that is routinely overridden stops being read.

### Before a commit

`.husky/pre-commit` runs `scripts/pre-commit-checks.sh`, which is deliberately
narrow — everything in it finishes in about a second, because a slow hook trains
people to reach for `--no-verify`. It checks the staged files for oversized blobs,
merge-conflict markers and unparseable JSON, runs gitleaks over the staged diff,
and then runs `lint-staged`. The ordering is load-bearing: the secret scan runs
_before_ the formatters, because `lint-staged` rewrites the index and a scan
placed after it would examine a different set of bytes than the ones being
committed.

## The test layers

Four layers, two Vitest projects. The `unit` project runs `tests/unit`,
`tests/commands` and `tests/policy` in-process against `src/` and measures
coverage; the `e2e` project spawns the built bundle and measures nothing, because
the instrumentation cannot see into another process.

| Layer      | Where             | What belongs there                                                                                             |
| ---------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Unit       | `tests/unit/`     | Library modules in isolation: the renderer's list-versus-object rule, the error mapping, config precedence     |
| Command    | `tests/commands/` | One command group, driven in-process through `runCli()`, asserting the exact request and all three renderings  |
| End-to-end | `tests/e2e/`      | The bundle as a subprocess: real exit codes, real streams, the shebang, and that the process exits at all      |
| Policy     | `tests/policy/`   | Rules about this repository — the output contract's exemption list, American English, the Node pin, what ships |

**Where a new test goes.** A change inside `src/lib/` or `src/utils/` gets a unit
test. A new or changed command gets a case in that group's file under
`tests/commands/` — failure branches first (no key, 401, 404, a malformed body,
a flag that is not a valid value), then the exact request shape, then the
rendering in each format. Reach for `tests/e2e/` only for something the
in-process layers structurally cannot observe: the real exit code a shell sees,
which stream a byte landed on, whether the bundle starts, or whether the process
hangs. Reach for `tests/policy/` when you have written a rule down somewhere and
want it to stay true.

Conventions: every file opens with a comment naming the layer and what is worth
protecting there — not a restatement of the filename. Test names are sentences
(`it("exits 2 when --data is not valid JSON")`). Policy-test failure messages name
the offender, because `expected [] to deeply equal []` helps nobody.

`tests/helpers.ts` exports `runCli()`, which prepends `--api-key` and
`--base-url`, captures stdout, stderr and the exit code, and parses stdout as
JSON on request. Use it rather than driving Commander by hand. It can work
in-process at all only because commands throw instead of calling `process.exit()`
— before that refactor a single failing command took the test runner down with it.

Running a subset:

```bash
npx vitest run tests/unit/output.test.ts
npx vitest run --project unit -t "exits 2"
npx vitest                                  # watch mode
npm run build && npx vitest run --project e2e
```

The coverage gate is 80% statements, 80% branches, 70% functions and 80% lines,
measured over `src/` on the unit project only. It sits below what the suite
achieves on purpose: a gate set at the current number fails the build on the first
line of a work-in-progress branch, which teaches people to pass `--no-coverage`.
Do not lower it to make a change pass — if you are hitting it, the change needs
tests.

## No test touches the network, and it is not a convention

`tests/setup.ts` installs an MSW server with `onUnhandledRequest: "error"`, so a
request nobody explicitly mocked fails the test that made it. The same file
clears `SENSO_API_KEY`, `SENSO_BASE_URL` and `SENSO_DEBUG`, sets
`SENSO_NO_UPDATE_CHECK=1` and `NO_COLOR=1`, and points `SENSO_CONFIG_DIR` at a
fresh temporary directory for every test.

The reason is specific to this repository. This CLI's whole job is to talk to a
real Senso API with a real key, so a command test that forgot to mock a request
would issue it for real, against whatever `SENSO_BASE_URL` and `SENSO_API_KEY`
happen to be in the developer's environment. That is how a test suite ends up
deleting content from a production organization. Both halves — the request ban
and the credential ban — are mechanical rather than something people have to
remember, which is also why CI needs no secrets and why pull requests from forks
run the full suite instead of silently skipping half of it.

To allow a request, register a handler on the server the setup exports:

```ts
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";

server.use(http.get("*/org/roles", () => HttpResponse.json({ roles: [] })));
```

The end-to-end layer cannot use MSW at all: MSW patches `fetch` inside the current
process, and the CLI under test runs in a different one where nothing is patched.
`tests/e2e/helpers.ts` starts a real `node:http` server on an ephemeral port
instead, records every request, and replies from a queue. It applies the same
principle in two more places — the default base URL is `http://127.0.0.1:1`, which
nothing listens on, so a test that forgets to point at the mock fails with a
connection error rather than reaching a real API; and an unqueued path answers
**501**, not 404, so a test asserting on the not-found path cannot pass because it
forgot to queue anything.

## Adding a command

The full recipe, with the review rules attached, is in
[CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-command). The mechanics:

1. Confirm the endpoint is in the customer-facing spec (`docs/specs/sdk-api.yaml`
   in the **senso-contextos** repository). If it is not there, ask before shipping
   a command for it.
2. Register the subcommand in the right group file under `src/commands/`, with the
   action wrapped in `runAction(program, async (ctx, ...) => ...)`. A new group
   also needs a `register*Commands(program)` call in `src/program.ts`.
3. Validate constrained flags before the request — `parseEnumFlag`,
   `parseIntFlag`, `parseJsonFlag`. A typo should exit 2 without a round trip.
4. Make the request with `apiRequest`, passing `apiKey: ctx.apiKey` and
   `baseUrl: ctx.baseUrl`.
5. Print with `emit(ctx, data, { columns })`, or `emitConfirmation(ctx, "...")`
   when there is no payload. Supply `columns` for a list; the generic renderer
   handles the rest, in all three formats.
6. Write the test in `tests/commands/`, failure branches first.
7. `make reference`, a `CHANGELOG.md` entry under `## [Unreleased]`, and
   `make all`.

## Regenerating the command reference

```bash
make reference          # rewrites docs/reference/commands.md
```

`scripts/gen-reference.ts` walks the tree returned by `createProgram()` and
renders every command, its usage line and its options. Never edit
`docs/reference/commands.md` by hand: it is generated precisely because the
README's hand-maintained command list drifted 89 subcommands behind the code.

The script writes the file only when it is the process entry point, so the
generator can be imported and compared against the committed file without
rewriting it — a test that fixes what it is checking always passes. **That
comparison is not wired up yet**: the header the generator emits and its own
comment both refer to `tests/policy/reference.test.ts`, which does not exist, so
today running `make reference` after touching a command is a discipline rather
than an enforced rule.

## Debugging a command

**Ask what it sent.** `SENSO_DEBUG=1` logs the method, the fully resolved URL
including query parameters, the status and the elapsed time to stderr, and prints
the underlying error's stack when a command fails. The API key is never printed,
not even a prefix.

```bash
SENSO_DEBUG=1 senso content list --limit 5
#   → GET https://apiv2.senso.ai/api/v1/org/kb/my-files?limit=5&offset=0
#   ← 200 GET https://apiv2.senso.ai/api/v1/org/kb/my-files?limit=5&offset=0 (412ms)
```

**Point it at something you control.** `--base-url` takes the full base including
the `/api/v1` prefix, so a local mock reproduces a response without a network or a
key:

```bash
node -e '
  require("node:http")
    .createServer((req, res) => {
      console.error(req.method, req.url);
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "spending limit reached" }));
    })
    .listen(8787);
'

senso credits balance --base-url http://127.0.0.1:8787/api/v1 --api-key test
echo $?          # 1, code "insufficient_credits"
```

That is the quickest way to check an error path end to end: change the status the
mock returns and confirm the exit code and `--output json` error body match the
table in [architecture.md](architecture.md#liberrorsts--where-a-failure-becomes-an-exit-code).
For a scripted version of the same thing, `startMockApi()` in
`tests/e2e/helpers.ts` is that server with request recording and a response queue.

**Isolate the credentials.** `SENSO_CONFIG_DIR=$(mktemp -d)` gives the invocation
its own empty config, so you can reproduce a first-run or unauthenticated state
without touching your own key.
