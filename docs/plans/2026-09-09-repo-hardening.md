# Senso CLI repository hardening plan

**Date:** 2026-09-09 · **Repo:** `AI-Template-SDK/senso-user-cli` (public, npm `@senso-ai/cli` 0.12.0) · **Reference repos:** `senso-contextos`, `live-survey`

This is the plan to take `senso-user-cli` from "works, ships to npm" to the standard set by
`senso-contextos` and `live-survey`: a full test suite that needs no secrets, a README a
stranger can trust, CI that means something, and the surrounding documents (CONTRIBUTING,
SECURITY, CHANGELOG, CLAUDE.md, a `docs/` set) that turn conventions into enforced rules.

It has three parts: **where the repo stands today** (an audit, with evidence),
**what "awesome" looks like** (the patterns lifted from the two reference repos and why
each one earns its place in a CLI), and **the work itself**, split into seven phases with
checklists. Phases are ordered so each one makes the next cheaper; the tracker at the
bottom is the thing to update as work lands.

The two references were hardened by the same hand in the same month and agree on almost
everything: Makefile as the CI contract, a mechanical network ban in tests, policy tests,
why-comments, the same five root documents. Where they differ, this plan says which one it
follows. contextos contributes the Vitest/MSW mechanics (same runtime as this repo) and the
richer policy-test catalog; live-survey contributes the `docs/` set with its 60-second
index, the "adding an endpoint" recipe in CLAUDE.md, the first-party-actions-only CI rule,
and the `print()` ban that becomes our `console.*` ban.

---

## 1. Where the repo stands today

### 1.1 The numbers

| Measure | Value | Source |
|---|---|---|
| Command groups / subcommands | 30 files / **169** subcommands | `node dist/cli.js <group> --help` |
| Source lines | 6,321 (analytics.ts alone is 1,341) | `wc -l src/**` |
| Test files | **0** | `npx vitest run` → "No test files found" |
| CI test step | `vitest run --passWithNoTests` | `.github/workflows/ci.yml` — green because it asserts nothing |
| Lint / format config | none | no eslint, prettier, editorconfig |
| Repo documents | README, LICENSE | no CONTRIBUTING, SECURITY, CHANGELOG, CLAUDE.md, CODEOWNERS, dependabot, PR template |
| README command coverage | 20 of 30 groups; **89 of 169 subcommands undocumented** | grep of README against `--help` |
| Commands honoring `--output` | **3 of 30 files** (`search`, `content`, `analytics`) | 115 raw `console.log(JSON.stringify(...))` sites elsewhere |
| `process.exit()` call sites | 174, inside command actions | makes actions untestable in-process |
| `npm audit --audit-level=high` | 7 findings (1 critical, 4 high) — all in `vite` via `vitest` (dev-only) | fixable by upgrading vitest |
| Outdated majors | `@clack/prompts` 0.9→1.8, `commander` 13→15, `env-paths` 3→4, `vitest` 3→5, `typescript` 5.9→7 | `npm outdated` |
| API spec coverage | **18 spec paths have no command**; 1 CLI path (`api-keys revoke`) not in spec | compared against `senso-contextos/docs/specs/sdk-api.yaml` |
| Skills list drift | CLI hardcodes 6 skills; contextos publishes **7** (`senso-onboarding` missing) | `src/commands/skills.ts` vs `senso-contextos/skills/` |
| British spellings in user-visible text | 7 sites (`organisation`, `synthesised`, `cancelled`) | grep |
| Secrets in git history | **none** — gitleaks v8.30.0 over all 42 commits, default rules | `docker run zricethezav/gitleaks:v8.30.0 detect` |

Typecheck and build are clean, the bundle is 184 KB ESM, and the publish workflow with
tag-matches-version guard and npm trusted publishing is solid. That part is done right and
this plan keeps it. The clean gitleaks result matters too: both reference repos found a
live key in their history on the first full scan and still carry an "OPEN — rotate" notice
in SECURITY.md. This repo starts with an empty allowlist that can stay empty.

### 1.2 Bugs and hazards found during the audit

These are concrete, reproducible, and each becomes a test in Phase 2.

1. **The banner is printed to stdout in JSON mode.** `senso roles list --output json` (no
   `--quiet`) writes `Senso CLI v0.12.0` to stdout before the JSON, so piping to `jq`
   fails. The README works around this by telling agents to always pass `--quiet`. Fix:
   banner goes to stderr, and is suppressed whenever `--output json`. (`src/cli.ts` preAction
   hook, `src/utils/branding.ts`)

2. **The update check runs on every invocation, including the ones it must not.**
   `checkForUpdate` is fired un-awaited before `parseAsync`, so it also runs for `login`,
   `logout`, `--version` and `--help`. It reaches the npm registry and creates the config
   directory as a side effect, which means `senso --version` is neither offline nor pure —
   awkward for a CI smoke test. Worse, the un-awaited `fetch` keeps the event loop alive
   after a successful command has printed its output, so once every 24 hours a command can
   linger until the registry answers or the 10s timeout fires. Fix: run the check from the
   `preAction` hook (which never fires for `--version`/`--help`), skip it for
   `login`/`logout`/`update`, and cut the timeout to 3s.
   *(Corrected 2026-09-09: an earlier draft of this item claimed the checker could clobber a
   freshly stored API key. It cannot — `updateConfig` re-reads the file immediately before
   writing and JavaScript is single-threaded, so `login`'s write is always preserved. Verified
   with a standalone reproduction before writing any fix.)*

