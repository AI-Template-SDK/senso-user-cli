# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/).

Entries are written for the person who has to act on them: what changed, why it
mattered, and what you need to do differently.

## [Unreleased]

### Added

- **`kb my-files`, `kb find` and `kb children` accept the filters the API has
  always offered.** Five of the eight shared query parameters were never wired
  up: `--status`, `--sort-by`, `--sort-order`, `--tag-ids` and `--role`. The
  absences were not cosmetic — without `--status` there was
  no way to list the documents whose ingestion failed, and without `--sort-by`
  no way to order a page at all. The closed sets are validated locally, so
  `--status archived` now exits 2 naming the valid values instead of spending a
  round trip on a 400. `--limit` is checked for being a whole number of at least
  1 but deliberately not capped at 50: the API documents higher values as capped
  rather than rejected, and it silently read a non-numeric limit as 50.

- **Search results now show the KB node ID, so a hit can be acted on.** The
  search endpoints return `kb_node_id` alongside `content_id`, and the CLI
  surfaces it first in every rendering. It is the id the rest of the CLI takes:
  `kb get`, `kb rename`, `kb move` and `kb delete` all address a node, and
  `content_id` is a different id space that 404s against them. `content_id` is
  still shown, because it is what `--content-ids` accepts — the two ids answer
  different questions: what to read next, and what to scope the next search to.
  `senso search <query>`'s plain output previously labelled `content_id` as
  plain `ID:`, which is the one id that does not work with any `kb` command.

### Fixed

- **`search context`, `search full` and `search content` render a table again
  under `--output table`.** They printed the entire response as a single
  key/value blob, with the hits stuffed into one `value` cell as raw JSON,
  because a search payload carries `query` and `search_type` beside its list and
  the list-detection rule deliberately refuses anything that is not a list plus
  pagination metadata. The three variants now pass their rows explicitly, as
  `senso search <query>` already did.

- **The raw-content `--data` help no longer promises tagging that does not
  happen.** All three commands advertised `tag_ids`. On `kb create-raw` the API
  accepts the field and discards it — the document is auto-tagged from its
  content instead — so the flag silently did nothing and the help now says so.
  On `kb update-raw` and `kb patch-raw` it does work, but it _replaces_ the whole
  tag set rather than adding to it; omit it to keep the current tags, pass `[]`
  to clear them, and note that every ID must already exist or the entire update
  is rejected. Both descriptions also now mention that re-ingestion re-runs
  auto-tagging, which can add tags of its own after the call returns.

- **A version bump no longer fails CI.** The generated command reference named
  the package version, so every `npm version` left it stale and the release
  commit failed the test that keeps it current. That is what stopped 0.13.0 from
  publishing. The reference no longer names a version.

## [0.13.0] — 2026-09-10

### Changed — breaking for anything that reads output or exit codes

- **The minimum Node version is now 20.12.** It was advertised as 18, but that
  had already stopped being true: upgrading dependencies raised the real floor
  to 22.12 without anything noticing, because the only thing that would have
  noticed was a test on the floor and the test runner cannot run there. Node 18
  reached end of life on 2025-04-30 and receives no security fixes, so the floor
  moves up rather than pinning dependencies back to support it — `commander` is
  held one major back at 14 so the floor is 20 rather than 22, which keeps Node
  20 users, who are still in maintenance until 2026-04-30.

  `engines` now says `>=20.12.0` precisely, not `>=20`: `@clack/prompts` imports
  `styleText` from `node:util`, added in 20.12, and it loads on every
  invocation. Verified against Node 20.11 (fails) and 20.12 (works). A policy
  test now compares the declared floor against every runtime dependency's own
  requirement, so an `engines` field that promises more than the dependencies
  deliver fails the build.

- **stdout now carries the payload and nothing else.** The banner, progress
  spinners, success ticks, warnings and errors all moved to stderr. In
  particular the banner used to be printed to stdout, so
  `senso ... --output json | jq` failed unless you also passed `--quiet`. It no
  longer does, and `--quiet` is no longer needed for machine use.

- **Exit codes now say what went wrong.** Every failure used to exit 1. Now:
  `0` success, `1` API or runtime error, `2` usage error, `3` authentication,
  `4` not found, `5` network failure or timeout. A script that tested for
  `exit != 0` is unaffected; one that tested for `exit == 1` should be reviewed.

- **`--output` is honored by every command.** Twenty-seven of thirty command
  files previously ignored it and printed JSON regardless of what was asked for.
  If you relied on `--output table` producing JSON, it now produces a table.