3. **API key passed on the command line to shipables.** `skills install` runs
   `npx @senso-ai/shipables install ... --env SENSO_API_KEY=<key>`, so the key is visible in
   `ps` output and in shell history on a shared machine. **This cannot be fixed from here.**
   Confirmed against shipables 0.1.2: `--env` sets the MCP server's environment variables and
   the resolver never consults `process.env` for a value — non-interactively, an unsupplied
   variable becomes the empty string with a warning. Passing the key through the child's
   environment would therefore silently install a skill with no credential. Action: record it
   in SECURITY.md as a known limitation and raise it upstream with shipables (an
   `--env-from-env NAME` flag, or reading `process.env[name]` as a fallback, fixes it there).
   (`src/commands/skills.ts`)

4. **`outputByFormat` in `search.ts` is a dead branch** — both arms print JSON. `search
   context|content|full` therefore ignore `--output table|plain`.

5. **`--output table` silently falls back to JSON** for any command that does not supply
   rows, which is most of them. The flag is advertised globally but works for a handful.

6. **Quiet-mode detection is done by hand-parsing `process.argv`** in `main()` (looking for
   `--output` then peeking the next token), duplicating Commander and missing
   `--output=json`. Fix: resolve global options once, in a preAction hook, and pass them down.

7. **No exit-code contract.** Every failure is `process.exit(1)`, and Commander's own
   usage errors (unknown command, missing argument) also exit 1. Agents cannot distinguish
   "bad flag" from "401" from "network down". Fix: a small documented code set (see Phase 3).

8. **`skills` hardcodes the skill list** and is already out of date by one skill. Fix: read
   the list from a single JSON fixture that a policy test compares against the registry, or
   ask shipables for it at runtime.

9. **`api-keys revoke` posts to `/org/api-keys/{id}/revoke`**, which is not in the
   customer-facing spec. Either the spec is behind or the command is dead. Confirm with
   senso-api before Phase 5 decides which.

10. **Update check runs on every invocation**, including `--help` and `--version`, and
    creates the config directory as a side effect. Harmless, but it means `senso --version`
    is not a pure, offline command, which matters for CI smoke tests.

### 1.3 Structural issues (not bugs, but they block the test suite)

- **Commands call `process.exit()` directly** (174 sites). In-process tests cannot survive
  that; the whole suite would have to spawn subprocesses, which is slow and cannot measure
  coverage. This is the single biggest prerequisite: replace with a thrown `CliError` that
  `cli.ts` catches once.
- **`program` is built at module load with side effects** (`cli.ts` calls `parseAsync` on
  import). Tests need a `createProgram()` factory and a separate bin entry.
- **Each of ~150 actions repeats the same 8-line try/catch/format/exit block.** A single
  `runAction()` wrapper gives one place to put the error contract, the output contract and
  the exit code, and lets a policy test assert every action uses it.
- **Config path is not overridable.** Tests and CI need `SENSO_CONFIG_DIR` (or respect
  `XDG_CONFIG_HOME`, which `env-paths` does on Linux only) so they never touch a real
  `~/.config/senso/config.json`.
- **No network ban.** Nothing stops a future test from hitting `apiv2.senso.ai` with
  whatever key is in the developer's environment. contextos solved this mechanically with
  MSW `onUnhandledRequest: 'error'`; the same works for Node's `fetch`.

---

## 2. What "awesome" looks like (lifted from senso-contextos and live-survey)

Each pattern below is one at least one reference repo already runs, with the reason it
applies to a CLI. Rows marked *(both)* are shared; the rest name their source.