- **`--output table` renders a single object** as a two-column key/value table
  rather than silently falling back to JSON, and no longer prints
  `[object Object]` for a nested field.

- **Errors are structured under `--output json`.** A failure writes
  `{"error":{"code","message","status?","hint?"}}` to stderr and leaves stdout
  empty. `error.code` is a stable identifier; branch on it rather than on the
  message.

- **Invalid flag values now fail before the request is made,** with exit 2 and
  the valid values named. `--match-type`, `--tier`, `--priority`, `--status`,
  `--type` and `--sort` on the commands that document a closed set were
  previously forwarded to the API unchecked. One of these was worse than a
  wasted round trip: `generated-content --status` mapped any unrecognized value
  to `published`, so a typo returned a plausible-looking wrong list.

### Fixed

- **`senso kb get-content --version` and `senso kb download-url --version` were
  unreachable, and are now `--rev`.** The root command declares `-v, --version`
  for the CLI's own version and Commander answers it wherever it appears, so
  `senso kb get-content <id> --version 3` printed the CLI version and exited 0
  without making a request. Both flags were documented and neither ever worked.
  Pass `--rev <n>` instead; the request is unchanged (still `?version=<n>`).
  Renaming a documented flag would normally be breaking — this one is not, since
  no invocation of it can ever have done what it said.

- **`senso kb upload` flattened every failure to exit 1.** A rejected API key, a
  missing destination folder and an unreachable API all arrived as 1, so a script
  could not tell them apart. Only a whole-batch rejection is unpacked now (still
  exit 1, with the per-file reasons); everything else keeps its own code — `3`
  authentication, `4` not found, `5` network — as `senso ingest upload` already
  did.

- **`senso kb upload` accepted files `senso ingest upload` refuses.** A path that
  does not exist was a raw `ENOENT` at exit 1, and a zero-byte file was uploaded
  for an ingestion worker that cannot parse it. Both are now usage errors (exit 2) naming the file, before anything is sent.

- **`senso ingest reprocess <node-id> <file>` exited 1 on a path that does not
  exist,** where `senso ingest upload` exits 2. It now exits 2 and names the
  file, so the same mistake has the same exit code in both commands.

- **`senso content verification --status` and `--substatus` were not validated.**
  Both document a closed set in their help text and forwarded anything, so a typo
  cost a round trip and came back as a server-side validation error. They now
  fail at exit 2 with the valid values named, like the other closed-set flags.

- **`senso login` hung forever without a terminal.** It waited on a keypress
  that could never arrive, so it stalled CI and agent shells indefinitely. It now
  exits 2 immediately and names the two ways to authenticate that need no
  terminal.

- **`senso skills install` reported success when every skill failed to install.**
  It now exits non-zero if any skill failed, and reports which.

- **`senso skills install --all` installed six of the seven official skills.**
  `senso-onboarding` was published but never added to the CLI's list. A policy
  test now compares the list against a fixture.

- **`senso ingest upload` crashed on an empty confirmation.** Pressing Enter at
  the "type yes or no" prompt called `.trim()` on `undefined`.

- **`--output table` dropped a column** that the first row happened to omit,
  which is normal for these responses. Columns are now the union of every row's
  keys.

- **A single object containing a list rendered as only that list.** `senso org
get` showed the organization's locations and silently dropped its name, slug
  and tier from `plain` and `table` output.

- **A malformed `errors[]` in an API error body produced
  `undefined: undefined`** instead of the server's message.

- **`--output=json`** (the equals form) was not recognized by the quiet
  detection, so a banner still appeared.

- **A connection failure worded "Failed to fetch"** rather than Node's "fetch
  failed" was classified as a generic error, losing the exit-5 retry signal.

- **The update check ran on `--version` and `--help`,** reaching the npm registry
  and creating the config directory as a side effect. It no longer runs for
  either, nor for `login`, `logout` or `update`, and its timeout dropped from 10
  seconds to 3 — it is fired without being awaited, so that timeout was the
  worst-case delay between a command printing its output and the process exiting.

### Added

- **`senso ctas`** — call-to-action templates, the card a published
  content-engine page carries. List, create, update and delete templates; set or
  clear the organization default; read and set the CTA a single content item
  carries (`ctas for-content`, `ctas set-for-content`); and get a pre-signed
  upload URL for a CTA image (`ctas upload-url`). Requires the GEO product.