| Pattern | What contextos does | Why it matters here |
|---|---|---|
| **Makefile as the single contract** *(both)* | Every CI job calls a `make` target; `make all` locally == green pipeline. "Add the check to the Makefile first, then have CI call it." | Our CI runs ad-hoc `npx` commands nobody runs locally. Parity ends the "passes on my machine" class. |
| **CI needs no secrets** *(both)* | Enforced by a mechanical network ban (MSW `onUnhandledRequest: 'error'` in contextos, `pytest-socket --disable-socket` in live-survey), so fork PRs run the full suite. live-survey sets dummy env values inline in the workflow. | A public repo will get outside PRs. If tests needed `SENSO_API_KEY`, forks would silently skip them. |
| **Cheapest-first job chain** *(both)* | `lint → security → unit → build → smoke`, chained with `needs:`, `concurrency` cancels superseded runs. | A typo should not spend the minutes an OS-matrix smoke test costs. |
| **First-party actions only** *(live-survey)* | The workflow uses only `actions/checkout` and `actions/setup-python`; gitleaks runs from a pinned Docker image, Docker work uses plain `docker` commands. Reason given: one fewer third party with write access to the pipeline, and GitHub has hard-disabled old action majors before. | Same rule: `checkout` and `setup-node` only. Releases via `gh` in-workflow, scanners via pinned images. |
| **Policy tests** *(both)* | Tests that enforce the repo's own written rules. contextos: nav drift, `.env.example` completeness, American English, skills packaging. live-survey: swagger drift in both directions, and a **`print()` ban** in `app/` because "print has no level and no logger name, so it cannot be filtered". Failure messages name the offender. | Our README is 89 commands behind the code *because nothing checked*. The `print` ban maps directly onto a `console.*` ban outside `lib/output.ts` and `utils/logger.ts`, which is what makes the stdout contract enforceable. |
| **Failure cases first, test names as sentences, file docstring says what is worth protecting** *(both)* | `it('404s a traversal attempt reaching outside the specs directory')`; `test_the_liveness_endpoints_need_no_api_key`. | The interesting CLI cases are 401, 402, timeouts, malformed bodies, and a missing key — not the happy path. |
| **Coverage gate with headroom** *(both)* | live-survey achieves 95%, gates at 90; contextos achieves 94/95/77, gates at 85/85/70. "Do not lower the gate to pass" is a written rule in both. | Same. |
| **No import-time side effects in the unit under test** *(live-survey)* | "Import the app inside a fixture, not at module scope" — modules that build clients at import time are the reason. | Our `cli.ts` calls `parseAsync` at import. The `createProgram()` factory is the same fix. |
| **README / CONTRIBUTING / SECURITY / CHANGELOG / CLAUDE.md** *(both)* | Each answers one question; README has a "read it when you want to know" table pointing at the others. live-survey's README is ~150 lines: what it does, quick start, environment table, testing stages table, documentation table, repository layout. | A public CLI's README is its landing page. Contributors need the rules; security researchers need a contact; users need a changelog. |
| **A `docs/` set with an index** *(live-survey)* | `docs/README.md` opens with a "60-second version" then a table; one file each for architecture (with an ASCII component diagram), data model, API reference, development, deployment, operations. CLAUDE.md says "read architecture.md before a non-trivial change". contextos keeps the same set under `docs-internal/engineering/` because its `docs/` is the served app. | We have one 500-line README doing all of this. Split it: README for users, `docs/` for how it works. Nothing here is secret, so `docs/` is fine in a public tree. |
| **"Adding an endpoint" recipe in CLAUDE.md** *(live-survey)* | Seven numbered steps: models, service, data access, route, spec, tests (auth rejection, validation, each error branch, happy path), `make all`. | "Adding a command" is the one recipe every contributor here needs. It fixes the layering (`runAction`, `api-client`, `output`) as a checklist. |
| **SECURITY.md records known limitations as decisions** *(both)* | "Recorded here so they are decisions rather than oversights." Both carry an "OPEN — rotate the key" notice for a historical leak, and both refuse to let a gitleaks allowlist stand in for rotation. | The API-key-on-argv issue, the plaintext config file, the 0600 mode — all belong there. Our history is clean, so the allowlist starts and stays empty. |
| **CODEOWNERS, dependabot (monthly, grouped, majors separate), PR template with a Risk section** *(both)* | live-survey's Dependabot adds assignees and ignores the pinned language's major/minor because it "is pinned in three places". Its PR risk section asks: breaking API change, migration needed, rollback path. | Same for Node: pinned in `.nvmrc`, `engines`, CI, tsup target. Our risk questions: does this change stdout shape, exit codes, the config file, or what is sent to the API. |
| **Security scanning: dependency audit (high+), gitleaks over full history, SAST** *(both)* | `npm audit` + semgrep in contextos; `pip-audit` + bandit at medium severity in live-survey, with the reason "a scan whose output is routinely ignored stops being read at all". Pinned images, run through `make security` locally and in CI. | We ship a binary that handles credentials. gitleaks over history is cheap insurance for a public repo. |
| **Smoke test proves the shipped artifact, not the source** *(both)* | Boots the built image with dummy creds and probes only what needs no external service: routes registered, auth wired, non-root, healthy. Counts PASS/FAIL and dumps logs on failure. | Our artifact is the npm tarball. Smoke = `npm pack`, install into a temp prefix, run `--version`/`--help`/one mocked command on the OS × Node matrix. |
| **The version is tested, not trusted** *(live-survey)* | `/health` returns `app.version` and a test asserts it equals the real version, "not a literal that can drift". | `senso --version` must equal `package.json` version in the e2e suite, from the built bundle. |
| **Comments say why, config files open with a rationale** *(both)* | Every config file explains why its settings are what they are; deliberate oddities (line length 300, `ConsistentRead=True`) are listed under "things that look like bugs but are not". | Our tsup/tsconfig/CI files have none. |
| **CHANGELOG written for the person who has to act on it** *(both)* | Keep a Changelog; live-survey backfilled pre-1.0 history "by theme rather than listed individually". | Backfill our 41 commits the same way. |
| **Live API suite is separate, scheduled, never a PR gate** *(contextos)* | "A gate that silently passes is not a gate." | Same design for an optional `make live` canary that runs the built CLI against a real org. |
| **Commit style** *(both)* | Gitmoji prefix, lowercase imperative. | This repo already uses gitmoji; write it down. |

What the references do that we **should not** copy: Docker build/smoke and a deploy
runbook (no container, no server), Playwright (no browser), Spectral (no spec of our own —
we consume one), Datadog/observability (a CLI has no fleet to observe), and the
prompt-preview scripts (no LLM calls). The equivalent of "smoke" for a CLI is installing
the packed tarball on a Node/OS matrix and running it.

---

## 3. Target end state

When this plan is done, the following are all true and each is checked by CI:

- `make all` runs lint, typecheck, security, unit, build and smoke, and CI calls exactly
  those targets, cheapest first, with no secrets.
- Unit and command tests cover every `lib/` and `utils/` module and every command group,
  with the network banned; coverage gate at ≥85% statements/lines, ≥80% branches.
- A CLI end-to-end suite runs the built `dist/cli.js` as a subprocess against a local mock
  API on Linux, macOS and Windows for Node 18, 20 and 22.
- Policy tests fail the build if: a command is missing from the README; a command file
  does not use the shared action/output helpers; British spelling appears in user-visible
  text; `package.json` engines, `.nvmrc` and CI Node versions disagree; the skills list
  disagrees with its fixture; the CHANGELOG has no Unreleased section.
- Every command honors `--output json|table|plain`; stdout carries only the payload; all
  diagnostics go to stderr; exit codes follow a documented table.
- README has badges (CI, npm version, downloads, Node, license), a 60-second quick start,
  the agent contract (stdout/stderr/exit codes/env vars), and a complete command reference
  that is generated, not hand-maintained.
- CONTRIBUTING.md, SECURITY.md, CHANGELOG.md (Keep a Changelog), CLAUDE.md, CODEOWNERS,
  dependabot, PR template and issue templates exist.
- The publish workflow requires CI green, verifies the CHANGELOG has an entry for the
  version, publishes with provenance, and creates a GitHub release with the notes.
- The 18 missing endpoints are either implemented or listed as deliberately excluded, and
  a scheduled job diffs the CLI against the live spec and opens an issue on drift.

---

## 4. The work

Phases are ordered by dependency: 0 removes hazards, 1 sets up tooling the tests need, 2 is
the test suite, 3 fixes the behaviors the tests now pin, 4 documents it, 5 closes API drift,
6 hardens release. Effort is a rough size, not a promise.

### Phase 0 — Stop the bleeding (size: S, do first)

Fixes for the audit findings that are independent of everything else.

- [x] Send the mini banner to **stderr** and suppress it when `--output json` (bug 1)
- [x] Move the update check into the `preAction` hook so it never runs for `--version` or
      `--help`; skip it for `login`, `logout` and `update`; cut the registry timeout to 3s
      (bug 2, bug 10)
- [x] ~~Pass `SENSO_API_KEY` to shipables via the child environment, not argv (bug 3)~~ —
      **not possible**, verified against shipables 0.1.2 (no `process.env` fallback for an
      `--env` value). Comment added at the call site; SECURITY.md entry is tracked in Phase 4
      and the upstream request in Phase 5