- **`senso kb stats`, `senso kb bulk-delete` and `senso kb permissions`.**
  `stats` returns the document and folder counts without paging through
  `my-files`; `bulk-delete` removes up to 100 nodes in one all-or-nothing call
  and refuses a larger batch before sending it; `permissions list|add|update|remove`
  manages the viewer and editor grants on a node.

- **Five `senso content` commands for the GEO reporting surface**:
  `provenance --url` audits how one published URL came to exist,
  `verification-velocity` reports publish-to-citation timing across the
  organization, `citation-details <id>` and `citation-prompts <id>` break one
  published item's citations down by destination and by prompt, and
  `record-edits <id> --data` bulk-records Builder edit telemetry.

- **`senso run-config model-options`, `scheduler-models` and
  `set-scheduler-models`.** The options command lists the model names
  `set-models` accepts, so an unsupported name no longer costs a round trip. The
  scheduler set is separate from the run-models list, though writing run models
  also replaces it.

- **`SENSO_DEBUG=1`** logs every request, its status and its duration to stderr,
  with the API key redacted.

- **`SENSO_CONFIG_DIR`** relocates the configuration file. Useful for
  per-project credentials, and it is what lets the test suite run without
  touching a real one.

- **An exit-code and environment-variable table in `senso --help`,** because the
  caller most likely to branch on an exit code is an agent, and `--help` is what
  an agent reads.

- **A test suite.** Unit tests for the library modules, in-process command tests
  for every command group against a mock API, an end-to-end suite that drives the
  built bundle as a subprocess, and policy tests that enforce this repository's
  own rules. There were previously no tests of any kind, and CI passed because
  it ran vitest with `--passWithNoTests`.

- **A CI pipeline that means something**: lint, typecheck, security, unit,
  end-to-end across three operating systems and four Node versions, build, and a
  smoke test that packs the tarball and installs it clean. It needs no secrets,
  so pull requests from forks run the full suite.

- **A Makefile** as the single contract between a developer's machine and CI.

- **Security scanning**: `npm audit`, semgrep, and gitleaks over the full git
  history with a deliberately empty allowlist.

- **`docs/`**, a generated command reference, `CONTRIBUTING.md`, `SECURITY.md`,
  `CLAUDE.md`, this changelog, `CODEOWNERS`, Dependabot, and pull request and
  issue templates. The repository previously had none of them.

- ESLint 9 with type-aware rules, Prettier, `.editorconfig`, `.nvmrc`, and
  optional pre-commit hooks.

### Internal

- Every command action is routed through a single `runAction` wrapper, replacing
  the eight lines of try/catch/format/exit that each of ~150 actions repeated.
  Commands throw instead of calling `process.exit`, which is what makes them
  testable in-process.
- `createProgram()` builds the command tree with no side effects; importing it no
  longer runs the CLI.
- `src/commands/analytics.ts` (1,299 lines) became `src/commands/analytics/`,
  one file per subcommand, with no behavior change.
- Every dependency moved to its current major. TypeScript is pinned at 5.9
  because no typescript-eslint release supports 7 yet.

## [0.12.0] — 2026-09-08

### Added

- `senso analytics` — the organization GEO analytics API: summary, mentions,
  citations, cited domains and pages, per-prompt performance, latest answers, a
  metric glossary, and the filter values that have data.
- `senso industries` — partner-scoped competitive intelligence. Requires a
  partner API key; the organization key is rejected.
- GitHub Actions CI and automated npm publishing via trusted publishing (OIDC),
  with no token secret.

## [0.11.0] — 2026-08

### Added

- Tags, product lines, and automatic tagging.
- Tracked competitors and citation-classification rules (`tracked-sources`).

## [0.9.0] — 2026-07

### Added

- Asynchronous sample-generation jobs, with polling.
- Streaming search, an interactive knowledge base folder picker, and an overhaul
  of the upload experience.

## [0.8.0] — 2026-06

### Added

- The agent skills installer (`senso skills`).

## [0.6.0] — 2026-05

### Added

- Knowledge base commands, credits, search scoping, and agent-friendly help text.

### Fixed

- Silent S3 upload failures in `ingest` and `kb upload` are now surfaced.

## [0.2.0] — 2026-04

### Added

- First published release: authentication, search, content, ingestion,
  organization administration, and self-update.

[Unreleased]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.11.1...v0.12.0
[0.11.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.9.0...v0.11.0
[0.9.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.8.2...v0.9.0
[0.8.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.7.0...v0.8.0
[0.6.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.5.0...v0.6.0
[0.2.0]: https://github.com/AI-Template-SDK/senso-user-cli/releases/tag/v0.2.0