- [x] Remove the dead `outputByFormat` branch in `search.ts` (bug 4)
- [x] Add `senso-onboarding` to the skills list (bug 8, interim until Phase 5 fixture)
- [x] Fix the 7 British spellings (`organization`, `synthesized`, `canceled`)
- [x] `npm audit fix` / bump vitest to clear the 7 dev-dependency advisories
- [x] Drop `--passWithNoTests` from CI — it should fail until Phase 2 lands, and that is
      the point (or land Phase 0 and Phase 2's first test together)

### Phase 1 — Tooling and repo hygiene (size: M)

Everything the test suite and contributors need before the first test is written.

**Task runner and parity**
- [ ] `Makefile` with `help install lint format typecheck security unit build smoke all clean live`, each with a `##` help line and a why-comment (mirror contextos)
- [ ] Rewrite `ci.yml` (rename to `testing.yml`, workflow name **Testing**, as both references do) to call only `make` targets, chained `needs:` cheapest-first, `concurrency` cancel-in-progress, `permissions: contents: read`
- [ ] **First-party actions only**: `actions/checkout` and `actions/setup-node`, pinned to current majors. Everything else (gitleaks, semgrep, release creation) runs from a pinned image or the `gh` CLI. Write the reason at the top of the workflow.
- [ ] Add `.nvmrc` (22) and a policy test that `.nvmrc`, `engines.node` floor (18) and the CI matrix agree

**Lint and format**
- [ ] ESLint 9 flat config with `typescript-eslint` (strict, type-checked), `no-console` **off** but with a rule that only `lib/output.ts` and `utils/logger.ts` may write to stdout/stderr directly (via `no-restricted-syntax` on `console.*` outside those files) — this is what makes the stdout contract enforceable
- [ ] Prettier + `.prettierrc.json` + `.prettierignore`; `.editorconfig`
- [ ] `lint-staged` + husky pre-commit running only the fast checks (Prettier, ESLint `--fix`, gitleaks on staged diff) — contextos's `scripts/pre-commit-checks.sh` is the template

**Security**
- [ ] `make security`: `npm audit --audit-level=high` + gitleaks (pinned image `zricethezav/gitleaks:v8.30.0`, full history, **empty allowlist** — the history is clean as of 2026-09-09) + semgrep `p/nodejs` `p/security-audit` (pinned image). Comment each gate's threshold with why, as live-survey does for bandit's medium severity
- [ ] CI security job uses `fetch-depth: 0`

**GitHub**
- [ ] `.github/CODEOWNERS` (default owner; call out `src/lib/config.ts`, `src/lib/api-client.ts`, `.github/`, `Makefile`)
- [ ] `.github/dependabot.yml` — npm and github-actions, monthly, minor+patch grouped, majors separate, assignee set, `@types/node` majors ignored with the "pinned in four places" comment
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` with What / Why / Checklist / Risk / Verified how. Risk asks four yes/no questions: does this change stdout shape or `--output json` payloads, exit codes, the config file format, or what is sent to the API; plus "safe to roll back by reverting alone?" Blank is not an answer
- [ ] `.github/ISSUE_TEMPLATE/` bug + feature, bug template asks for `senso --version`, OS, Node, and the command with `--output json`
- [ ] Set the GitHub repo description and homepage (currently empty) to match `package.json`
- [ ] Replace the 150-line boilerplate `.gitignore` with the 15 lines this repo needs

**Dependencies**
- [ ] Upgrade `commander` 13→15, `@clack/prompts` 0.9→1.x, `env-paths` 3→4, `vitest` 3→5, `@types/node`; check `typescript` 7 separately (major, may need tsup bump)
- [ ] Pin GitHub Actions to current majors (`checkout@v7`, `setup-node@v7` as contextos does)

### Phase 2 — Test suite (size: L, the core of the plan)

> **Sequencing deviation, decided during execution.** The prerequisite refactor below and
> the whole of Phase 3 land *before* the tests are written, in that order. The plan as
> drafted had Phase 2 pin current behavior and Phase 3 then change it, which means writing
> ~30 command test files against behavior that is about to be replaced and rewriting them
> a week later. Nothing in Phase 3 depends on the tests existing, so doing it first costs
> nothing and saves the rework. The tracker reflects the executed order.

**Prerequisite refactor** (tests cannot be written against the current shape):
- [ ] `src/lib/errors.ts`: `class CliError extends Error { exitCode }`; replace all 174 `process.exit()` in commands with `throw new CliError(...)` or a return; `cli.ts` catches once, formats, exits
- [ ] `src/lib/run-action.ts`: `runAction(program, async (ctx) => ...)` that resolves global opts (apiKey, baseUrl, output, quiet) into a typed `ctx`, wraps the handler, maps `ApiError`/`CliError`/unknown to stderr + exit code. Every action goes through it.
- [ ] `src/program.ts` exporting `createProgram(): Command` with zero side effects; `src/cli.ts` becomes the 10-line bin that calls it (tsup entry unchanged)
- [ ] `SENSO_CONFIG_DIR` env override in `config.ts` (documented; used by tests and CI)
- [ ] Inject `fetch` (or accept a base URL) so tests never need real DNS — MSW handles this without injection, but a `SENSO_BASE_URL` override already exists and e2e uses it

**Layer 1 — unit (`tests/unit/`)**, no network, `@vitest-environment node`:
- [ ] `config.test.ts` — precedence flag > env > file; 0600 mode; missing/corrupt file → `{}`; `clearConfig` idempotent; `SENSO_CONFIG_DIR` honored
- [ ] `api-client.test.ts` — headers (`X-API-Key`, `User-Agent` carries version); query param encoding drops `undefined`; 204 → undefined; non-JSON body → error; `ApiError` message extraction for `error|message|detail|errors[]` shapes; **timeout aborts at 30s** (fake timers); `formatApiError` table for 401/402/403/404/409/5xx/AbortError/ECONNREFUSED
- [ ] `output.test.ts` — table column widths, empty rows, `columns` subset, plain string vs array, json indentation
- [ ] `tag-args.test.ts` — csv trimming, empty → `{}`, id preferred over name
- [ ] `updater.test.ts` — 24h gate, cached-newer shows box, `SENSO_NO_UPDATE_CHECK=1`, registry failure is silent, **does not clobber other config fields**
- [ ] `version.test.ts` — reads `package.json` from `dist/` and `src/` layouts
- [ ] `errors.test.ts` / `run-action.test.ts` — exit code mapping, stderr-only on failure, stdout untouched on failure in json mode

**Layer 2 — command tests (`tests/commands/`)**, in-process, MSW with `onUnhandledRequest: 'error'` in `tests/setup.ts` (the network ban), stdout/stderr captured via spies on `process.stdout.write`:
- [ ] One file per command group (30). Each covers, in this order: 401 → auth message + exit 3; 404; malformed body; then the happy path in `json`, `table` and `plain`
- [ ] Assert the **exact request** each command sends (method, path, query, body) — this is where the CLI's contract with the API lives, and it is what catches "the API renamed a param"
- [ ] `--data <json>` commands: invalid JSON → usage error, not a stack trace
- [ ] `ingest upload` / `kb upload`: the two-step presigned-URL flow, per-file conflict/duplicate/invalid outcomes, S3 PUT failure surfaces per file
- [ ] `generate sample`: polling loop with fake timers, `--no-wait`, terminal states, timeout message
- [ ] `search stream`: SSE parsing across chunk boundaries (split mid-line), `error` event, `sources` event in json mode
- [ ] `login`: mock `@clack/prompts` `text`; cancel path; verification failure leaves config untouched
- [ ] `whoami`: cached fallback when API unreachable
- [ ] `skills`: shipables invocation args (asserting the key is **not** on argv after Phase 0)

**Layer 3 — CLI end-to-end (`tests/e2e/`)**, spawns `node dist/cli.js` against a `node:http` mock server via `SENSO_BASE_URL` + `SENSO_CONFIG_DIR` in a temp dir. This is what proves the bundle, not the source:
- [ ] `--version` and `--help` exit 0, print nothing to stderr, touch no network, create no config dir
- [ ] `--version` output equals `package.json` version read at test time — not a literal that can drift (live-survey's `/health` test)
- [ ] `--output json` stdout is parseable JSON with **nothing else** on stdout, for a sample of 10 commands
- [ ] Exit codes: usage (2), auth (3), API error (1), success (0)
- [ ] `login` non-interactive (stdin not a TTY) fails with a clear message instead of hanging
- [ ] `NO_COLOR=1` strips ANSI; `--quiet` strips banner and info lines
- [ ] Windows path handling for `ingest upload` (runs on the OS matrix in CI)

**Layer 4 — policy (`tests/policy/`)**, the repo's own rules, failure messages name the offender:
- [ ] `readme-commands.test.ts` — every registered subcommand (walk `createProgram()`) appears in README's reference; every README `senso ...` line is a real command (both directions)
- [ ] `output-contract.test.ts` — every action in `src/commands/` is registered via `runAction`; no `console.*` outside `lib/output.ts`/`utils/logger.ts`/`utils/branding.ts`. This is live-survey's `test_no_module_in_the_app_package_calls_print`, for the same reason: a bare write has no stream discipline, and that is how the banner ended up in JSON stdout
- [ ] `american-english.test.ts` — port of contextos's, scoped to `src/` and `README.md`
- [ ] `descriptions.test.ts` — every command and option has a description; descriptions end with a period; no description exceeds N chars (agents read these)
- [ ] `node-version.test.ts` — `.nvmrc`, `engines`, CI matrix, tsup `target` agree
- [ ] `skills-list.test.ts` — the skills fixture matches `tests/fixtures/shipables-registry.json` (refreshed by the scheduled drift job in Phase 5)
- [ ] `changelog.test.ts` — `CHANGELOG.md` has `## [Unreleased]`; every git tag `v*` has a matching section
- [ ] `package.test.ts` — `files` is exactly `["dist"]`; `bin` points at an existing built file after `make build`; no `dependencies` unused (`depcheck`)

**Gates and CI**
- [ ] `vitest.config.ts` with a why-comment, `coverage.provider: v8`, thresholds set at achieved-minus-headroom once the suite exists (target ≥85/80/85/85), `include: src/**`, exclude `src/cli.ts` (the bin)
- [ ] `make unit` = `vitest run --coverage`; CI publishes the coverage table to the step summary (`if: always()`), as contextos does
- [ ] `make smoke` = `npm pack` → install the tarball into a temp prefix → run `senso --version`, `senso --help`, one mocked command. CI runs it on `ubuntu`/`macos`/`windows` × Node `18`/`20`/`22`
- [ ] e2e job depends on build; smoke depends on e2e

### Phase 3 — Output, error and exit-code contract (size: M)

The tests in Phase 2 pin current behavior; this phase changes it deliberately, updating
tests alongside. Document the result in README under "Using with AI agents".

- [ ] **stdout is the payload, stderr is everything else.** Banner, spinners, `log.info`, update box, success lines all go to stderr. `--quiet` silences stderr chatter; it never changes stdout.
- [ ] **`--output json` on every command**, including the 27 files that ignore it today. In json mode, errors are also JSON, on stderr: `{"error":{"code":"unauthorized","status":401,"message":"..."}}`
- [ ] **`--output table` works or is refused.** Commands that return a list get `rows`/`columns`; commands that return a single object render a two-column key/value table; no more silent JSON fallback
- [ ] **Exit codes:** `0` success · `1` API or runtime error · `2` usage (Commander default) · `3` authentication (missing/invalid key, 401/403) · `4` not found (404) · `5` network/timeout. Put the table in README and in `--help` epilog
- [ ] `--output=json` (equals form) works; global options are resolved once via Commander, not by scanning `argv`
- [ ] `NO_COLOR` and `FORCE_COLOR` honored (picocolors does this; add a test so it stays true)
- [ ] `SENSO_DEBUG=1` prints each request (method, URL, status, elapsed) to stderr with the key redacted — the first thing anyone asks for when a command fails in an agent
- [ ] Non-TTY `login` fails fast with "stdin is not a terminal; set SENSO_API_KEY" instead of waiting on a prompt
- [ ] Split `analytics.ts` (1,341 lines) into `analytics/` with one file per subcommand and a shared `render.ts`; no behavior change

### Phase 4 — Documentation (size: M)

**README.md** — rewrite, not edit. Structure:
- [ ] Badges row: CI status, npm version, npm downloads/month, Node ≥18, license AGPL-3.0. (All five resolve to real endpoints today; do not add a coverage badge unless a coverage service is adopted — a Codecov badge with no upload is a lie)
- [ ] One-paragraph what-it-is, then a 60-second quick start (install, `SENSO_API_KEY`, one search, one `--output json`)
- [ ] "Using with AI agents" as the second section: the stdout/stderr/exit-code contract, env vars table, the one-line `--output json --quiet` recipe, and the `skills install` path
- [ ] Command reference **generated** from `createProgram()` by `scripts/gen-reference.ts` into `docs/reference/commands.md`, linked from README; the README keeps a grouped one-liner table. Policy test asserts the generated file is current
- [ ] "Read it when you want to know" table pointing at CONTRIBUTING, SECURITY, CHANGELOG, CLAUDE.md, `docs/reference/commands.md`
- [ ] Keep the excellent analytics "reading the numbers" section; move it to `docs/analytics.md` and link it, so the README stays scannable
- [ ] Config file location table, auth precedence, update behavior — keep, trim
- [ ] "Testing" section as a five-row stages table (Lint / Security / Unit / Build / Smoke → command → what it checks) and a "Repository layout" block, both in live-survey's form; target the whole README at about 200 lines

**New documents**
- [ ] `CONTRIBUTING.md` — setup, `make all`, the non-negotiables (network ban in tests; every command through `runAction`; README/reference regenerated in the same PR; American English; no credential in a tracked file; do not lower the coverage gate), test layering table, commit style (gitmoji), release steps
- [ ] `SECURITY.md` — reporting address; what the CLI holds (API key in `config.json`, 0600, plaintext by design — keychain integration listed as future work); what leaves the machine (`X-API-Key`, `User-Agent` with version, update check to npmjs.org); known limitations recorded as decisions (argv exposure if shipables cannot read env; no certificate pinning; no key rotation command)
- [ ] `CHANGELOG.md` — Keep a Changelog, "written for the person who has to act on them"; backfill from the 41 commits and 6 published versions **by theme rather than commit**, as live-survey did for its pre-1.0 history; then `[Unreleased]` going forward; the publish workflow checks the version has a section (Phase 6)
- [ ] `CLAUDE.md` — what this is, layout, `make all` before finishing, non-negotiables, testing conventions, comment style, "things that look like bugs but are not" (the version walk-up in `version.ts`; banner on stderr; update check skipped for some commands; `--output table` refusing rather than falling back), and an **"Adding a command"** recipe in live-survey's numbered form: 1. path and params from the spec, 2. register under the right group via `runAction`, 3. `--output` for all three formats, 4. tests: missing key, 401, 404, malformed body, exact request shape, happy path per format, 5. README one-liner + regenerate the reference, 6. CHANGELOG entry, 7. `make all`
**The `docs/` set** (live-survey's shape; nothing here is secret, so it lives in the public tree)
- [ ] `docs/README.md` — index opening with "The 60-second version" (three or four bullets: one bundle, one config file, one HTTP client, one output contract) then a "read it when you want to know" table
- [ ] `docs/architecture.md` — how one invocation flows, with an ASCII diagram: argv → Commander → `runAction` → `api-client` → `output`; where the config and update checker sit; what is deliberately not there (no daemon, no cache, no telemetry)
- [ ] `docs/configuration.md` — every env var and flag with purpose and default (`SENSO_API_KEY`, `SENSO_BASE_URL`, `SENSO_CONFIG_DIR`, `SENSO_NO_UPDATE_CHECK`, `SENSO_DEBUG`, `NO_COLOR`), config file location per OS, precedence, file mode. A policy test checks every `process.env.SENSO_*` read in `src/` is documented here (contextos's `.env.example` test, inverted)
- [ ] `docs/development.md` — setup, the `make` stages table, test layers, how to add a command (the recipe also lives in CLAUDE.md), how to regenerate the command reference
- [ ] `docs/releasing.md` — the tag-driven publish, what the workflow checks, what to do when it fails, how to yank
- [ ] `docs/reference/commands.md` (generated) and `docs/reference/excluded-endpoints.md` (Phase 5)
- [ ] `docs/plans/` — this file; later plans go beside it

### Phase 5 — API coverage and drift prevention (size: M)

- [ ] Triage the 18 uncovered spec paths with the API owner. Likely groups: **CTAs** (`/org/ctas*`, `/org/cta-assets/upload-url`, `/org/content/{id}/cta`), **KB permissions** (`/org/kb/nodes/{id}/permissions*`), **content insights** (`provenance`, `verification/velocity`, `citation-details`, `citation-prompts`, `edit-events/bulk`), **KB** (`bulk-delete`, `stats`), **models** (`run-models/options`, `scheduler-models`), and `generated-content/drafts|published` (may already be covered by `--status`; confirm the path)
- [ ] Implement each, or add it to `docs/reference/excluded-endpoints.md` with a reason
- [ ] Resolve `api-keys revoke` (spec behind, or dead command)
- [ ] `scripts/spec-drift.ts`: fetch `https://docs.senso.ai/specs/sdk-api.yaml`, diff paths against `createProgram()` paths, print a table. Run by `.github/workflows/spec-drift.yml` **weekly and on demand, never on PRs** (it touches the network), opening or updating a single issue on drift
- [ ] Same job refreshes `tests/fixtures/shipables-registry.json` from the registry and opens a PR if the skills list changed
- [ ] Vendor the spec paths list as a fixture so the *policy* test (no network) can assert every command path exists in the last-known spec

### Phase 6 — Release hardening (size: S)

The current publish flow is good; these make it safer and more informative.

- [ ] `publish.yml` waits for the `CI` workflow to be green on the tagged commit (`workflow_run` or a `needs:` on a reusable CI job) — today a tag publishes even if CI failed
- [ ] Fail publish if `CHANGELOG.md` has no `## [x.y.z]` section for the tag; move `[Unreleased]` items under it as part of `npm version` via a `version` script
- [ ] `npm publish --provenance` explicitly (trusted publishing implies it; make it visible)
- [ ] Create a GitHub Release from the CHANGELOG section with `gh release create` in-workflow (the `gh` CLI ships on the runner) — no third-party release action, per the first-party-actions rule
- [ ] Smoke the **published** package post-release: `npx @senso-ai/cli@<tag> --version` from a clean runner
- [ ] Document the release procedure in CONTRIBUTING (it is in README today; move it)
- [ ] Add `RELEASING.md` only if the procedure outgrows a CONTRIBUTING section — probably not

### Phase 7 — Live canary (size: S, optional)

Mirrors contextos's `api-endpoint-tests.yml`: real key, real org, scheduled, never a PR gate.

- [ ] `make live` runs `tests/live/` — read-only commands (`whoami`, `org get`, `content list --limit 1`, `analytics summary`, `credits balance`) against the built CLI with `SENSO_API_KEY` from a repo secret
- [ ] `.github/workflows/live-canary.yml` — `schedule` (daily) + `workflow_dispatch`; skips with a warning when the secret is absent; opt-in per PR via a `live-api` label
- [ ] Destructive commands only behind `--destructive` and only against a non-production `SENSO_BASE_URL` var

---

## 5. Order of operations and rough sizing

| Phase | Depends on | Size | Outcome that unblocks the next |
|---|---|---|---|
| 0 Stop the bleeding | — | S | Hazards gone; CI honest |
| 1 Tooling | 0 | M | `make all`, lint, security scans, GitHub scaffolding |
| 2 Test suite | 1 (and the `runAction`/`CliError` refactor) | L | Behavior pinned; coverage gate live |
| 3 Output contract | 2 | M | Every command agent-safe |
| 4 Documentation | 3 (README documents the new contract) | M | Public face done; policy tests keep it true |
| 5 API drift | 2 | M | Coverage complete; drift becomes an issue, not a surprise |
| 6 Release hardening | 4 (CHANGELOG exists) | S | Tags cannot publish broken builds |
| 7 Live canary | 6 | S | Early warning on API changes |

Phases 3 and 5 can run in parallel once 2 lands. Phase 4's README can start during 3 as
long as it is finished after.

**Definition of done for the whole plan:** every checkbox above is ticked or moved to a
"deliberately not done" list in this file with a reason, `make all` is green on a fresh
clone with no secrets, the OS matrix is green, and the README badges are all green.

---

## 6. Decisions to confirm before starting

1. **Makefile vs npm scripts only.** Recommendation: Makefile wrapping npm scripts, for
   parity with contextos and the "CI calls what you run" rule. Costs nothing on Windows
   contributors' side since CI covers Windows and `make` is only the developer entry point.
2. **Coverage service.** Recommendation: none. Gate in CI, table in the step summary,
   no badge. Revisit if someone actually wants the trend graph.
3. **Exit-code table** (Phase 3). The values above are a proposal; the important thing is
   that they are documented and tested, not which numbers.
4. **Where the API key lives.** Plaintext `config.json` at 0600 is fine for a CLI whose
   users are developers and agents; OS keychain support is a real feature, not hygiene,
   so it is out of scope here and goes in SECURITY.md as a known limitation.
5. **Typescript 7.** Major bump; check tsup and typescript-eslint support before
   including it in Phase 1, otherwise defer.
6. **`docs/` in the public tree.** live-survey keeps its docs public-in-repo; contextos
   moved them to `docs-internal/` only because its `docs/` is a served app. This repo has
   no served surface and nothing in the planned docs is sensitive, so `docs/` at the root
   is the recommendation. Anything that ever is sensitive goes in a private repo, not a
   sibling directory.

---

## 7. Tracker

Tick phases here as they land. Sub-item checklists are in Section 4.

- [ ] Phase 0 — Stop the bleeding
- [ ] Phase 1 — Tooling and repo hygiene
- [ ] Phase 2 — Test suite
- [ ] Phase 3 — Output, error and exit-code contract
- [ ] Phase 4 — Documentation
- [ ] Phase 5 — API coverage and drift prevention
- [ ] Phase 6 — Release hardening
- [ ] Phase 7 — Live canary (optional)
