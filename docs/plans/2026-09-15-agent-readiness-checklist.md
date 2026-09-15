# Senso CLI agent-readiness checklist

**Date:** 2026-09-15 · **Repos:** `senso-user-cli` (v0.17.0, main @ 220eaf3), `senso-api`, `senso-contextos/skills` · **Source:** the per-command review published at https://claude.ai/artifact/B5f1W4bDcPAjArbqeTXYHK

The CLI is consumed by AI agents. An agent sees stdout, stderr and an exit code, and reads
`--help` to learn a command; anything the CLI does not say, it invents. This checklist is
every change needed so that an agent never has to guess what an input is, where an id comes
from, what a status means, what to do next, or why a call failed. It covers all 205 commands
in 39 groups plus the program-level behavior, each reviewed against the `senso-api` route,
handler and DTO behind it.

|                                                                                |                                   |
| ------------------------------------------------------------------------------ | --------------------------------- |
| Commands reviewed                                                              | 205 (+ 9 program-level behaviors) |
| 🔴 High — an agent following today's output does the wrong thing or gets stuck | 92                                |
| 🟠 Medium — it has to guess                                                    | 96                                |
| 🟢 Low — polish                                                                | 26                                |
| Per-command CLI items (Part D)                                                 | 1071                              |
| Per-command API items (Part E)                                                 | 323                               |

**How to work this list.** Parts A–C are the cross-cutting changes; do them first and in
order, because most of Part D is an instance of one of them and becomes a one-line edit once
the shared helper exists. Part D is every command's own items; Part E is what `senso-api`
has to change for the CLI to be able to say the right thing. Check items off in place.

---

## Part A — Cross-cutting changes in `senso-user-cli`

### A1. The JSON envelope (`src/lib/output.ts`, `src/lib/run-action.ts`) — breaking, ship as 1.0

- [x] Every success under `--output json` writes `{ ok: true, command, data, page?, next?, warnings? }` to stdout. `data` is the API payload, unmodified; never rename its keys.
- [x] `emit()` gains `{ page, next, warnings }` options; `page` is `{ offset, limit, returned, total, has_more, next }` where `next` is the runnable next-page command.
- [x] `next` is an array of `{ why, command }` with real ids substituted — this is where every stderr hint that `--output json` currently discards goes (gaps get next steps, "poll kb get <id>", "read it with evals get <id>", undo commands).
- [x] `warnings` names anything the API did that the caller may not expect (list replaced, items skipped and why, publish_status failed on a 200).
- [x] `emitConfirmation()` emits `data: { action, resource, id }` instead of `{ ok, message }`.
- [x] Keep `--output json` implying quiet on stderr, but move the content of those hints into `next`/`warnings` so nothing is lost.
- [x] Bump the major version; CHANGELOG entry explaining `.answer` → `.data.answer`; update README "Using it from an agent" and the root help epilog with the envelope shape.
- [ ] Update every `jq` path in the seven skills (Part C).

### A2. The error contract (`src/lib/errors.ts`, `src/lib/api-client.ts`, `src/lib/run-action.ts`)

- [x] JSON error is `{ ok: false, error: { code, message, status?, field?, received?, allowed?, hint, request? } }` on stderr; stdout stays empty. Add `validation` to the stable code set for API 400/422 field errors.
- [x] `toCliError` stops discarding the API message on 404 and 401. Add a `notFound(resource, id, listCommand)` helper and use it at every call site so the message is "KB node <id> not found in organization <slug>", never "Not found.".
- [x] 409: keep the whole body — `existing_content_id` (uploads) must reach the agent as `error.details`.
- [x] 400/422: prefix the API message with what was attempted; surface `errors[]` field lists and extra keys (`valid_models`, `suggestions`) under `error.details`. `extractErrorMessage` must not drop them.
- [x] 403: distinguish (a) missing permission — name the scope and say an org admin can grant it, (b) missing product — "requires the GEO product", (c) KB node access — hint `kb permissions add`, (d) partner key required — hint `senso industries`. Read the middleware message to pick the branch.
- [x] 501/503 deployment refusals ("History imports are not available", "Evals are not enabled") pass through verbatim with no "retry shortly" hint.
- [x] 5xx keeps "not your fault" but includes the API message when the body has one.
- [x] Every error carries exactly one `hint`, and it is a runnable command whenever one exists.
- [x] `SENSO_DEBUG=1` adds `request: { method, path }` to every API error; consider always including it.

### A3. Commander failures go through the contract (`src/program.ts`, `src/cli.ts`)

- [x] Unknown command, unknown option, missing argument and a bare group with no subcommand are reported through `reportError`: JSON under `--output json`, exit 2, hint `senso <group> --help`. Keep the "Did you mean" suggestion in `hint`.
- [x] A bare group prints a one-line list of its subcommands (not the full help dump) and exits 2; groups with one obvious action (`credits`) get it as the default.
- [x] The README claim "errors are JSON too" becomes true.

### A4. Validation before the request (`src/lib/enum-arg.ts`, new `src/lib/id-arg.ts`, `src/lib/json-arg.ts`)

- [x] `parseUuidArg(label, value, idSpaceHint)` and use it for every `<id>` argument and every id flag → exit 2 with "ids are the `x_id` field of `senso <list command>`". No command validates its id today except `gaps`, `evals claims`, `gaps answer`.
- [x] Every `--limit`/`--offset` through `parseIntFlag` with the endpoint's real range; reject, never clamp (`search --max-results 999` → 20 and `abc` → 5 today).
- [x] Every closed set through `parseEnumFlag`, with the allowed values in the help text and in `error.allowed`. Missing today: `generate runs-list --status`, `generate runs-items --status`, `prompts create type`, `--models` everywhere, tracked-sources `--category`, several `--sort`/`--order` flags.
- [x] Date flags: one helper per format, named in help ("YYYY-MM-DD" vs "RFC 3339 instant"), validated → exit 2. Decide whether `evals --from/--to` should accept the date form too.
- [x] `--data` bodies: a per-command schema listing required keys, optional keys, and the meaning of `[]` vs `null` vs omitted; unknown keys named → exit 2. Refuse an empty replacement body (`kb tags set`, `content tags set`, `prompts tags set` with no flags currently send `{}` = clear all).
- [ ] Mutually exclusive / required-together flag pairs checked → exit 2 naming both flags.
- [ ] Files: `assertFilesExist` and a local content-type check before any upload call (`kb update-file` skips it today; `.md`/`.json`/`.xml` are always rejected by the API and should exit 2 pointing at `kb create-raw`).

### A5. Plain and table rendering (`src/lib/output.ts`)

- [x] Single object: nested objects as indented sub-blocks, arrays of objects as numbered sub-blocks; never an inline JSON string. Primary id on the first line.
- [x] Lists: numbered blocks, id first; stderr footer "Showing a–b of n. Next page: <command>" from one shared helper.
- [x] Empty list: "No <things> found." on stdout plus a stderr note about any default filter that hid results (gaps weak, tags curated) and the command that widens it. Today the envelope renders as key/value with a blank value.
- [x] `findRows`: a payload that is one object-array plus scalar/object extras (`sort_by`, `scope`, `mode`, `window`, `totals`, `history_import`) renders as a list with the extras as a header block, instead of stringifying the array. Affects `questions list`, `run-config model-options`, `competitors suggest`, `industries brands`, `import-prompts`, `partner prompt-metrics`, `content verification`, `content versions`, `content provenance`, `evals get`.
- [x] Table honors declared `columns` even when `findRows` declines, and warns on stderr when a declared column is absent from every row (this would have caught A6).
- [x] Mutations: "✓ <Verb> <resource> <id>." on stderr, record on stdout, then "Next: <command>" lines.
- [ ] Async: each status transition on stderr; the exact poll command whenever the CLI returns before the work is done.

### A6. Columns that name fields the API never returns

- [x] `tags list`, `kb tags *`, `content tags *`, `prompts tags *`: `tag_id` → `id` (dto.TagResponse).
- [x] `competitors list`: `competitor_id` → `id`.
- [x] `tracked-sources list`: `source_id` → `id`.
- [ ] `prompts list`: verify `prompt_id` against the prompt DTO; `content list`/`generated-content list`: `status`/`processing_status`/`id` mappings.
- [x] Policy test: every string in a `columns` array must be a json tag on the endpoint's response DTO (generate the tag list from `senso-api/internal/api/dto` into a fixture).
- [ ] MSW fixtures are built from the DTO shapes, not invented; the existing fixtures spell ids the CLI's way, which is why the suite is green.

### A7. Help text (`src/program.ts`, every `src/commands/*.ts`)

- [x] A `describeCommand({ summary, arguments, returns, exitCodes, examples, seeAlso })` helper that emits the standard sections through `addHelpText`, so every leaf command has Arguments (with id space and source command), Options (required/default/allowed values), Returns (fields and enum meanings), Exit codes (specific to the command), Examples, See also.
- [ ] Every group description states the id spaces it uses and the typical workflow as an ordered command list.
- [ ] Every status/enum field a command returns has its values and meanings in Returns (processing_status, eval status/verdict/band, gap kind/problem/status/origin, run status, publish_status, tier).
- [ ] Policy test: every leaf command's help contains the Returns, Exit codes and Examples sections.
- [ ] `make reference` after; the generated reference picks the sections up.

### A8. Correctness fixes that fall out of the review

- [ ] `engine publish`: branch on `publish_status` in the payload — "failed" is exit 1 with the per-destination reasons, not "✓ Content published".
- [ ] `content unpublish`: report the API's `unpublished_count`, not the number of ids requested.
- [ ] `kb upload` / `ingest upload` in plain mode: print `kb_node_id`, `content_id` and status per file on stdout; exit non-zero (or at least `warnings`) on a partial batch.
- [ ] `search` with no hits: print "No results." and, when signals were on, "This search was filed as a gap; see `senso gaps list --status weak`".
- [ ] `whoami --output json`: snake_case keys like every other command.
- [ ] `analytics summary` and every hand-written renderer: guard the shape and throw a CliError naming the endpoint rather than a raw TypeError.
- [ ] `skills install/remove`: fix the double prefix (`senso-ai/senso-senso-ai/…`), validate short names → exit 2, keep the API key out of argv, and do not echo argv on failure.
- [ ] `update`/`uninstall`: capture npm output so stdout is one JSON document under `--output json`.
- [ ] `questions` group help: prompts and questions are the same `geo_questions` rows; say so, and warn that `questions delete` destroys run history.

---

## Part B — Cross-cutting changes in `senso-api`

- [ ] Error body: `{ status, message, code?, field?, details? }`. Binding failures name the field and constraint instead of "Invalid request body" / "Invalid request payload" (`internal/api/middleware/response.go`, every `ShouldBindJSON` site).
- [ ] Never discard a bind error. `UnpublishContent` does `_ = c.ShouldBindJSON(&body)`; a malformed id empties `publish_record_ids` and the request falls through to unpublishing from every destination. Reject with 400 naming the field.
- [ ] 404, not 400, for a missing resource: `POST /org/gaps/{id}/resolutions` ("gap not found"), and any handler that flattens service errors into 400 with a raw Go string.
- [ ] `rejectKBContent` (400 "Knowledge base content must be accessed through KB node endpoints"): keep the status but add a stable `code` (e.g. `kb_content_use_kb_endpoints`) and include the `kb_node_id` so a client can redirect the call.
- [ ] List envelope: `{ items, total, limit, offset }` on every list endpoint; scalar extras (`sort_by`, `scope`, `mode`, `window`) under `meta`. `total` is the org-wide count, not the page size (`product-lines`). Expose `limit`/`offset` where the API pages internally but the route hides it (`/partner/industries` defaults to 10).
- [ ] Every status/enum field is enumerated in `docs/specs/sdk-api.yaml` (senso-contextos), including values only visible in Go today (run statuses, `markdown_requires_raw_ingestion`, `already_tracked`, `gated`).
- [ ] Return what was actually done: `unpublished_count`, ctas `clear-default` switched count, competitors `batch-add` created vs already-present, tracked-sources `update` on a published rule (409, not a silent 200).
- [ ] Publish outcome: a 200 whose `publish_status` is "failed" should be a distinct status (207 or 422) or at least carry a stable `code`; document it either way.
- [ ] Turn user-caused 500s into 4xx with a message: competitor org cap ("Failed to perform competitor operation"), `kb update-file` unsupported type ("Failed to ingest content." vs the readable `invalid` on upload), `validateFile` errors need sentinels.
- [ ] Validate every filter on `GET /org/gaps` (statuses, kinds, surfaces, origins — only `problems` is checked) → 400 naming the field, instead of an empty list.
- [ ] Discovery endpoints: publish the `--models` allow-list (`all_model_ids` on `/org/analytics/filters`), route `ListSupportedModels` for scheduler models, expose `include_uncurated` on tags, add missing glossary entries and take the glossary out of the GEO gate.
- [ ] Partner routes: an org key gets 401 "Authentication required"; return 403 "Partner API key required" so the client can say the right thing.
- [ ] Resolutions: check `produced_content_id` / `authority_content_id` exist and belong to the org.
- [ ] `questions patch`: accept `tag_ids: []` and document it as the only way to clear; reject `null` with a message that says so.
- [ ] Document non-terminal states: history-import `failed` can return to `running`; a `completed` import can have copied nothing (`prompts_count`, `historic_runs_imported`).
- [ ] `GET /org/kb/upload` accepted content types vs what the CLI derives (`application/json`, `application/xml`, `application/octet-stream` are sent and always rejected): either accept them or publish the list so the CLI can pre-check.

---

## Part C — The agent skills (`senso-contextos/skills/*/SKILL.md`)

- [x] Replace every `senso credits --output json --quiet` with `senso credits balance --output json` (senso-search, senso-ingest, senso-content-gen, senso-onboarding).
- [x] senso-search and senso-ingest: knowledge-base documents are read and polled with `senso kb get <kb_node_id>` (and `kb get-content`), never `content get <content_id>` — the API rejects that by design. Rewrite the "Retrieving Full Content" and "Verify Processing" sections.
- [x] Drop `--quiet` from every example; `--output json` already implies it.
- [x] Error tables keyed on exit code and `error.code`, not HTTP status, which the CLI never shows.
- [x] Every `jq` path moves under `.data` once A1 ships.
- [x] Name the two id spaces once, up front: `kb_node_id` for every `kb` command, `content_id` for `--content-ids`, `gaps answer`, `evals content`, `content *` (generated content only).
- [x] senso-ingest: the `existing_content_id` guidance depends on A2 (409 body preserved).
- [x] Add the gap-report loop (`gaps list --status weak` after probes, `--no-gap-signals` on tests) to senso-search.
- [ ] Policy test in the CLI repo that every `senso …` command named in a SKILL.md exists in the command tree (the reference list is `docs/reference/commands.md`).

---

## Part D — Per-command changes in `senso-user-cli`

1071 items. Items that are instances of Part A become one-line edits once the shared helper exists; they are listed so nothing is missed. Priority is the command's, not the item's.

### `senso global` <sub>29 items</sub>

**`senso --help epilog`** · 🟠 medium

- [ ] Add a short 'Exit codes: 0 ok · 2 usage · 3 auth/permission · 4 not found · 5 network/429 · 1 other' line to every leaf help via a shared addHelpText on each command (or Commander's configureHelp).
- [ ] Fix the Output note to describe the envelope and the Commander-error case once those are JSON; state 'json implies --quiet' and 'table truncates at 48 chars / 8 columns'.
- [ ] Add the id-space glossary and a 'Start here' line; mention 403 under exit 3 and 429 under exit 5.

**`senso --output json envelope`** · 🔴 high

- [ ] Wrap every emit in {ok:true, command, data, page?, next?, warnings?}; keep `data` as the raw API payload; compute `page` from the envelope keys findRows already recognizes and include the next-page command; move every !quiet hint into next[]/warnings[] so JSON callers get them.
- [ ] emitConfirmation: data = {action, resource, id} rather than {ok:true, message}.
- [ ] Say 'implies --quiet' in the root help's --output option text.

**`senso --output plain renderer`** · 🔴 high

- [ ] findRows: return [] (not null) when the payload is an envelope whose single array is empty, so emit prints 'No <resource> found.' (resource from an EmitOptions.resource name, default 'results') and a stderr note with the widening command.
- [ ] keyValueLines: render nested objects as indented sub-blocks and arrays of objects as numbered sub-blocks; never JSON.stringify in plain.
- [ ] itemBlocks: number each block, put the primary id first (EmitOptions.idKey), and print 'Showing a–b of N. Next page: <cmd>' on stderr when the envelope has offset/limit/total.

**`senso --output table renderer`** · 🟠 medium

- [ ] Print '(+N columns hidden; use --output plain or json)' on stderr when columns are dropped, and '(cells truncated)' once when any cell was cut.
- [ ] Share the empty-list fix with plain (findRows returns [] for an empty envelope) so table prints 'No <things> found.'.
- [ ] Pagination line on stderr as in plain.
- [ ] Root help --output text: 'table truncates cells to 48 characters and shows at most 8 columns'.

**`senso error reporting (reportError/toCliError)`** · 🔴 high

- [ ] toCliError(err, ctx?) receives the request (method, path) and an optional resource descriptor from the command ({resource: 'KB node', id}) so 404 says 'KB node <id> not found in organization <slug>.' with the group's list command as hint; 401 names the key prefix.
- [ ] 403: parse the middleware message for the permission/product name and say who can fix it; keep the API text.
- [ ] 409/400/422: prefix with what was attempted ('Uploading <file> was refused: …'), pass the body's structured fields under error.data, add code 'validation' with fields[] for 400/422 field errors.
- [ ] 402 hint: `senso credits balance --output json`. 429: read Retry-After into retry_after_seconds and the hint. Network/timeout: name the base URL and the request.
- [ ] reportError: emit {ok:false, error:{code, message, status?, field?, received?, allowed?, hint, request?, data?}}; move allowed values out of hint prose into allowed[]; under json put the SENSO_DEBUG stack in error.debug instead of a raw line.
- [ ] Update the seven skills: drop --quiet, replace `senso credits` with `senso credits balance`, replace HTTP-status tables with exit-code/error.code tables, and state that the JSON error is on stderr with stdout empty.

**`senso senso (no args)`** · 🟠 medium

- [ ] Print one line 'No command given.' + hint on stderr in plain, and the JSON usage error under --output json; keep exit 2. Offer `senso --help` rather than dumping it.
- [ ] Route Commander's 'no subcommand' path through reportError so the format flag is honored.

**`senso senso <group> (no subcommand)`** · 🔴 high

- [ ] One-line error 'senso kb is a command group; name a subcommand.' with allowed[] = its subcommand names and a hint naming the most common one; JSON under --output json; keep exit 2. Keep `senso kb --help` for the full dump.
- [ ] Give every group a 'Typical workflow' block in its help (out of scope here; per-group reviewers).

**`senso unknown command / unknown option (Commander errors)`** · 🔴 high

- [ ] Configure Commander's error output through reportError: in exitOverride, read program.opts().output (already parsed for global flags) and emit the §2.2 error object with code usage, field/received/allowed and a hint naming `senso <cmd> --help`; keep exit 2.
- [ ] Missing argument: name the argument with its id space from the command's own help.

**`senso update check banner`** · 🟢 low

- [ ] Under --output json, when the cache already says a newer version exists, add a warnings[] entry 'A newer @senso-ai/cli (0.18.0) is available: senso update' to the envelope instead of nothing.
- [ ] Await the check with the 3 s timeout only when the cache is stale AND the command is one that already made a network call; otherwise skip so a read-only local command (skills list-available) never stalls or writes config.
- [ ] Document the config-file write and the once-a-day stall in the root help's SENSO_NO_UPDATE_CHECK line.
- [ ] Drop the mini banner from the error path (print it only when a payload follows), or keep it and accept the noise.

### `senso auth` <sub>13 items</sub>

**`senso login`** · 🟢 low

- [ ] Help: say it is interactive only, name the two non-interactive alternatives and their precedence (--api-key > SENSO_API_KEY > stored), the config path, what is stored, that the key is verified with GET /org/me before saving, and that --base-url is stored alongside when given.
- [ ] On success in json mode emit {ok, command:'login', data:{org_id, name, slug, is_free_tier, config_path}} to stdout.
- [ ] Map a 404 from /org/me during login to exit 3 'This API key belongs to no organization.'
- [ ] Welcome text: 'Create a key at https://app.senso.ai → Settings → API keys'.

**`senso logout`** · 🟢 low

- [ ] Report which path was cleared and whether anything was stored: '✓ Removed stored credentials from <path>.' or 'Nothing was stored at <path>.' (exit 0 both).
- [ ] When SENSO_API_KEY is set, warn on stderr: 'SENSO_API_KEY is still set in this shell; commands will keep authenticating with it.'
- [ ] json: {ok, command:'logout', data:{action:'deleted', resource:'credentials', path, had_credentials}, warnings}.
- [ ] Help: name the file, the env-var caveat, Exit codes and an Example.

**`senso whoami`** · 🟠 medium

- [ ] Emit snake_case: data {org_id, name, slug, is_free_tier, api_key_prefix, credential_source ('flag' | 'env' | 'config'), config_path, cached}. Keep the current camelCase keys for one release as a documented breaking change in CHANGELOG (or emit both and deprecate).
- [ ] Fall back to the cache only on network/timeout (exit 5 family); pass 404/5xx through with their exit codes.
- [ ] Add credential_source so an agent can tell which of --api-key / SENSO_API_KEY / config is in effect.
- [ ] Help: Returns block with the enum for credential_source, the cached flag, Exit codes, Examples, and 'for products, websites and limits use senso org get'.
- [ ] JSON envelope {ok, command:'whoami', data, warnings:['Could not reach the API; values are from the last login'] when cached}.

### `senso org` <sub>15 items</sub>

**`senso org`** · group

- [ ] Group description: name the id space (none — the org is the key's org), list the four commands as a workflow (get → update / set-industry / set-runs), and point to industries list for set-industry.

**`senso org get`** · 🟠 medium

- [ ] Plain renderer: render websites/locations/models/publishers as numbered sub-blocks (generic fix in lib/output.ts keyValueLines: nested object → indented block, array of objects → numbered blocks).
- [ ] Help: add Returns with field meanings, say arrays are omitted when empty, say org_website_id/org_location_id are read-only ids that update rejects, add Examples and See also.
- [ ] JSON envelope per §2.2 with next: [org update, org set-industry when industry_id is absent].
- [ ] Fix test fixtures to the DTO shape.

**`senso org set-industry`** · 🟠 medium

- [ ] Validate <industryId> as a UUID → exit 2 before the request, hint senso industries list.
- [ ] 404 message: 'Industry <id> not found in the public catalog.' hint senso industries list.
- [ ] Special-case the 500 read-back message: treat as success-with-warning or at least hint 'The industry was set; run senso org get to confirm.'
- [ ] Help: Arguments section, Returns (industry_id, industry_name), Exit codes, Examples.

**`senso org set-runs`** · 🟢 low

- [ ] Help: explain the semantics (schedule switch, no in-flight cancel), name the field it flips (enable_runs), add Exit codes and Examples.
- [ ] Plain confirmation: '✓ Org-wide runs disabled (enable_runs=false).'

**`senso org update`** · 🔴 high

- [ ] Validate --data before the request: known keys only (name, slug, logo_url, websites, locations) → unknown key exits 2 naming it; website entries must be {url} only → org_website_id exits 2; country_code must be 2 letters; name/slug 1-255. Exit 2 with field/received/allowed.
- [ ] When websites or locations is present, GET /org/me first and diff: emit warnings ['websites replaced the whole list (2 entries removed: https://old.example, https://blog.example)'] in the JSON envelope and on stderr in plain mode.
- [ ] Map API 400 validation errors to exit 2 code 'validation' with the field list passed through, prefixed 'Updating organization: '.
- [ ] 409: 'Conflict updating organization: Organization with that slug already exists' with hint senso org get to see the current slug.

### `senso users` <sub>32 items</sub>

**`senso users`** · group

- [ ] Group description: name the id spaces (user_id vs org_user_id vs role_id), point to members list for email lookup and roles list for role ids, and give the three-way rule: invite (new person), invite-existing (has a Senso account), add (you already hold their user_id).

**`senso users add`** · 🟠 medium

- [ ] Validate --data: user_id and role_id present and UUIDs, is_current boolean, no other keys → exit 2 naming the field.
- [ ] 400 'Invalid role ID for this organization' → 'Adding user: Invalid role ID for this organization (role_id <id>)' with hint senso roles list; keep exit 1.
- [ ] 404 → 'User <user_id> not found.' hint senso members list --search <email>.
- [ ] 409 → 'User <user_id> is already a member of this organization.' hint senso users update <user_id> --data '{"role_id": …}'.
- [ ] Help: Arguments/Options per §2.1 naming id sources, Returns, Exit codes, Examples.

**`senso users get`** · 🟠 medium

- [ ] Validate <userId> as UUID → exit 2, hint members list.
- [ ] Pass 404 message through: 'User <id> not found.' vs 'User <id> is not a member of this organization.' with hints.
- [ ] Help: Arguments naming user_id and its source, Returns, Exit codes, Examples, See also members list for email.

**`senso users invite`** · 🟠 medium

- [ ] Validate --email (contains @), --role-id UUID, names non-empty → exit 2.
- [ ] Map API 400 field errors to exit 2 code validation with field names.
- [ ] 400 'Invalid role ID' → 'Inviting <email>: Invalid role ID for this organization (role_id …)' hint senso roles list.
- [ ] 409 → 'User <email> is already a member of this organization.' hint senso users update.
- [ ] Help: correct the invite vs invite-existing rule after confirming with the API team; add Returns/Exit codes/Examples.

**`senso users invite-existing`** · 🟠 medium

- [ ] 404 → 'No Senso user with email <email>.' hint senso users invite --email <email> --given-name … --family-name … --role-id ….
- [ ] Validate --email and --role-id → exit 2; map API field errors to exit 2.
- [ ] Help per §2.1.

**`senso users list`** · 🟠 medium

- [ ] Help: say exactly which fields come back, that emails/names are in senso members list, that role_id resolves via senso roles list, that the API page size defaults to 10 with no total.
- [ ] Validate --limit (integer >= 1) and --offset (integer >= 0) → exit 2.
- [ ] Plain: numbered blocks with user_id first; stderr 'Showing 1–10 (page size 10). Next page: senso users list --offset 10' whenever returned == limit; empty → 'No memberships found.'
- [ ] JSON envelope: page {offset, limit, returned, has_more: unknown|bool, next}.

**`senso users remove`** · 🟢 low

- [ ] Validate UUID → exit 2.
- [ ] JSON success: data {action: 'removed', resource: 'org_user', user_id}.
- [ ] 404 pass-through with id; help warn about last-admin.

**`senso users set-current`** · 🟢 low

- [ ] emit the OrgUserResponse payload instead of a confirmation.
- [ ] Validate UUID → exit 2; pass 404 messages through.
- [ ] Help: define 'current org', note equivalence to users update --data '{"role_id": …, "is_current": true}' without needing role_id.

**`senso users update`** · 🟠 medium

- [ ] Validate <userId> UUID and --data {role_id: uuid required, is_current?: bool, nothing else} → exit 2.
- [ ] 400 'Invalid role ID' → prefix 'Updating user <id>:', include role_id sent, hint senso roles list.
- [ ] 404s: pass the API message through with the id.
- [ ] Confirmation: '✓ Updated user <id>: role_id → <role_id>.'
- [ ] Help per §2.1.

### `senso api-keys` <sub>26 items</sub>

**`senso api-keys`** · group

- [ ] Remove create, update, delete, revoke, kb-permissions-set, kb-permissions-delete (or hide them and make them exit 3 immediately with 'API keys can only be managed in the dashboard at https://app.senso.ai/settings/api-keys') — do not make a request that is guaranteed to 403. Update docs/reference/excluded-endpoints.md from 'Unresolved' to 'JWT-only, excluded'.
- [ ] Group description: read-only over the API; explain id vs secret and scoped/grants; workflow list → get → kb-permissions-get.

**`senso api-keys create`** · 🔴 high

- [ ] Remove the command (preferred), or keep a stub that exits 3 before any request with: 'API keys can only be created by a signed-in user in the Senso dashboard (Settings → API keys). The API refuses API-key auth for this action.' and a JSON error {code: forbidden, hint: 'https://app.senso.ai/settings/api-keys'}.
- [ ] Update excluded-endpoints.md and the README command table; add a CHANGELOG entry.
- [ ] If ever re-enabled (JWT support in the CLI): stderr warning 'Store this key now; it is never shown again.' and next: [senso api-keys kb-permissions-set <id>].

**`senso api-keys delete`** · 🔴 high

- [ ] Remove the command, or stub it to exit 3 before any request: 'API keys can only be deleted by a signed-in user in the Senso dashboard.'
- [ ] Update docs/reference/excluded-endpoints.md and README.

**`senso api-keys get`** · 🟠 medium

- [ ] Validate <keyId> UUID → exit 2 with 'The argument is the key's id from senso api-keys list, not the secret.'
- [ ] 404 → 'API key <id> not found in this organization.' hint senso api-keys list.
- [ ] Help per §2.1 with Returns explaining scoped/revoked_at/expires_at and a next: kb-permissions-get when scoped.

**`senso api-keys kb-permissions-delete`** · 🔴 high

- [ ] Remove the command, or stub it to exit 3 before any request: 'API keys can only be unscoped by a signed-in user in the Senso dashboard.'
- [ ] Update docs/reference/excluded-endpoints.md and README.

**`senso api-keys kb-permissions-get`** · 🟠 medium

- [ ] Validate UUID → exit 2.
- [ ] Empty result: stdout 'No KB grants: key <id> has full organization access (or the id is unknown — confirm with senso api-keys get <id>).'
- [ ] Help: name node_id as kb_node_id, list roles and their actions, explain [].
- [ ] Optionally call GET /org/api-keys/{id} first to turn 'unknown id' into a real exit 4.

**`senso api-keys kb-permissions-set`** · 🔴 high

- [ ] Remove the command, or stub it to exit 3 before any request: 'API keys can only be scoped by a signed-in user in the Senso dashboard.'
- [ ] Update docs/reference/excluded-endpoints.md and README.

**`senso api-keys list`** · 🟠 medium

- [ ] Table columns: id, name, scoped, revoked_at, expires_at, last_used_at.
- [ ] Plain: numbered blocks with id first, then stderr 'Showing 1–10 of 23. Next page: senso api-keys list --offset 10'.
- [ ] Validate --limit/--offset → exit 2. JSON envelope with page {offset, limit, returned, total, has_more, next}.
- [ ] Help: explain scoped, revoked_at, expires_at, omitted-when-null; name id as the argument for get/kb-permissions-get.

**`senso api-keys revoke`** · 🔴 high

- [ ] Remove the command, or stub it to exit 3 before any request: 'API keys can only be revoked by a signed-in user in the Senso dashboard.'
- [ ] Update docs/reference/excluded-endpoints.md and README.

**`senso api-keys update`** · 🔴 high

- [ ] Remove the command, or stub it to exit 3 before any request: 'API keys can only be renamed or re-dated by a signed-in user in the Senso dashboard.'
- [ ] Update docs/reference/excluded-endpoints.md and README.

### `senso search` <sub>26 items</sub>

**`senso search`** · group

- [ ] Group help: state the id spaces (kb_node_id vs content_id), the four variants in one table (answer? chunks? deduplicated?), the ordered workflow, and that all five commands cost credits and record a turn.
- [ ] Say explicitly: read a source with `senso kb get <kb_node_id>`; `senso content get` is for generated content and rejects KB content.
- [ ] Fix the senso-search skill (SKILL.md lines 45-49, 106-117): add kb_node_id to the documented result fields, replace `senso content get <content_id>` with `senso kb get <kb_node_id>`, and change the 402 row to 403 with the actual message.

**`senso search <query>`** · 🔴 high

- [ ] Give the leaf its own help (the block below): what it returns, the two id spaces, Returns/Exit codes/Examples.
- [ ] Plain, no hits: print 'No results for "<query>".' on stdout; on stderr 'This search was filed as a gap. Review: senso gaps list --origin api_unanswered_question --status open' (or 'Not filed as a gap (--no-gap-signals).'). Never emit a payload made only of blank lines.
- [ ] Plain, hits: show score and chunk_index on each hit ('score 0.91 chunk 2') and label the ids; end with 'Next: senso kb get <kb_node_id>' on stderr.
- [ ] Validate --max-results as an integer in 1-20 and exit 2 with field/received/allowed; validate each --content-ids value as a UUID; exit 2 when --require-scoped-ids is given without --content-ids. Reject a query over 2000 characters before the request.
- [ ] Map the three 403 credit messages from the search endpoints to code insufficient_credits, exit 1, hint 'Check credits: senso credits' (match on the message until the API returns 402).
- [ ] JSON: wrap in the standard envelope {ok, command:"search", data, next, warnings}; when results is empty add warnings ['No results; filed as an API search gap'] and next [{why:'Review the gap', command:'senso gaps list --origin api_unanswered_question --status open'}].
- [ ] Fix the senso-search skill per the wording in issues.

**`senso search content`** · 🔴 high

- [ ] Help: Returns block naming `contents[]` and `total`; say --max-results counts documents; Examples with jq on .data.contents.
- [ ] Plain: numbered rows 'title kb_node_id content_id'; empty → 'No documents matched "<query>".'
- [ ] Validate flags → exit 2; map 403 credit messages → insufficient_credits.
- [ ] JSON envelope with next: [kb get <kb_node_id>, search --content-ids ...].
- [ ] Fix SKILL.md line 77 and lines 106-117 per the wording in issues.

**`senso search context`** · 🟠 medium

- [ ] Plain: numbered blocks with score and chunk_index on the header line, the passage, then both ids labeled; 'No results for "<query>".' when empty.
- [ ] Validate --max-results (1-20), --content-ids UUIDs, --require-scoped-ids needs --content-ids → exit 2.
- [ ] Map the 403 credit messages to insufficient_credits/exit 1.
- [ ] JSON envelope {ok, command:"search context", data, next:[kb get <kb_node_id>]}.
- [ ] Help: Returns/Exit codes/Examples; say it is billed and recorded but never filed as a gap.

**`senso search full`** · 🔴 high

- [ ] Register `full` with the same renderer as the default search (share the plain block), or make it a true alias so the two cannot drift.
- [ ] Everything listed for `search`: no-results line plus gap notice, validation → exit 2, 403 credit mapping, JSON envelope, help with Returns/Exit codes/Examples.

**`senso search stream`** · 🟠 medium

- [ ] Label the ids on each source ('kb_node_id …' and 'content_id …'), show score and chunk index.
- [ ] No sources: 'No results for "<query>".' plus the gap notice on stderr.
- [ ] json: {ok, command:"search stream", data:{query, search_type, answer, results, total_results, max_results}, next}.
- [ ] Validation → exit 2; 403 credit mapping; help with Returns/Exit codes/Examples and a note that json is emitted once at the end.

### `senso ingest` <sub>17 items</sub>

**`senso ingest`** · group

- [ ] Group help: the workflow (upload → note kb_node_id → poll senso kb get until content.processing_status is complete → search), the supported types with the .md and .json/.xml caveats, the 10-file limit, the 100 MB limit, and that kb upload is the same command.
- [ ] Fix senso-ingest SKILL.md: lines 41 (formats), 55 (add kb_node_id), 129-141 and 163 (poll with senso kb get <kb_node_id>), 184-191 (409 is not how duplicates surface; 422 means every file in the batch was skipped).

**`senso ingest reprocess`** · 🟠 medium

- [ ] Rename the argument to <kb_node_id>; validate it as a UUID → exit 2.
- [ ] Pre-flight the file type against the API's allowed list and reject .md/.markdown with exit 2 (hint: senso kb update-raw <kb_node_id> for editable documents).
- [ ] Plain: print the result block on stdout (kb_node_id, content_id, ingestion_run_id, status); stderr '✓ Replaced file on KB node <id>.' then 'Next: senso kb get <id>' (poll content.processing_status).
- [ ] 404: 'KB node <id> not found or not shared with this API key.' when the API says Node not found; 'KB node <id> is a folder, not a document.' when it says Content not found. 409: 'This exact file is already ingested for KB node <id>; nothing to do.' exit 1, no retry hint.
- [ ] Strip upload_url/expires_in from output; JSON envelope with next.

**`senso ingest upload`** · 🔴 high

- [ ] Plain: after the S3 uploads, print each result on stdout as a numbered block with filename, status, kb_node_id, content_id (and error/existing_content_id when skipped); keep progress on stderr; end with 'Next: senso kb get <kb_node_id> (poll until content.processing_status is complete)' on stderr.
- [ ] Validate --folder-id as a UUID → exit 2 with field/received.
- [ ] Before the request, reject .md/.markdown with exit 2 and the hint 'senso kb create-raw --data …', and reject extensions outside the API's allowed list (drop .json/.xml from the MIME table or map them to a pre-flight error).
- [ ] Add a case for markdown_requires_raw_ingestion in uploadStatusToReason.
- [ ] When stdin is not a TTY and --folder-id is absent, say on stderr 'Uploading to the root folder (no --folder-id).'
- [ ] 422 whole-batch: JSON error {code:'validation', status:422, message:'No files were accepted (3 skipped).', data or details: results[]}; plain lists each file with status and reason (already does).
- [ ] 404: 'Folder <id> not found or not shared with this API key.' hint 'senso kb my-files'. 403: pass the API text through and say the folder's owner can grant the role.
- [ ] Strip upload_url/expires_in from json and table output (or move them under a debug flag); they are consumed by the CLI itself.
- [ ] JSON envelope: {ok, command:'ingest upload', data: <API response>, warnings: one per skipped file, next: [kb get for each accepted kb_node_id]}.
- [ ] Fix senso-ingest SKILL.md per the wording in issues.

### `senso website-import` <sub>11 items</sub>

**`senso website-import`** · group

- [ ] Group help: the gate (GEO product + update:brand_kit), the source of the URL, the two commands with the polling model (current vs latest_completed), the status and error_code enums, and the workflow start → status → kb children of the 'Website' folder.

**`senso website-import start`** · 🟠 medium

- [ ] 422: 'Cannot import: no website is on file for this organization (API: No website on file for this organization).' code validation, hint 'senso org update --data '{"websites":["https://…"]}'' (or the app setting), keep error_code in the JSON error.
- [ ] 503: code error (not server_error), message 'Website import is not enabled in this environment.' with no retry hint.
- [ ] 403 product: 'Website import needs the GEO product, which this organization does not have.' hint 'Contact Senso to enable GEO.' 403 permission: 'This API key lacks update:brand_kit.' hint 'An org admin can grant it in API keys.'
- [ ] 409: include current.run_id and started_at; hint 'senso website-import status'.
- [ ] --no-wait: stderr 'Next: senso website-import status' and JSON next.
- [ ] Help: Returns with both enums, Exit codes, Examples, the 180 s/2 s polling note.
- [ ] JSON envelope {ok, command:'website-import start', data: run, next: [kb find --query Website, brand-kit get when generated]}.

**`senso website-import status`** · 🟢 low

- [ ] Plain: two labeled sections 'In flight: none' / 'In flight: <run>' and 'Last finished: <run>'; never-imported → 'No website imports yet.' on stdout.
- [ ] Help: polling rule, enums, gate, Examples with jq on .data.current and .data.latest_completed.status.
- [ ] 403/503 messages as for start. JSON envelope with next: [website-import start when nothing is in flight].

### `senso content` <sub>102 items</sub>

**`senso content`** · group

- [ ] Rewrite the group description to say these commands operate on GENERATED content (source_type=content_engine) and that knowledge-base documents are `senso kb ...`.
- [ ] Name the two id spaces explicitly: content_id (from `content verification`, `generated-content list`, `engine draft`/`engine publish`) and version_id (from `content versions`, used by reject/restore).
- [ ] Add an ordered workflow list to the group help.
- [ ] Either remove `content list` or rename it so it is not mistaken for a listing of the ids the other subcommands take.

**`senso content citation-details`** · 🔴 high

- [ ] Validate <id> as a UUID; validate --start-date / --end-date as YYYY-MM-DD and reject start > end; validate every --models entry against the server allow-list - all at exit 2 before the request.
- [ ] List the accepted --models values in the flag help.
- [ ] Help: correct the id source to `senso content verification --status published`.
- [ ] Plain output: key/value for the header, a numbered block per destination, and a compact date/citations table for `trend`.
- [ ] State the default window (all-time when the flags are omitted) and that a --locations typo yields an empty result rather than an error.
- [ ] 404: "Content <id> not found in organization <slug>." with hint `senso content verification --status published`.

**`senso content citation-prompts`** · 🟠 medium

- [ ] Validate <id> as a UUID, the two dates as YYYY-MM-DD with start <= end, and each --models entry against the allow-list -> exit 2.
- [ ] Add mention_rate_lift and avg_sov_lift to the table columns, since they are the command's stated purpose.
- [ ] Supply a plain renderer that prints content_id, date_range, models and external_urls as a header block before the prompt rows.
- [ ] Help: correct the id source; document every returned field including that the two *_lift fields are null when no baseline exists.
- [ ] Warn on stderr when --destinations contains a slug absent from the response (the API ignores unknown slugs silently).
- [ ] Empty result: say why - `tracked_url_count` 0 on the item, or no runs in the window - and suggest `senso content citation-details <id>`.

**`senso content delete`** · 🔴 high

- [ ] Validate <id> as a UUID -> exit 2.
- [ ] Help: say generated content only, name `senso kb delete` for KB nodes, document the 409 retry case and the non-atomic external delete.
- [ ] Add a --yes flag and, when stdin is a TTY and --yes is absent, require confirmation. Agents pass --yes.
- [ ] 404: "Content <id> not found in organization <slug>." hint `senso content verification`.
- [ ] 409: pass the API message through, prefixed "Could not delete content <id>: ...", with hint `senso content get <id>` to check processing_status.
- [ ] Emit a real JSON payload: {"action":"deleted","resource":"content","id":"..."}.

**`senso content get`** · 🔴 high

- [ ] Help: state in the first paragraph that this returns GENERATED content only, and that a knowledge-base content_id is rejected with 400 - link to `senso kb get` / `senso kb content`.
- [ ] Correct the summary: it returns the current version's title/summary/text and editorial_status, NOT a versions list and NOT publish records. Point at `senso content versions` and `senso content verification` for those.
- [ ] Validate <id> as a UUID -> exit 2 before the request.
- [ ] Special-case the 400 "Knowledge base content..." body: message "Content <id> is a knowledge base document; `senso content get` only serves generated content." with hint "senso kb find --q <name>", keeping exit 1.
- [ ] 404 message: "Content <id> not found in organization <slug>." with hint `senso content verification`.
- [ ] 403: distinguish the product guard ("Your organization does not have the GEO product") from the permission guard ("This key lacks read:content").
- [ ] Plain output: render tags / org_tags / uploaded_by as indented sub-blocks, not inline JSON.
- [ ] Add Returns / Exit codes / Examples / See also sections and document the editorial_status and processing_status value sets.
- [ ] Fix `content unpublish`'s help, which points here for publish_record_ids.

**`senso content list`** · 🔴 high

- [ ] Fix the table mapping: `status: r.content?.processing_status`.
- [ ] Validate --limit as an integer in 1..50 and --offset as an integer >= 0 with parseIntFlag, exiting 2 before the request instead of letting the API clamp silently.
- [ ] Help: state that the ids are kb_node_id values, that they are NOT accepted by `content get`, and point at `senso kb get <kb_node_id>`.
- [ ] Show `Showing 1-10 of 42. Next page: senso content list --offset 10` on stderr, from the `total` the API already returns.
- [ ] Empty result: `No content found.` on stdout plus a stderr line naming `senso kb my-files` and `senso kb find`.
- [ ] Mark the command deprecated in its description in favor of `senso kb my-files`.

**`senso content owners`** · 🟢 low

- [ ] Validate <id> as a UUID -> exit 2.
- [ ] Empty result: `No owners assigned.` on stdout plus a stderr hint `senso content set-owners <id> --user-ids <user_id>` and `senso members list` for the ids.
- [ ] Help: name `senso members list` as the source of user_id values, say owners are advisory metadata surfaced on `content verification`, and add Returns / Exit codes / Examples.
- [ ] 404: "Content <id> not found in organization <slug>."

**`senso content provenance`** · 🔴 high

- [ ] Fix the cross-reference: replace "'publish-records list' is where those URLs come from" with `senso content verification --status published`.
- [ ] Validate --url with `new URL(...)` and require an http/https scheme -> exit 2 with the reason before the request.
- [ ] 404: "No live publish record matches <url> in organization <slug>." with the hint naming the verification command that lists real URLs.
- [ ] Plain output: one block per stage with its status, applicability, what_can_be_proven and missing_evidence as bullet lines; keep --output json as the raw payload.
- [ ] Document overall_status / status / applicability value sets and the five stages in the help.

**`senso content record-edits`** · 🔴 high

- [ ] Validate each event's event_type against the 8 allowed values and edit_source against manual|ai|system, and require client_event_id to be a UUID when present - all at exit 2, before anything is written.
- [ ] Validate <id> as a UUID -> exit 2.
- [ ] List both closed sets in the --data help text.
- [ ] Confirmation: `Recorded N new event(s), skipped M duplicate(s) for content <id>.` from the response.
- [ ] Help: state explicitly that a mid-batch failure leaves earlier events written and the API does not report how many, so every event should carry a client_event_id and the whole batch should be retried.
- [ ] 404: name generation_run_id, not the content id, as the thing that was not found.

**`senso content reject`** · 🔴 high

- [ ] Validate <versionId> as a UUID -> exit 2.
- [ ] Help: name `senso content versions <content_id>` and `senso content verification` (items[].version_id) as the sources, and say plainly that a content_id will 404.
- [ ] 404: "Content version <id> not found in organization <slug>. (This takes a version_id, not a content_id.)" with hint `senso content versions <content_id>`.
- [ ] Emit {"action":"rejected","resource":"content_version","id":"...","reason":"..."} as the JSON payload.
- [ ] Add a stderr next step: `senso content restore <version_id>` to undo, and `senso content verification --status rejected` to review.
- [ ] Recommend --reason in the help (it is the only record of why) rather than presenting it as an afterthought.

**`senso content remove-owner`** · 🟠 medium

- [ ] Validate both arguments as UUIDs -> exit 2, naming which argument failed.
- [ ] Help: label the arguments explicitly - <id> is a content_id, <userId> is a user_id from `senso content owners <id>` - and say the call is idempotent.
- [ ] 404: "Content <id> not found in organization <slug>. (The first argument is the content_id, the second the user_id.)"
- [ ] Emit {"action":"removed","resource":"content_owner","content_id":"...","user_id":"..."}.
- [ ] Add a next-step hint: `senso content owners <id>`.

**`senso content restore`** · 🟠 medium

- [ ] Validate <versionId> as a UUID -> exit 2.
- [ ] Help: say the endpoint sets the version to draft regardless of its current status, and warn that restoring a published version does NOT unpublish it - use `senso content unpublish` for that.
- [ ] Name the sources of a version_id, and say a content_id will 404.
- [ ] 404: "Content version <id> not found in organization <slug>. (This takes a version_id, not a content_id.)"
- [ ] Emit {"action":"restored","resource":"content_version","id":"...","editorial_status":"draft"}.
- [ ] Add next-step hints: `senso content verification --status draft` and `senso engine publish`.

**`senso content set-owners`** · 🟠 medium

- [ ] Capture and emit the response: `const data = await apiRequest(...); emit(ctx, data)` so the resulting owner set is on stdout.
- [ ] Validate <id> and every --user-ids value as UUIDs -> exit 2 naming the offending value.
- [ ] Fetch the current owners first (or diff against the response) and emit a warning naming every owner removed by the replacement.
- [ ] Add a --clear flag (or accept `--user-ids none`) so the list can be emptied, since the API supports it.
- [ ] Help: name `senso members list` as the source of user_id values, say plainly that this replaces rather than adds, and point at `senso content remove-owner` for a single removal.
- [ ] 400 "User is not a member": prefix with the attempted operation and, where possible, name the id.

**`senso content unpublish`** · 🔴 high

- [ ] Validate every --publish-record-ids value as a UUID -> exit 2 before the request. This alone closes the unpublish-everything footgun.
- [ ] Validate <id> as a UUID -> exit 2.
- [ ] Build the confirmation from the response: `Unpublished N of M record(s) from content <id>.` using data.unpublished_count, and when failures.length > 0 exit 1 and print each failure, or at minimum emit them as warnings.
- [ ] Help: correct the publish_record_id source to `senso content verification --status published --output json | jq -r '.data.items[].destinations[].publish_record_id'`.
- [ ] Help: state the two response shapes explicitly, and normalize them in the JSON envelope so `data` always carries {unpublished_count, failures}.
- [ ] Document the 409 cases and translate 400 "Content type does not support unpublish" into "Content <id> is not generated content (only content created by `senso engine publish` can be unpublished)."
- [ ] Add a --yes confirmation for the no-flag form, which takes the page down everywhere.

**`senso content verification`** · 🔴 high

- [ ] Pass an explicit table/plain rendering so the items array is not stringified: `emit(ctx, data, { table: { rows: data.items, columns: ["content_id","title","editorial_status","published_at","citation_rate"] } })` plus numbered plain blocks. (Alternatively add draft_count/rejected_count/pending_published_draft_count to ENVELOPE_KEYS in lib/output.ts - but they are counts, not pagination, so the per-command override is the right fix.)
- [ ] Help: say plainly that `review` is an alias for `draft` server-side, or drop `review` from the accepted set.
- [ ] Add `unpublished` to VERIFICATION_SUBSTATUSES and validate the --status/--substatus pairing locally (pending_draft requires published; unpublished requires draft) -> exit 2.
- [ ] Expose --tag-ids and --sort with their documented value sets.
- [ ] Validate --limit (1..100) and --offset (>=0) with parseIntFlag -> exit 2.
- [ ] Document the returned fields, especially destinations[].publish_record_id as the input to `content unpublish --publish-record-ids` and `publish-records retry`.
- [ ] Show `Showing 1-10 of 42. Next page: senso content verification --offset 10` on stderr, and an explicit `No content found.` plus a widening hint on an empty page.

**`senso content verification-counts`** · 🟠 medium

- [ ] Render the counts as key/value and published_domain_summaries as a numbered sub-block (or a table when --output table), not as inline JSON.
- [ ] Help: document every returned field, including that citation_rate is null (not 0) when there were no qualifying runs, and what citation_window_days / citation_missing_days_excluded mean.
- [ ] Add next-step hints on stderr: `senso content verification --status draft` and `senso content verification-velocity`.
- [ ] Document the GEO 403.

**`senso content verification-velocity`** · 🟠 medium

- [ ] Render `destinations` as a table (columns publisher_name, total_live_pages, pages_with_citations, avg_days_to_first_citation) and as numbered plain sub-blocks.
- [ ] Help: document each field, state that nulls mean "nothing measured yet", and explain the org-vs-destination grain difference.
- [ ] Say explicitly that the figures are all-time with no date filter.
- [ ] Add next-step hints: `senso content verification --status published` and `senso content citation-details <content_id>`.

**`senso content versions`** · 🔴 high

- [ ] Render the list properly: `emit(ctx, data, { table: { rows: data.versions, columns: ["version_id","version_num","editorial_status","is_current","updated_at"] } })` plus numbered plain blocks with the content_id as a header line.
- [ ] Validate <id> as a UUID -> exit 2.
- [ ] Help: state that version_id is the input to `content reject` and `content restore`, list the editorial_status values, and say the response is unpaginated.
- [ ] 404: "Content <id> not found in organization <slug>." with hint `senso content verification`.
- [ ] Add a next-step hint naming the current version's id.

### `senso content tags` <sub>23 items</sub>

**`senso content tags`** · group

- [ ] Add to the group help: these four commands accept BOTH knowledge-base and generated content_id values, unlike the rest of `senso content`, and they need no GEO product.
- [ ] Name the id sources: content_id from `senso kb my-files` (content.id) or `senso content verification` (items[].content_id); tag ids from `senso tags list`.
- [ ] Call out the --names/--ids (set) vs --name/--id (add/remove) split explicitly.
- [ ] Warn in the group help that `set` replaces the whole collection and that calling it with no flags empties it.

**`senso content tags add`** · 🟠 medium

- [ ] Validate <id> and --id as UUIDs -> exit 2.
- [ ] Reject --name and --id together at exit 2 rather than silently preferring --id.
- [ ] Confirmation: `Attached tag <name-or-id> to content <id>.`
- [ ] Follow the 204 with a `GET /org/content/{id}/tags` and emit the resulting collection, so a JSON caller learns the tag_id of a newly created tag.
- [ ] Help: say the call is idempotent, that unknown names are created, and where tag ids come from (`senso tags list`).

**`senso content tags list`** · 🟢 low

- [ ] Validate <id> as a UUID -> exit 2.
- [ ] Help: say KB and generated content ids are both accepted, name the sources of each, and document `curated`.
- [ ] Empty result: `No tags attached.` plus a stderr hint `senso content tags add <id> --name <name>`.
- [ ] 404: "Content <id> not found in organization <slug>."

**`senso content tags remove`** · 🟠 medium

- [ ] Validate <id> and --id as UUIDs, and reject a blank --name -> exit 2.
- [ ] Reject --name and --id together at exit 2 instead of preferring --id.
- [ ] Follow the 204 with a `GET /org/content/{id}/tags` so the resulting collection is on stdout and a caller can see whether anything changed; emit a warning when the named tag was not attached.
- [ ] Confirmation: `Detached tag <name-or-id> from content <id>.`
- [ ] Help: say explicitly that detaching an unknown or unattached tag is a silent success.

**`senso content tags set`** · 🔴 high

- [ ] Require at least one of --names / --ids, and add an explicit --clear flag for the empty case -> exit 2 when neither is present. This is the single most important fix in the tags subgroup.
- [ ] Validate each --ids value as a UUID -> exit 2 naming the offending value.
- [ ] Fetch the current tags first and emit a warning naming every tag removed by the replacement, and every name that was newly created.
- [ ] Help: say plainly that this REPLACES, that --clear (not a bare invocation) is how to empty the list, and that unknown names are created.
- [ ] 404 and the tag 400s: prefix with the attempted operation and name the flag and the value.

### `senso ctas` <sub>21 items</sub>

**`senso ctas`** · group

- [ ] Add id spaces, permissions, and an ordered workflow (upload-url -> PUT -> create -> set-default -> set-for-content) to the group description.

**`senso ctas clear-default`** · 🟢 low

- [ ] Help in §2.1 shape; JSON data {action: cleared, resource: default_cta}.

**`senso ctas create`** · 🟠 medium

- [ ] Validate --data before the request: required title/button_label/target_url non-blank, target_url/image_url absolute URLs, lengths (255/120/2048/2000/120), is_default bool, image_position {x,y} numbers 0-1, unknown keys named -> exit 2.
- [ ] Help: full key table with limits, Returns (cta_id, resolved_agent_text, live_update_*), Exit codes, Examples; JSON next: set-default / set-for-content.
- [ ] Pass validation 400s through as code validation with field.

**`senso ctas delete`** · 🟢 low

- [ ] Validate <ctaId> UUID -> exit 2; add hint `senso ctas clear-default` to the 409; name the id in the 404.
- [ ] Help: restructure into §2.1 (Returns, Exit codes with 409, Examples).
- [ ] JSON: data {action: deleted, resource: cta_template, id} (keep the API body under data.raw if needed).

**`senso ctas for-content`** · 🟢 low

- [ ] Validate <contentId> UUID -> exit 2; 404 'Content <id> not found in this organization (only content-engine content has a CTA selection)'.
- [ ] Plain: template as an indented sub-block; help in §2.1 shape with the implicit-default note.

**`senso ctas list`** · 🟢 low

- [ ] Help: add Returns with resolved_agent_text and image_position, Exit codes, Examples; empty: 'No CTA templates found.' + hint `senso ctas create`.

**`senso ctas set-default`** · 🟢 low

- [ ] Validate <ctaId> UUID -> exit 2; 404 names the id; help in §2.1 shape.

**`senso ctas set-for-content`** · 🟠 medium

- [ ] Validate <contentId> and --cta-id as UUIDs -> exit 2.
- [ ] Distinguish the two 404s by the API message: 'Content <id> not found' vs 'CTA template <id> not found' with the matching list command as hint.
- [ ] Help: document the default-collapse behavior, Returns, Exit codes, Examples; JSON warnings when the stored selection differs from the requested one.

**`senso ctas update`** · 🟠 medium

- [ ] Validate <ctaId> UUID and --data as for create -> exit 2.
- [ ] Help: restructure into §2.1 with the key table, Returns (live_update_count), Exit codes, Examples.
- [ ] 404: 'CTA template <id> not found in this organization.' + hint `senso ctas list`.

**`senso ctas upload-url`** · 🟢 low

- [ ] Check the filename extension against --content-type client-side -> exit 2; check --filename length ≤ 255.
- [ ] Help: add a curl example, the expiry note, Returns, Exit codes; plain: upload_headers as indented lines; JSON next: the curl command with the real URL and headers filled in.
- [ ] Consider `--file <path>` to derive filename/content-type/size and perform the PUT, removing the manual step.

### `senso evals` <sub>33 items</sub>

**`senso evals`** · group

- [ ] Add a Lifecycle block: queued -> running -> completed (scored) | gated (pre-check found nothing to judge; no model spend, no score) | failed (error_code / error_message); canceled is reserved.
- [ ] Add an ordered Workflow list and an Id spaces block (eval_run_id vs content_id vs kb_node_id).
- [ ] Say that `--wait` is client-side polling with a 180-second budget, and that a timeout is exit 5 with the run still running.
- [ ] Mention that judging one text for both evaluators is two runs, deliberately (routes comment at router.go:1726) — a caller that expects one call to answer both will otherwise be surprised.

**`senso evals claims`** · 🟠 medium

- [ ] Help: add Returns explaining verdict per evaluator, passed's null, both bucket vocabularies, about_brand/verifiable, confidence, grounding_failed and evidence_was_cited; add Exit codes, Examples and See also.
- [ ] Add the paging line and next-page command on stderr, and a `page` block in the JSON envelope.
- [ ] Print 'No claims found.' on stdout when empty; when --run-id was given, add the stderr hint 'Check the run exists and finished: senso evals get <runId>'.
- [ ] Add a next step pointing at `senso gaps list --problem no_source` for unsupported claims.

**`senso evals content`** · 🔴 high

- [ ] Validate <contentId> as a UUID before the request — exit 2, with the hint `gaps answer` already uses: 'Content ids are the `id` from `senso kb create-raw`, or `content_id` from `senso kb get`.'
- [ ] Help: add an Arguments block naming the content_id space and saying explicitly that a kb_node_id will 404; add Returns, Exit codes, Examples, See also.
- [ ] 404: 'Content <id> not found in this organization.' with hint 'If you have a kb_node_id, get its content_id first: senso kb get <kb_node_id>.'
- [ ] Pass the 422 text through with a prefix and a hint: 'This document stores a file or a crawled page rather than text of its own. Judge text directly with `senso evals text --text-file <path>`.'
- [ ] Same 503 and gated-run fixes as `evals text`.

**`senso evals evaluators`** · 🟢 low

- [ ] Help: add Returns explaining key, evaluation_unit values, scope, latest_version, subjects (and that it predicts the 422) and metrics; add Exit codes and Examples.
- [ ] Add a stderr next step: 'Judge text with the newest version: senso evals text --text "..." --evaluator kb_accuracy --evaluator-version <latest_version>'.
- [ ] Print 'No evaluators found.' on stdout for an empty list, with the reason on stderr.
- [ ] Note in --help that --evaluator is validated against a list compiled into this CLI, so an evaluator newer than the CLI must be passed to a newer CLI.

**`senso evals get`** · 🔴 high

- [ ] Validate <runId> as a UUID before the request — exit 2 with the same hint `evals claims --run-id` already uses ('Run ids come from `senso evals runs` or the output of a trigger.').
- [ ] 404: 'Eval run <id> not found in this organization.' with hint 'senso evals runs lists recent runs.'
- [ ] Give the command a hand-written plain renderer: header (run, evaluator, status, score, band, counts, cost), then one block per claim (claim_text, verdict, passed, confidence, quote, reasoning, suggested_fix), then the searches. Today's inline-JSON rendering is the worst plain output in the two groups reviewed.
- [ ] Help: add Arguments, Returns (every enum above), Exit codes, Examples, See also.
- [ ] Add stderr next steps: `senso evals claims --run-id <id>` for the flat view, and for a failed run the error_code with what it means.

**`senso evals runs`** · 🟠 medium

- [ ] Add the paging line on stderr — 'Showing 1–25 of 312.' plus 'Next page: add --offset 25' — matching `gaps list`, and a `page` block in the JSON envelope.
- [ ] Print 'No eval runs found.' on stdout when items is empty, with the likely reason on stderr (filters, or nothing has been judged yet: 'senso evals text --text "..."').
- [ ] Help: list the known --subject-type values (content, content_generation_run_item, builder_workspace_version, question_run, search_turn, inline) as documentation while keeping the flag unvalidated, and say that an unknown value yields an empty page rather than an error.
- [ ] Help: add Returns explaining status / band / accuracy_pct / claims_scored / error_code, plus Exit codes and Examples.
- [ ] Add a next step: 'Open one run: senso evals get <eval_run_id>'.

**`senso evals text`** · 🔴 high

- [ ] Help: add Returns (status values with meanings, band thresholds, claims_total vs claims_scored, accuracy_pct nullability, error_code/error_message, total_cost recorded-not-billed), Exit codes and Examples.
- [ ] Correct the --wait sentence: exit 0 means completed OR gated; say that gated carries no score and how to tell (status == 'gated', accuracy_pct absent).
- [ ] Special-case 503 so the API message survives: 'Evals are not enabled in this environment.' with code `unavailable`-style hint 'This environment has no eval worker configured; retrying will not help.' — today lib/errors.ts replaces it with a retry hint.
- [ ] Give the 422s specific messages with hints: for judge model, 'Run `senso evals evaluators` to see the configured model, or omit --judge-model to use the evaluator default.'
- [ ] JSON: envelope with `next` ({why: 'Read the finished run', command: 'senso evals get <id>'}) and `warnings` for gated runs.
- [ ] Add a hint to the --text-file read failure naming the resolved path and the likely cause.

### `senso gaps` <sub>26 items</sub>

**`senso gaps`** · group

- [ ] Split the description into: one-sentence purpose; a 'Vocabulary' block (problem / status / origin / kind values with meanings, which is today's prose); an 'Id spaces' block; an ordered 'Workflow' list; and 'Notes' for the product gate and the json/stderr rule.
- [ ] State in the group help that under --output json every hint disappears and that the JSON envelope's `next` array carries the same guidance (once the envelope of STANDARDS 2.2 exists).
- [ ] Add 'See also: senso search --no-gap-signals (stop probe searches filing gaps), senso kb create-raw (write the answer), senso tags list (--tag ids)'.

**`senso gaps answer`** · 🟠 medium

- [ ] Help: add Arguments, Returns, Exit codes, Examples; state that both --updated and the default land the gap in `addressed`, and that the content id is not verified by the API.
- [ ] JSON: `next` should carry {why: 'Confirm the gap closed after the next search or evaluation', command: 'senso gaps get <gapId>'} and the undo command; `warnings` should carry 'The API does not verify content ids; check that <id> is the document you meant.'
- [ ] Consider a --verify flag (or a default check) that reads `senso kb get <content-id>` before recording, turning a typo into exit 2 instead of a false fix.

**`senso gaps dismiss`** · 🟠 medium

- [ ] Help: add Arguments, Returns, Exit codes, Examples; contrast dismissed with not_relevant and with we_dont_do_this in one line each.
- [ ] JSON: `warnings` should carry 'A dismissed gap stays closed even if it is seen again.' and `next` the undo command plus the --no-gap-signals suggestion when origin.kind is api_unanswered_question.

**`senso gaps get`** · 🔴 high

- [ ] Help: add Arguments (gap_id, where it comes from, what it is not), Returns (the three sections, and the meaning of retrieval counts, awaiting_update, suggested vs contradicting content), Exit codes and Examples.
- [ ] JSON: put nextSteps() into the envelope's `next` array (each entry {why, command}) so the guidance survives --output json, and add a `meanings` block or inline `_meaning` keys for problem/status/origin — the values the plain renderer already knows.
- [ ] 404: 'Gap <id> not found in this organization.' with hint 'It may belong to another organization, or the id may be a content_id. `senso gaps list --status all` lists every gap.' — mirror what recordResolution's notFoundAware already does for the 400 case.
- [ ] Say in help that the id is a gap_id and that content ids printed in the output belong to a different space.

**`senso gaps list`** · 🔴 high

- [ ] Help: add Returns (naming problem/status/origin/kind values, the three demand counters, awaiting_update, latest_resolution, origin.kb_node_id/session_id/geo_question_id), Exit codes, and two Examples.
- [ ] Help: explain each --sort value in one clause.
- [ ] JSON: emit the STANDARDS 2.2 envelope with `page` {offset, limit, returned, total, has_more, next} and a `next` array carrying what stderr says today — for an empty default view, {why: 'A gap seen once is weak and hidden from the default list', command: 'senso gaps list --status weak'} and the --status all variant.
- [ ] Plain: print 'No gaps found.' on stdout for an empty result, keeping the why on stderr; move `gap_id` to the first line of each block.
- [ ] 403: say 'This organization does not have the fetch product, which the gap report requires. An org admin can enable it.' instead of the generic scope sentence.

**`senso gaps resolve`** · 🟠 medium

- [ ] Help: reformat the type table as one line per type; add Arguments, Returns (resolution_id and what takes it), Exit codes and Examples.
- [ ] Help: state that --ruling-side is informational only and is not validated against --type, and that an org API key records the decision with no author.
- [ ] JSON: envelope with `next` carrying {why: 'Retract this decision if it was wrong', command: 'senso gaps undo <gapId> <resolutionId>'} and, for the two no-status-change rulings, {why: 'The gap stays open until the losing document is corrected', command: 'senso gaps answer <gapId> --content-id <id> --updated'}.
- [ ] Map the API's 400 'Invalid request body' to a usage error (exit 2) naming the body key, since every field the CLI sends is already validated locally — reaching it means the CLI built a bad body.

**`senso gaps undo`** · 🟠 medium

- [ ] Help: add an Arguments block naming both id spaces and their sources, plus Returns, Exit codes and Examples.
- [ ] Distinguish the two 404s using the API message: 'Gap <gapId> not found in this organization.' vs 'Resolution <resolutionId> does not belong to gap <gapId>, or was already undone.'
- [ ] Detect the transposed-argument case (resolutionId matches a known gap id shape only after the fact is not possible locally, but the 'Gap not found' 404 with two ids present can add the hint 'Check the order: <gapId> first, then <resolutionId>.').
- [ ] JSON: emit { action: 'undone', resource: 'gap_resolution', id: <resolutionId>, gap_id } as `data`, and add `next` {why: 'Read the recomputed status', command: 'senso gaps get <gapId>'}.
- [ ] Better still: follow the DELETE with a GET of the gap when not --quiet, so the new status can be reported instead of being described as 'recomputed'.

### `senso generate` <sub>41 items</sub>

**`senso generate`** · group

- [ ] Rewrite the group description to name the id spaces, the typical workflow as an ordered list, the GEO requirement and which subcommands are billable.
- [ ] Add `generate sample-status <sampleJobId>` (GET /org/content-generation/sample-jobs/{id}) so `--no-wait` and the 180 s timeout hand back a runnable poll command.

**`senso generate industry-draft`** · 🟠 medium

- [ ] Validate --industry-prompt-id, --content-type-id and each --product-line-ids entry as UUIDs -> exit 2.
- [ ] Help: keep the billing/not-stored statements as the second line of the description; add Returns (document_markdown, citations, retrieval.context_chunks_used, notes), Exit codes with 402/422/504, Examples, and See also (industries prompts, content draft).
- [ ] On 402 keep code insufficient_credits but carry the API's code (insufficient_credits vs spending_limit_reached) in the message; on 422 hint `senso org set-industry`; on 404 name 'Industry prompt <id> not found in your organization's industry' with hint `senso industries prompts`.
- [ ] Plain: document_markdown as an indented block after the metadata, citations as a numbered sub-block, notes on stderr as warnings; JSON: warnings from notes[], next = content draft.

**`senso generate job-context`** · 🟠 medium

- [ ] Plain: print the summary first as key/value, then prompts as numbered blocks with geo_question_id first; table columns geo_question_id, queue_type, question_text, editorial_status, content_id.
- [ ] Help: explain queue_type, nullable fields, citeables_action, and that this is the set `generate run` processes; add Returns/Exit codes/Examples.

**`senso generate run`** · 🔴 high

- [ ] Validate --prompt-ids, --content-type-id, --publisher-ids as UUIDs -> exit 2 naming the flag and the bad value.
- [ ] Help: id spaces, billing, prerequisites (generation enabled), semantics of omitting each flag, Returns (run_id), terminal statuses, Exit codes with the 409, Examples.
- [ ] Pass the 400 messages through prefixed 'Could not start run:' with a hint to `senso prompts list` / `senso destinations list` / `senso content-types list` by field; on 409 hint `senso generate runs-list --active-only`.
- [ ] Plain: print `✓ Run <run_id> accepted.` on stderr and `Next: senso generate runs-get <run_id>`; JSON: next with runs-get and runs-items.

**`senso generate runs-get`** · 🔴 high

- [ ] Unwrap `run` for plain/table (emit data.run with columns) while leaving JSON as the API's shape.
- [ ] Validate <runId> as a UUID -> exit 2.
- [ ] Help: id space, status enum with meanings, terminal set, Returns, Exit codes, Examples; JSON next: runs-items when terminal, runs-get again when not.
- [ ] 404: 'Run <id> not found in this organization.' with hint `senso generate runs-list`.

**`senso generate runs-items`** · 🟠 medium

- [ ] Validate --status with parseEnumFlag -> exit 2; validate <runId> UUID and --limit/--offset ranges.
- [ ] Help: statuses and failed_at_step meanings, id spaces, Returns, Exit codes, Examples.
- [ ] Table columns: run_item_id, status, queue_type, question_text, content_id, failed_at_step. Plain: 'No items found.' + paging line; JSON page and next (generated-content get <content_id> for succeeded items).
- [ ] 404: 'Run <id> not found in this organization.'

**`senso generate runs-list`** · 🔴 high

- [ ] Validate --status with parseEnumFlag over [queued, running, completed, partial_failed, failed, dispatch_failed, blocked, skipped, stopped] -> exit 2; validate --limit (>=1) and --offset (>=0) with parseIntFlag; validate dates as YYYY-MM-DD or RFC3339 before the request.
- [ ] Help: list and explain every run status, say which are terminal, note --active-only ≡ status in (queued, running), add Returns/Exit codes/Examples.
- [ ] Plain: 'No runs found.' on stdout plus stderr explanation of active filters; stderr 'Showing 1–20 of 57. Next page: senso generate runs-list --offset 20'; JSON: page {offset, limit, returned, total, has_more, next}.
- [ ] Table: default columns run_id, status, trigger_mode, succeeded_items, failed_items, created_at.

**`senso generate runs-logs`** · 🟢 low

- [ ] Validate <runId> UUID and --limit/--offset -> exit 2.
- [ ] Help: Returns (level, event_type, run_item_id), Exit codes, Examples.
- [ ] Plain: 'No log entries found.' + paging line; table columns created_at, level, event_type, message, run_item_id.
- [ ] 404: 'Run <id> not found in this organization.'

**`senso generate sample`** · 🔴 high

- [ ] Help: name id spaces and sources, list --destination as a slug from `senso destinations list` (.slug), state billing, the 180 s wait, the job statuses and every error.code with meaning, Returns, Exit codes, Examples.
- [ ] Validate --prompt-id and --content-type-id as UUIDs and --destination length 1-64 -> exit 2 before the request.
- [ ] Map job error.code insufficient_credits to CliError code insufficient_credits (still exit 1); pass other job codes through as error.code with the operator message.
- [ ] Add `generate sample-status <sampleJobId>` and make the --no-wait output and the timeout hint point at it.
- [ ] Plain: print raw_markdown as an indented block, publish_results as a numbered sub-block; JSON: add next = generated-content get <content_id>.
- [ ] Stream each status change to stderr (already done) and add elapsed seconds.

**`senso generate settings`** · 🟠 medium

- [ ] Help: add Returns (field meanings, day-of-week mapping, omitempty note), Exit codes (3 = GEO), Examples, See also.
- [ ] Plain: render `publishers` as a numbered sub-block with publisher_id first.
- [ ] Emit a `next` hint when enable_content_generation is false or selected_content_type_id is missing: the update-settings call that fixes it.

**`senso generate update-settings`** · 🔴 high

- [ ] Validate --data before the request: reject unknown keys (name them), enforce bool/array/uuid-or-null types, enforce 0-6 on content_schedule; exit 2 with field/received/allowed.
- [ ] Help: document each key with its type and semantics (PATCH: omitted = unchanged, null clears selected_content_type_id), list exit codes 2/3/1(400 not-own content type, 422 no publishers).
- [ ] Pass the 422 and the 'does not belong' 400 through prefixed with 'Could not update content generation settings:' and add the hint `senso destinations list` / `senso content-types list`.
- [ ] Emit `warnings` in JSON when the request enabled generation and publishers is still empty.

### `senso engine` <sub>19 items</sub>

**`senso engine`** · group

- [ ] Group help: name the GEO product and update:content permission.
- [ ] Document `content_id` as the create-vs-update switch, at group level and in both subcommands.
- [ ] Name the id sources: geo_question_id from `senso questions list`, content_id from `senso generated-content list --status drafts`, publisher_ids from `senso destinations list`.
- [ ] Add the workflow and cross-reference `senso content verification`, `senso content unpublish` and `senso publish-records retry`.

**`senso engine draft`** · 🔴 high

- [ ] Validate --data locally: raw_markdown and seo_title non-blank, UUID fields parse, builder workspace fields paired, unknown top-level keys named -> exit 2 before the request.
- [ ] Correct the help: only raw_markdown and seo_title are required; geo_question_id is optional.
- [ ] Document content_id as the update switch and warn that omitting it creates a new item on every call.
- [ ] Say that a draft MAY contain `[Missing approved evidence: ...]` placeholders but `senso engine publish` will refuse them.
- [ ] Confirmation: `Saved draft <content_id> (version <version_num>).`
- [ ] Add next-step hints: `senso generated-content get <content_id>` and `senso engine publish --data '{"content_id": ...}'`.
- [ ] Document the 409 family and the 404 family with their exact messages.

**`senso engine publish`** · 🔴 high

- [ ] Treat publish_status !== "success" as a failure: print the failing destinations and their error_msg, and exit 1. This is the highest-value change in the batch.
- [ ] Validate --data locally: require raw_markdown and seo_title (non-blank), reject an unknown top-level key by name, check every UUID-shaped field parses, enforce builder_workspace_id/expected_workspace_version_id togetherness, and reject a `[Missing approved evidence: ...]` placeholder - all exit 2 before the request.
- [ ] Validate --publisher-ids values as UUIDs -> exit 2.
- [ ] Correct the help: geo_question_id is OPTIONAL; only raw_markdown and seo_title are required.
- [ ] Document content_id as the create-vs-update switch, prominently, with the duplicate-creation warning.
- [ ] Document manual_published_url alongside mark_as_published, and say that omitting it leaves the content published but untracked.
- [ ] Render publish_destinations as a table/sub-blocks, and give each destination's status and display_url a line.
- [ ] Document the 409 in-flight case as retryable, and the destinations-not-configured 400 with the `senso destinations list` / `senso generate update-settings` fix.

### `senso destinations` <sub>12 items</sub>

**`senso destinations`** · group

- [ ] Rewrite the group description to name publisher_id vs slug, the permissions, and the workflow as an ordered list; mention how citeables gets seeded.

**`senso destinations add`** · 🔴 high

- [ ] Drop codeables/cucopilot from --type; accept only citeables (or remove the flag until another type exists) and say why in help.
- [ ] Validate --domain as a bare hostname (no scheme, no path) -> exit 2.
- [ ] Help: permission (update:org), idempotency, selected_for_generation side effect, Returns, Exit codes with the 422/502 citeables cases, Examples.
- [ ] Pass the citeables 422 through prefixed 'Could not register <domain>:' with a hint to check the domain's DNS and retry; JSON next: destinations list.

**`senso destinations list`** · 🟠 medium

- [ ] Fix the table columns: publisher_id, name, slug, display_url, scope, live_count, selected_for_generation.
- [ ] Help: add Returns explaining scope, type, slug vs publisher_id, live_count/last_publish_at, and Exit codes/Examples; plain 'No destinations found.' with a hint to enable generation.
- [ ] JSON next: when nothing is selected_for_generation, suggest the update-settings call that seeds citeables.

**`senso destinations remove`** · 🔴 high

- [ ] Validate <publisherId> as a UUID (and say a slug is not accepted) -> exit 2; reject --keep-domain without --also-remove-destination -> exit 2.
- [ ] Refuse --also-remove-destination client-side when the id is a shared destination? Not knowable without a list call; instead map the 404 on that flag to 'Cannot delete shared destination; drop --also-remove-destination' (exit 1) and name the id in the plain 404.
- [ ] Emit warnings for partial_failures (JSON warnings[], stderr lines) and print the tick as 'Unlinked destination <id>; N of M pages could not be unpublished' when they exist.
- [ ] Help: id space, irreversibility of delete, Returns explaining each count, Exit codes, Examples.

### `senso publish-records` <sub>11 items</sub>

**`senso publish-records`** · group

- [ ] Either drop "Inspect and" from the description, or add a `publish-records list` that reads the destinations off `GET /org/content/verification` - the data is already there, and two other help texts already assume the command exists.
- [ ] Name the sources of a publish_record_id in the group help.
- [ ] List the states the CLI can observe and which ones are actionable (only `failed` is retryable).
- [ ] Cross-reference `senso content unpublish --publish-record-ids`, which is the other command that consumes this id.

**`senso publish-records retry`** · 🔴 high

- [ ] Validate <publishRecordId> as a UUID -> exit 2.
- [ ] Confirmation: `Publish record <id> is now live.` for the 204.
- [ ] Special-case the 502: "The destination refused the retry; the record is back in `failed`." with a hint to read last_error from `senso content verification --status published`.
- [ ] Document the 409 with its exact message and the fact that only `failed` is retryable, plus how to read `state` before retrying.
- [ ] Distinguish the three 404 messages: "Publish record <id> not found", "The publisher for publish record <id> no longer exists", "The content behind publish record <id> no longer exists".
- [ ] Emit {"action":"retried","resource":"publish_record","id":"...","state":"live"} so a JSON caller has an outcome.
- [ ] Name the sources of the id in the Arguments section.

### `senso brand-kit` <sub>14 items</sub>

**`senso brand-kit`** · group

- [ ] Say the brand kit is a singleton per organization, always readable, created by the first 'set'.
- [ ] Name the consumers (content generation) and the alternative producer ('senso website-import').
- [ ] Add a one-line workflow: get -> patch/set -> get.

**`senso brand-kit get`** · 🟠 medium

- [ ] Hand-write the plain rendering: one line per guideline key in a fixed order, with '(not set)' for the missing ones, and global_writing_rules as a numbered list.
- [ ] Detect the synthesized record (zero brand_kit_id / zero timestamps) and say 'No brand kit saved yet.' with 'senso brand-kit set --data ...' and 'senso website-import' as next steps.
- [ ] Say in the help that brand_kit_id is not used by any command.

**`senso brand-kit patch`** · 🟢 low

- [ ] Distinguish the confirmation: 'Patched brand kit: voice_and_tone.' vs set's 'Brand kit replaced.'
- [ ] Hand-write the plain rendering of the merged kit, one line per key, as for 'brand-kit get'.
- [ ] Report the changed keys in warnings[] / on stderr, and say when global_writing_rules replaced a longer list.
- [ ] Keep everything else — this command is the reference implementation for --data validation in this CLI.

**`senso brand-kit set`** · 🟠 medium

- [ ] Report the diff: read the current kit first (or accept the extra call behind a flag) and print 'Removed: author_persona, global_writing_rules.' on stderr and in warnings[].
- [ ] Require a confirmation or an explicit --clear for '{"guidelines":{}}'.
- [ ] Hand-write the plain rendering of the result, one line per key, as for 'brand-kit get'.
- [ ] Say in the help why stray top-level keys are rejected locally: the API accepts them with a 200 and drops them.

### `senso content-types` <sub>30 items</sub>

**`senso content-types`** · group

- [ ] Explain the mechanism in the group help: config.template is the spec, and its headings and word-count phrases are parsed into template_spec and enforced on generated output.
- [ ] Say template_spec is read-only in practice — supplying it is pointless because it is regenerated from template.
- [ ] Say names are unique per organization (409 on a duplicate).
- [ ] Add the workflow: list -> create -> get (to see the derived template_spec) -> use with the generate commands.

**`senso content-types create`** · 🔴 high

- [ ] Validate --data before the request, the way brand-kit already does: require name (non-blank) and config (object); reject unknown config keys naming the offender with a did-you-mean; type-check each key; require cta_destination to be an absolute URL -> exit 2.
- [ ] Reject or warn on a supplied template_spec: it is derived from template and will be overwritten.
- [ ] Help: describe the template parsing (headings -> sections, word phrases -> enforced budgets) and show a realistic template in the example.
- [ ] 409: 'A content type named "Blog Post" already exists.' with the hint 'senso content-types list' / 'senso content-types patch <id>'.
- [ ] Note in Returns that config comes back canonicalized with every key present.

**`senso content-types delete`** · 🟢 low

- [ ] Validate <id> as a UUID -> exit 2; 404 'Content type <id> not found in this organization.' with hint 'senso content-types list'.
- [ ] Echo the name in the confirmation (fetch it first, or accept that only the id is known and say so).
- [ ] Say in the help that existing generated content is unaffected but new generation referring to this type will fail.
- [ ] Emit the documented mutation envelope: data {action: 'deleted', resource: 'content_type', id}.

**`senso content-types get`** · 🔴 high

- [ ] Give this command a hand-written plain rendering: the template printed as text over multiple lines, then template_spec as a numbered section list with each section's word budget, then writing_rules as a numbered list.
- [ ] Validate <id> as a UUID -> exit 2; 404 'Content type <id> not found in this organization.' with hint 'senso content-types list'.
- [ ] Explain template_spec in Returns, including that it is read-only.
- [ ] Add next steps: 'senso content-types patch <id>' and the generate command that consumes it.

**`senso content-types list`** · 🟠 medium

- [ ] Validate --limit ({min: 1}) and --offset ({min: 0}) with parseIntFlag -> exit 2.
- [ ] Pass an explicit plain rendering that omits or summarizes config (e.g. 'template: 4 sections, 800-1200 words') and keeps the id and name first.
- [ ] Empty list: 'No content types found.' with 'senso content-types create --data ...' on stderr.
- [ ] Say in the help that 'total' counts only this page, so paging must be driven by 'returned == limit', and emit a page object that says so.
- [ ] Say content_type_id is the id the generate commands take.

**`senso content-types patch`** · 🟠 medium

- [ ] Validate --data client-side: at least one of name/config, non-blank name, closed config key set with types, absolute cta_destination -> exit 2.
- [ ] Say writing_rules is replaced wholesale by a patch, and that changing template re-derives template_spec and therefore the enforced word budgets.
- [ ] Distinguish the confirmation: 'Patched content type <id> (config.template).'
- [ ] Validate <id>; 404 naming the resource.

**`senso content-types update`** · 🔴 high

- [ ] Validate --data client-side exactly as for 'create' (name non-blank, config present, closed key set, types, absolute cta_destination) -> exit 2.
- [ ] State explicitly that omitted CONFIG keys are cleared, and warn on stderr which previously-set keys the new config drops (the CLI can GET first, or simply name the risk).
- [ ] Document the 409 and hint at 'content-types list'.
- [ ] Validate <id>; 404 naming the resource and id.

### `senso prompts` <sub>22 items</sub>

**`senso prompts`** · group

- [ ] Say in one line that prompts and questions are two views of the same geo_questions rows, that prompt_id === geo_question_id, and when to use which group.
- [ ] Add the id space and the typical workflow as an ordered list: prompts create -> prompts list -> (scheduled run) -> prompts get / analytics prompts.
- [ ] State that creation does not trigger a run and point at 'senso run-config schedule'.

**`senso prompts create`** · 🔴 high

- [ ] Validate --data before the request: require question_text (non-empty, <= 500 chars) and type; check type against the four stages plus the accepted aliases with parseEnumFlag-style handling -> exit 2 naming the field, the value received and the allowed values.
- [ ] Name the unknown keys in --data rather than silently posting them (the API ignores geo_pool_id / tag_ids here even though 'questions create' accepts both).
- [ ] Help: document the 500-character limit, the alias normalization, and that tags come back empty because auto-tagging is asynchronous.
- [ ] Add next steps on stderr: 'senso prompts tags set <id> --names ...' and 'senso run-config schedule' (runs are scheduled, not immediate).

**`senso prompts delete`** · 🟠 medium

- [ ] Validate <promptId> as a UUID -> exit 2.
- [ ] 404: 'Prompt <id> not found in this organization.' with hint 'senso prompts list'. Map the other-org 403 to exit 4.
- [ ] Reword: the run history is removed from the API's view (soft delete); there is no undelete.
- [ ] Emit the documented mutation envelope: data {action: 'deleted', resource: 'prompt', id}.
- [ ] Mention that 'senso questions delete <id>' is the same operation.

**`senso prompts get`** · 🔴 high

- [ ] Validate <promptId> as a UUID before the request -> exit 2 naming the id space.
- [ ] 404: 'Prompt <id> not found in this organization.' with hint 'senso prompts list --search ...'.
- [ ] Map the endpoint-specific 403 'Prompt does not belong to this organization' to exit 4 with the same not-found wording — from the caller's side it is a wrong id, not a permissions problem. Keep the product 403 as exit 3.
- [ ] Hand-write the plain rendering: prompt header, then one numbered block per run with model / created_at / is_latest / target_mentioned / target_rank / target_sov, then claims and citations as indented sub-blocks.
- [ ] Say in Returns what each score means and that 'competitors' is the non-target subset of 'evals'.
- [ ] When runs is empty, say so on stderr with 'senso run-config schedule' as the next step.

**`senso prompts list`** · 🟠 medium

- [ ] Help: name prompt_id, give the type values and their meaning, say search is a case-insensitive substring of the question text only, say --limit is capped at 100 by the API.
- [ ] Validate --limit with parseIntFlag('--limit', v, {min: 1, max: 100}) and --offset with {min: 0} — exit 2 before the request rather than silently getting a different page.
- [ ] Emit the page footer on stderr: 'Showing 1-50 of 312. Next page: senso prompts list --offset 50', and put a page object in the JSON envelope.
- [ ] Empty list: 'No prompts found.' on stdout plus, on stderr, 'senso prompts create --data ... adds one' and a note that --search narrows the list.

### `senso prompts tags` <sub>20 items</sub>

**`senso prompts tags`** · group

- [ ] Name the id space (<promptId> from 'senso prompts list') and point at 'senso tags list' for tag ids.
- [ ] Explain 'curated': false means the tag was machine-minted from a search query and is awaiting adoption; attaching it here adopts it org-wide.
- [ ] Warn that 'set' is a replace, and that 'set' with no flags clears the prompt's tags.

**`senso prompts tags add`** · 🟠 medium

- [ ] Reject --name together with --id -> exit 2, rather than silently dropping --name.
- [ ] Validate --id and <promptId> as UUIDs, and --name as 1-255 characters -> exit 2.
- [ ] Say in Returns that nothing is returned and point at 'senso prompts tags list <id>' to read back the id of a tag created by name; add it as a next step.
- [ ] State whether re-attaching an already attached tag is a no-op.

**`senso prompts tags list`** · 🟠 medium

- [ ] Validate <promptId> as a UUID -> exit 2.
- [ ] Empty result: 'No tags attached to prompt <id>.' on stdout, with 'senso prompts tags add <id> --name <tag>' on stderr.
- [ ] Help: explain curated, and say the 'id' field is what 'prompts tags remove --id' and 'prompts tags set --ids' take.
- [ ] 404 wording as for 'prompts get'.

**`senso prompts tags remove`** · 🟠 medium

- [ ] Reject --name together with --id -> exit 2.
- [ ] Validate <promptId> and --id as UUIDs, and --name as non-blank -> exit 2.
- [ ] Say plainly in the help that a name or id that was not attached still exits 0, and suggest 'senso prompts tags list <promptId>' to confirm the result.
- [ ] Optionally read the tag list back and report 'Detached X' vs 'X was not attached; nothing changed' as a stderr warning and a warnings[] entry.

**`senso prompts tags set`** · 🔴 high

- [ ] Require at least one of --names / --ids, and add an explicit --clear flag for the 'remove all tags' intent -> exit 2 otherwise.
- [ ] Validate every --ids entry as a UUID before the request, naming the offending value -> exit 2.
- [ ] Validate every --names entry as non-empty and <= 255 characters -> exit 2 naming the offending name.
- [ ] Report the diff on stderr: 'Added: x, y. Removed: z. Created new tag: y.' and put it in warnings[] in the JSON envelope.
- [ ] Validate <promptId> as a UUID -> exit 2.

### `senso run-config` <sub>30 items</sub>

**`senso run-config`** · group

- [ ] Describe the two model spaces in the group help, with the vocabulary each takes, and say plainly that 'set-models' also rewrites the scheduler opt-in while 'set-scheduler-models' does not rewrite the legacy list.
- [ ] Recommend one path for agents: model-options -> set-models -> models, and mark the scheduler-models pair as advanced.
- [ ] Note that the reads need the GEO product and the writes need the update:org permission (JWT callers) — different failures for the same group.

**`senso run-config model-options`** · 🔴 high

- [ ] Pass explicit rows: emit(ctx, data, {table: {rows: data.valid_models, columns: ['name','display_name']}, plain: <one line per option>}) so the list renders in every format.
- [ ] Say in the help that a few names are accepted but not listed (the OpenAI direct-API model 'gpt', and the aliases aioverview / claude-sonnet-4-6 / gpt-4.1), so an agent seeing one of them in 'run-config models' does not think it is invalid.
- [ ] Add the follow-up command to stderr: 'senso run-config set-models --data '{"models":["chatgpt","claude"]}''.
- [ ] Explain 'scope'.

**`senso run-config models`** · 🟠 medium

- [ ] Empty result: 'No run models configured. No runs will be produced.' on stdout, with 'senso run-config set-models --data ...' on stderr.
- [ ] Help: say the 'name' field is what set-models takes and that geo_model_id is not used by any command.
- [ ] Point at 'run-config model-options' and note the scheduler-models relationship.

**`senso run-config schedule`** · 🟢 low

- [ ] Render day names alongside the numbers: 'schedule 1 (Monday), 3 (Wednesday), 5 (Friday)'.
- [ ] Empty schedule: 'No run days configured — scheduled runs will not fire.' on stdout, with 'senso run-config set-schedule --data ...' on stderr.
- [ ] Say in the help that the schedule has day granularity only, and add set-schedule as a next step.

**`senso run-config scheduler-models`** · 🟠 medium

- [ ] Show the joined 'provider/model' id as a first-class field in the output, since that is the value the write command takes.
- [ ] Explain execution_mode and drop or explain adapter_key.
- [ ] Empty result: 'No scheduler models opted in.' plus the set-models / set-scheduler-models next step.
- [ ] Point at 'senso run-config models' and say which of the two the scheduler actually uses.

**`senso run-config set-models`** · 🔴 high

- [ ] Fix the error path so the endpoint's own message survives: prefer body.message when body.error is also present for model-validation 400s, or special-case the unsupported_models/valid_models/suggestions body and render 'Unsupported: gpt5. Did you mean gpt? Accepted: aioverview, chatgpt, claude, gemini, google_ai_overviews, gpt, grok, perplexity.' Put unsupported_models, valid_models and suggestions into the JSON error object.
- [ ] Validate --data before the request with the same assertModels() the scheduler command uses: models present, an array, non-empty, every entry a non-blank string <= 255 characters -> exit 2.
- [ ] List the accepted names in the help and point at 'senso run-config model-options'.
- [ ] Warn that this REPLACES the set and report the diff (added / removed) on stderr and in warnings[].
- [ ] Say that it also rewrites the scheduler opt-in.

**`senso run-config set-schedule`** · 🟠 medium

- [ ] Reject an empty schedule with exit 2 and an explicit message: the API cannot store 'no days' through this endpoint.
- [ ] Say REPLACES in the description, and print the diff: 'Added Friday, removed Monday.'
- [ ] De-duplicate (or reject duplicates) client-side and render day names in the result.
- [ ] Say there is no time-of-day or timezone control.

**`senso run-config set-scheduler-models`** · 🔴 high

- [ ] Make the error path keep the API's message: render 'Unsupported: anthropic/sonnet. Did you mean anthropic/claude? Accepted: ...' and carry unsupported_models / valid_models / suggestions in the JSON error object. Until then, remove the promise from the help.
- [ ] Extend assertModels to require a '/' in each entry, with a hint that bare names belong to 'senso run-config set-models' -> exit 2.
- [ ] List the seeded catalog in the help (brightdata/chatgpt, brightdata/grok, brightdata/perplexity, brightdata/gemini, brightdata_serp/google_ai_overviews, anthropic/claude, openai/gpt) while saying it is configurable.
- [ ] Say this does NOT update the run-model list, and recommend 'set-models' for the common case.

### `senso skills` <sub>18 items</sub>

**`senso skills`** · group

- [ ] Group help: say the commands are local, need shipables (or npx and network), use the short name as id, and are scoped to the current directory unless --global. Add the typical workflow as an ordered list.
- [ ] Accept both the short name and the full `senso-ai/senso-<name>` package in install and remove.

**`senso skills install`** · 🔴 high

- [ ] Validate [names...] against SENSO_SKILLS (short or full package form) → exit 2 with field/received/allowed and a did-you-mean, before spawning anything.
- [ ] Accept `senso-ai/senso-<name>` as-is (strip the prefix only when absent) so list-available's output round-trips.
- [ ] Refuse (exit 3, code unauthorized) when no key is available unless --no-env is passed, instead of installing an unauthenticated skill.
- [ ] Redact the key when echoing the child's argv in a failure message; never print `--env SENSO_API_KEY=<key>` on stderr.
- [ ] Warn in help and on stderr (plain) that the key is passed on the child's command line; add --no-env.
- [ ] On partial failure include the structured {installed, failed[{name, package, reason}]} under error.data so a JSON caller knows what happened; map a killed/timeout child to code timeout (exit 5) and a missing shipables + failed npx to a hint naming `npm install -g @senso-ai/shipables`.
- [ ] Help: Returns / Exit codes / Examples per §2.1; say --all equals no names.

**`senso skills list`** · 🟠 medium

- [ ] Read ~/.shipables/installed.json the way uninstall.ts does (no subprocess, no npx download) and emit a normalized {scope, skills[{name, package, version, agents[]}]}; keep shipables as a fallback.
- [ ] Empty: 'No Senso skills installed in <dir>.' on stdout, with a stderr note about other scopes and the widening command (`--global`).
- [ ] Help: say scope is the current directory unless --global; Returns / Exit codes / Examples.

**`senso skills list-available`** · 🟢 low

- [ ] Rename shortName → name for consistency with uninstall's payload; add a one-line description per skill; move the 'Install all' hint to stderr.
- [ ] Help: say it is static and offline; Returns/Examples.

**`senso skills remove`** · 🟠 medium

- [ ] Map shipables' 'is not installed' (exit 4 / message text) to exit 4, code not_found, message naming the skill and scope, hint `senso skills list --output json` (+ --global).
- [ ] Accept senso-ai/senso-<name> as well as the short name; validate against SENSO_SKILLS → exit 2 with allowed.
- [ ] Rewrite the child's failure message: drop 'Command failed: shipables …', keep the reason, never echo the argv.
- [ ] Emit {action:"removed", resource:"skill", name, package, scope}; help per §2.1 with the scope rule.

### `senso members` <sub>6 items</sub>

**`senso members`** · group

- [ ] Group description: name the relationship to senso users (same people, this one has email/name/role name; that one mutates), and that user_id here is the id senso users takes.

**`senso members list`** · 🟠 medium

- [ ] Table columns: user_id, email, given_name, family_name, role_display_name.
- [ ] parseEnumFlag for --sort; parseIntFlag for --limit (1-1000) and --offset (>=0) → exit 2.
- [ ] Plain: numbered blocks, user_id first; stderr 'Showing 1–50 of 120. Next page: senso members list --offset 50'; empty with --search → 'No members match "<q>".' + 'Drop --search to list everyone.'
- [ ] JSON envelope with page.
- [ ] Help: Returns section naming user_id as the id for senso users, role_display_name vs role_id, groups.

### `senso credits` <sub>7 items</sub>

**`senso credits`** · group

- [x] Make 'senso credits' run the balance action by default: register the balance handler on the group command itself (credits.action(runAction(...)) alongside the 'balance' subcommand, or mark balance with { isDefault: true }). Keep 'senso credits balance' working. Add a CHANGELOG entry and an e2e test 'senso credits --output json exits 0 and prints the balance'.
- [x] In parallel, fix the three skills to 'senso credits balance --output json --quiet' so they work on every published CLI version.
- [x] Group description: explain dedicated vs partner-billed balances and which field to watch.

**`senso credits balance`** · 🟠 medium

- [x] Plain: render null explicitly ('credits_available unlimited (billed to partner, no spend limit)') via a small hand-written plain renderer; keep JSON raw.
- [x] Help: Returns section with the dedicated/partner branching and the 402 rule; Examples with jq.
- [x] Fix the test fixture field name.
- [x] Make the command the default of the credits group.

### `senso questions` <sub>21 items</sub>

**`senso questions`** · group

- [ ] Rewrite the group description: same records as 'senso prompts', different verbs. State that geo_question_id === prompt_id.
- [ ] Give the split explicitly: use 'questions' for funnel-stage changes, tags at creation and network-scoped questions; use 'prompts' for search/sort/paging, run history and tag management.
- [ ] Rename or at least re-document 'questions list --type' as a scope filter — ideally add --scope as the name and keep --type as a deprecated alias — because it collides with the funnel-stage 'type' in the same group.
- [ ] Warn on 'questions delete' that it removes run history too.

**`senso questions create`** · 🔴 high

- [ ] Validate --data before the request: question_text present and <= 255 characters; type one of the four stages, case-sensitive; every tag_ids entry a UUID; reject unknown keys naming them -> exit 2.
- [ ] Help: say the limit is 255 here and 500 through 'senso prompts create', and that this endpoint does NOT accept the legacy stage spellings.
- [ ] Warn when the response has no 'tags' although tag_ids were sent — that means the API swallowed a tag failure.
- [ ] Point at 'senso tags list' for tag ids, and add next steps (prompts get / run-config schedule).

**`senso questions delete`** · 🟠 medium

- [ ] Say it removes the question AND its run history, exactly as 'senso prompts delete' does, and that there is no undelete.
- [ ] Validate <questionId> as a UUID -> exit 2; 404 message naming the resource and id; map the other-org 403 to exit 4.
- [ ] Emit the documented mutation envelope: data {action: 'deleted', resource: 'question', id}.

**`senso questions list`** · 🔴 high

- [ ] Pass explicit rows to emit(): emit(ctx, data, {table: {rows: data.questions, columns: [...]}, plain: <blocks>}) so plain and table render the list regardless of the envelope's extra keys. (The general fix is to let findRows ignore keys whose value is an empty string or zero, but the per-command override is the safe one.)
- [ ] Rename the flag to --scope with --type kept as a hidden alias, and say in the help that the output's 'type' column is the funnel stage.
- [ ] Say the result is not paginated and that 'senso prompts list' is the paged/searchable view of the same rows.
- [ ] When --type network returns [], say on stderr whether the org has a network at all (or at least point at 'senso org get').
- [ ] Empty result: 'No questions found.' plus the create command on stderr.

**`senso questions patch`** · 🔴 high

- [ ] FIX THE HELP: '{"tag_ids": []} clears every tag; null is rejected as no field provided.' Better, reject tag_ids: null client-side with exit 2 and a hint pointing at [].
- [ ] Validate --data before the request: at least one of tag_ids/type; type against the four stages; every tag_ids entry a UUID; name unknown keys -> exit 2.
- [ ] Validate <questionId> as a UUID -> exit 2; map the other-org 403 to exit 4 with a not-found message.
- [ ] Say tag_ids REPLACES the set, and report the diff in warnings[].
- [ ] Add an --add-tags / --remove-tags convenience or point at 'senso prompts tags add/remove' for incremental changes.

### `senso kb` <sub>161 items</sub>

**`senso kb`** · group

- [ ] Rewrite the group description to name the id spaces: kb_node_id addresses the tree, content_id addresses the stored document; every command here takes kb_node_id unless it says otherwise.
- [ ] Add an ordered workflow block to the group help (browse, add, poll, tag, share, remove).
- [ ] Add a 'Status values' block listing pending/processing/complete/failed and what an agent should do for each.
- [ ] Shorten every leaf description to one line so 'senso kb --help' is scannable; move the detail into each leaf's own help.

**`senso kb permissions`** · group

- [ ] Group help: name the three ids and where each comes from.
- [ ] Group help: state that grants inherit down the tree and that effective_role on 'kb get' is the resolved answer.
- [ ] Group help: define viewer and editor in terms of the kb commands each allows.
- [ ] Group help: note the org-admin bypass, so an empty grant list is not read as 'nobody has access'.
- [ ] Add the ordered workflow (list, add, update, remove).

**`senso kb tags`** · group

- [ ] Fix the columns on 'tags list', 'tags set' and 'tags add' from tag_id to id - the current table output shows an empty first column for every row.
- [ ] Group help: name the id spaces - <id> is a kb_node_id; the tag ids in --ids / --id come from 'senso tags list' (field: id).
- [ ] Group help: say that auto-tagging runs after ingestion and may add to whatever was set manually.
- [ ] Add the ordered workflow to the group help.

**`senso kb ancestors`** · 🟠 medium

- [ ] Help: state that ancestors are ordered root-first and whether the node itself is included; add Returns / Exit codes / Examples.
- [ ] Validate <id> as a UUID before the request - exit 2.
- [ ] Plain: render the chain as a path line first ('Acme Inc / Policies / Refunds'), then the per-node blocks.
- [ ] Empty chain: 'This node is at the top level.' on stdout rather than a blank 'ancestors' value.

**`senso kb bulk-delete`** · 🟠 medium

- [ ] Validate every id as a UUID before the request, and report every offending value at once - exit 2.
- [ ] De-duplicate the list locally and warn on stderr how many duplicates were dropped, so the reported count is real.
- [ ] 404/403: pass the API's batch wording through ('One or more nodes were not found') and add the hint 'The API does not say which. Re-run one id at a time, or verify with: senso kb get <id>'.
- [ ] Report {"action": "deleted", "resource": "kb_node", "ids": [...]} in JSON rather than a message string, so a caller can see exactly what was requested.
- [ ] Add Returns / Exit codes / Examples per the convention.

**`senso kb children`** · 🔴 high

- [ ] Help: name the id space, say it must be a FOLDER node, say the listing is one level deep, and name kb root as the source of the top-level folder id.
- [ ] Validate <id> as a UUID before the request - exit 2.
- [ ] Empty folder: 'No children found.' on stdout, and on stderr the active filters plus 'Widen with: senso kb children <id>' when a filter is set.
- [ ] Pass the 400 'node is not a folder' through with a hint: 'This id is a document. Read it with senso kb get-content <id>.'
- [ ] Add the 'Showing 1-50 of N. Next page: senso kb children <id> --offset 50' footer on stderr.

**`senso kb create-folder`** · 🟠 medium

- [ ] Help: say the operation is not idempotent and names are not unique; suggest 'kb find --query <name> --type folder' before creating.
- [ ] Help: say the returned kb_node_id is what --parent-id, --folder-id (kb upload) and kb_folder_node_id (kb create-raw) all take.
- [ ] Validate --parent-id as a UUID and reject a blank/whitespace --name before the request - exit 2.
- [ ] 404: 'Parent folder <id> not found, or your key has no access to it.' with hint 'senso kb root' / 'senso kb find --type folder'.
- [ ] 403: replace the generic key-scope hint with 'You can see this folder but cannot create in it. Ask an owner to run: senso kb permissions add <parent-id> --grantee-type user --grantee-id <you> --role editor'.
- [ ] Add a Next line on stderr: 'senso kb upload <file> --folder-id <new id>'.

**`senso kb create-raw`** · 🔴 high

- [ ] Help: state in the first Returns line that `id` is the content_id and `kb_node_id` is what every kb command takes; give the jq path in the example.
- [ ] Help: say the API answers 202 and the document is not searchable until content.processing_status is complete; give the poll command.
- [ ] Validate --data keys before the request: require text (non-empty), and name any unrecognized key - exit 2. Say that tag_ids is accepted and ignored, so it can be warned about rather than dropped.
- [ ] Validate kb_folder_node_id as a UUID before the request - exit 2.
- [ ] Pass the 409 through with a hint: 'A document with identical text already exists. Find it with: senso kb find --query <title>'.
- [ ] Report the 402 with its own hint (billing), separate from other exit-1 refusals.
- [ ] Add a Next line on stderr with the poll command, keyed on kb_node_id.

**`senso kb delete`** · 🔴 high

- [ ] Help: bring it up to the level of 'kb bulk-delete' - subtree recursion, irreversibility, id source, the 409 while ingesting, and that the root cannot be deleted.
- [ ] Validate <id> as a UUID before the request - exit 2.
- [ ] 404: 'KB node <id> not found, or your key has no access to it.'; 409: pass the API message through with the poll command 'senso kb get <id>' as the hint.
- [ ] 403: name the KB grant and the fix, not the API-key scope.
- [ ] Add on stderr, before a folder delete in an interactive terminal, the child count from 'kb children'; for non-interactive use add --yes to skip it.

**`senso kb download-url`** · 🟠 medium

- [ ] Help: explain both URLs, the one-hour expiry, and that the URL carries its own authorization (do not add --api-key to the fetch).
- [ ] Validate <id> as a UUID and --rev as an integer >= 1 - exit 2.
- [ ] Pass the 400 'Content is not a downloadable file' through with the hint 'This is a text document. Read it with: senso kb get-content <id>'.
- [ ] Add an Examples block that shows the curl one-liner and the jq field to pipe.
- [ ] Consider a --to <path> flag that performs the download, since that is what every caller does next.

**`senso kb find`** · 🔴 high

- [ ] Help: say plainly that this matches node names and that 'senso search' searches document text; add it to See also.
- [ ] Reject an empty or whitespace-only --query with exit 2 before the request.
- [ ] Render zero results as 'No nodes match "<q>".' on stdout, with 'Searched names only. To search document text: senso search --query "<q>"' on stderr.
- [ ] Validate --tag-ids as UUIDs before the request.
- [ ] Print the 'Showing 1-20 of N' footer and the --offset follow-up on stderr.

**`senso kb get`** · 🔴 high

- [ ] Help: name the id space, say where it comes from and what it is NOT; add a Returns block listing processing_status values and effective_role.
- [ ] Validate <id> as a UUID before the request - exit 2, naming the value and where node ids come from.
- [ ] 404: 'KB node <id> not found, or your key has no access to it.' with hint 'senso kb find --query <name>'. Say both halves - the API cannot distinguish them, so the CLI must not imply it can.
- [ ] Plain: render `content` as an indented sub-block, with processing_status first.
- [ ] Add a Next line on stderr: for processing_status pending/processing, the poll command; for complete, 'senso search'; for failed, 'senso kb get-content <id>' / the error_code.

**`senso kb get-content`** · 🔴 high

- [ ] Help: state explicitly that <id> is a kb_node_id and that the returned `id` is the content_id, which no kb command accepts.
- [ ] Help: say text is present for raw/markdown/web content only; point uploaded binaries at 'kb download-url'.
- [ ] Validate --rev with parseIntFlag(min 1) - exit 2, and say the current version number is content.version_num from 'kb get'.
- [ ] Validate <id> as a UUID - exit 2.
- [ ] Plain: print the metadata block first, then a separator and the full text, so a long document does not bury the fields.
- [ ] Pass the 400 'Node has no associated content' through with a hint naming 'kb children <id>' for a folder.

**`senso kb move`** · 🔴 high

- [ ] Help: say a folder moves with its entire subtree, and that reindexing is asynchronous - point at 'senso kb sync-status'.
- [ ] Validate both ids as UUIDs, and reject --parent-id equal to <id>, before the request - exit 2.
- [ ] 404: 'KB node <id> or destination folder <parent-id> not found, or your key has no access to one of them.' - name both ids, since the API will not say which.
- [ ] 403: name the KB grant and the 'kb permissions add ... --role editor' fix rather than the API-key-scope hint.
- [ ] Add a Next line on stderr: 'senso kb sync-status' and 'senso kb ancestors <id>'.

**`senso kb my-files`** · 🔴 high

- [ ] Help: name the id space (kb_node_id), say the listing is top-level only and grant-filtered, and list the processing_status values.
- [ ] Validate --tag-ids as a comma-separated list of UUIDs before the request - exit 2 naming the offending value.
- [ ] Render an empty list as 'No files found.' on stdout, with the active filters echoed on stderr and the widening command.
- [ ] Print 'Showing 1-50 of 412. Next page: senso kb my-files --offset 50' on stderr whenever total > offset + returned.
- [ ] Add processing_status to the table columns (kb_node_id, name, type, status) and render content as an indented sub-block in plain, not inline JSON.
- [ ] Warn on stderr when --limit is above 50 that the API capped the page.

**`senso kb patch-raw`** · 🟠 medium

- [ ] Help: lead with the contrast - 'omitted keys are left unchanged; use kb update-raw to replace the whole document'.
- [ ] Help: say ingestion restarts and give the poll command; say raw documents only.
- [ ] Validate <id> as a UUID, require at least one of title/summary/text, name unknown keys, and check tag_ids entries are UUIDs - all exit 2 before the request.
- [ ] Pass 409 and 402 through with their own hints.
- [ ] Report a tag-write failure after a successful content patch as a partial success, not a bare 500.

**`senso kb permissions add`** · 🟠 medium

- [ ] Validate --grantee-id as a UUID before the request - exit 2, with the lookup command for the chosen --grantee-type in the hint.
- [ ] Validate <id> as a UUID - exit 2.
- [ ] Help: say grants inherit down the tree; say owner cannot be granted; say a 404 'Group not found' may mean the group exists but is invisible to you.
- [ ] Plain: render grantee as an indented sub-block and label `id` as the permission id.
- [ ] 409: pass the API message through and add the hint 'Find the existing grant with: senso kb permissions list <id>, then: senso kb permissions update <id> <permission_id> --role <role>'.
- [ ] Add a Next line on stderr showing the update and remove commands with the new permission id substituted.

**`senso kb permissions list`** · 🟠 medium

- [ ] Render `grantee` as an indented sub-block in plain, and split it into grantee_type / grantee_name / grantee_email columns for table.
- [ ] Validate <id> as a UUID - exit 2.
- [ ] Empty list: 'No grants on this node.' on stdout, and on stderr 'Access may still come from a grant on a parent folder - check senso kb ancestors <id> - or from an org-admin key, which bypasses grants.'
- [ ] Help: say grants inherit and that this shows only the node's own grants; point at 'kb get' effective_role for the resolved answer.
- [ ] Help: say this needs the share capability, which is why it can 403 where other reads succeed.
- [ ] 403: name the capability and who can grant it rather than the generic API-key-scope hint.

**`senso kb permissions remove`** · 🟠 medium

- [ ] Use emitConfirmation-style reporting: a tick on stderr naming the grantee, and {action: 'revoked', resource: 'kb_permission', node_id, permission_id} on stdout in json.
- [ ] Validate both positional ids as UUIDs - exit 2, naming which argument.
- [ ] Help: say inherited access from a parent folder survives the revoke; point at 'senso kb ancestors <id>' and 'senso kb permissions list' on each ancestor.
- [ ] 404: 'Permission <permissionId> not found on KB node <id>.' with the list command as the hint.
- [ ] Pass 'Cannot revoke your own permission' through with the hint that another admin must do it.

**`senso kb permissions update`** · 🟠 medium

- [ ] Validate both positional ids as UUIDs - exit 2, naming which argument and where each id comes from.
- [ ] After a successful PATCH, re-read the grant (or synthesize {action: 'role_changed', node_id, permission_id, role}) so the JSON payload carries something to verify.
- [ ] Help: say the permission id must belong to this node, and that an invisible group grant also reports not-found.
- [ ] 404: 'Permission <permissionId> not found on KB node <id>.' with the hint 'It may belong to a different node, or be a grant to a group your key cannot see. List them with: senso kb permissions list <id>'.
- [ ] Pass 'Cannot modify your own permission' through with the hint that another admin must make the change.

**`senso kb rename`** · 🟠 medium

- [ ] Help: say this renames the node in the tree only, and name 'kb patch-raw --data {"title":...}' as the way to change a document's title.
- [ ] Help: say the root cannot be renamed and names are not unique.
- [ ] Validate <id> as a UUID and reject a blank --name before the request - exit 2.
- [ ] 404: 'KB node <id> not found, or your key has no access to it.'; 403: name the KB grant and the 'kb permissions add ... --role editor' fix.
- [ ] Say in Returns that the payload has no content block, unlike 'kb get'.

**`senso kb root`** · 🟢 low

- [ ] Help: say the returned kb_node_id is the parent for top-level creates and the argument to 'kb children'.
- [ ] Help: note that the root is not counted by 'kb stats' and cannot be renamed, moved or deleted.
- [ ] Add Returns / Exit codes / Examples per the convention.

**`senso kb stats`** · 🟢 low

- [ ] Help: state that the counts are org-wide and unfiltered by grants, unlike 'kb my-files'.
- [ ] Help: state that total_files includes documents whose processing_status is pending, processing or failed; point at 'kb my-files --status failed' to find the broken ones.
- [ ] Add Returns / Exit codes / Examples per the convention.

**`senso kb sync-status`** · 🟠 medium

- [ ] Help: add Returns explaining both values and what to do - syncing true means a recent move or delete is still propagating to the vector index, so search results may be stale; retry in a few seconds.
- [ ] Add a poll example using --output json and jq.
- [ ] On plain output with syncing=true, print on stderr: 'Vector sync in progress. Search results may be stale. Re-run in ~5s.'

**`senso kb tags add`** · 🟠 medium

- [ ] Help: describe both response shapes explicitly and say --name is the only way to get a newly created tag's id back.
- [ ] Error (or at least warn) when both --name and --id are given rather than silently preferring --id.
- [ ] Validate <id> and --id as UUIDs before the request - exit 2.
- [ ] Change the table columns from tag_id to id.
- [ ] For the --id path, synthesize a payload ({action: 'tag_attached', kb_node_id, tag_id}) so json callers get something to read instead of a message string.
- [ ] Help: say the tag is created in the organization's shared library, that the call is additive, and that folders are rejected.

**`senso kb tags list`** · 🟠 medium

- [ ] Change the columns to ['id','name','curated'] so the table is not blank in its first column.
- [ ] Validate <id> as a UUID before the request - exit 2.
- [ ] Help: name the id space, say the returned `id` is the tag id for --ids/--id, and explain `curated`.
- [ ] Empty list: 'No tags on this node.' on stdout, and on stderr 'Auto-tagging runs after ingestion; check content.processing_status with senso kb get <id>.'
- [ ] Help: say a folder returns an empty list (it is not tagged), and point at the document nodes inside it.

**`senso kb tags remove`** · 🟠 medium

- [ ] Read the node's tags first (or compare the before/after set) and say which it was: 'Detached "refunds".' vs 'Node did not have the tag "refunds"; nothing changed.' Report it in the JSON payload as {action, changed: true|false}.
- [ ] Error when both --name and --id are given.
- [ ] Validate <id> and --id as UUIDs, and reject a blank --name, before the request - exit 2.
- [ ] Help: say the tag itself is not deleted, only the link; name 'senso tags delete' for the library.
- [ ] Help: point at 'kb tags set --clear' for removing everything at once.

**`senso kb tags set`** · 🔴 high

- [ ] Refuse 'kb tags set' with neither flag: exit 2 with 'Pass --names and/or --ids, or --clear to remove all tags.' Add an explicit --clear so clearing is deliberate.
- [ ] Validate --ids entries as UUIDs and <id> as a UUID before the request - exit 2.
- [ ] Change the columns from tag_id to id.
- [ ] Help: say this replaces the whole set across both flags, that unknown names are created in the shared library, and that folders are rejected.
- [ ] Warn on stderr when the node's processing_status is not complete that auto-tagging may still add tags.
- [ ] Report the difference on stderr: which tags were added and which removed.

**`senso kb update-file`** · 🔴 high

- [ ] Call assertFilesExist / assertFilesNotEmpty here, as 'kb upload' does - exit 2 with the file named.
- [ ] Validate <id> as a UUID, and reject .md/.markdown locally naming 'kb update-raw' - exit 2.
- [ ] Help: name both argument types and their sources, say it works only on nodes created by 'kb upload', list the accepted types and the 100MB cap, and give the poll command.
- [ ] Redact or drop upload_url from the emitted payload - it has already been used and it is a signed URL.
- [ ] Pass the 409 through with the hint 'The same bytes are already ingested or in flight. Check: senso kb get <id>'.
- [ ] Add a Next line on stderr with the poll command.
- [ ] Remove the unreachable 'else' branch, or make it exit non-zero.

**`senso kb update-raw`** · 🔴 high

- [ ] Help: say the payload's `id` is the content_id and kb_node_id is the one to keep using.
- [ ] Help: say ingestion restarts (processing_status returns to processing) and give the poll command.
- [ ] Help: say summary is also replaced - omitting it clears it - and that this works only on raw documents.
- [ ] Validate <id> as a UUID; validate --data locally: require non-empty title and text, name unknown keys, check tag_ids entries are UUIDs - exit 2.
- [ ] Pass the 409 and 402 through with their own hints.
- [ ] On a 500 after a successful content write, say so: 'The text was replaced but the tags were not.'
- [ ] Add a Next line on stderr with the poll command.

**`senso kb upload`** · 🔴 high

- [ ] Print the accepted files' kb_node_id on stdout in plain mode - the payload is what the caller needs and stdout is currently empty. At minimum, print the poll command per accepted file on stderr with the real id substituted.
- [ ] Help: list the accepted file types (PDF, DOC/DOCX, TXT, HTML, CSV, XLS/XLSX, PPT/PPTX, images) and say explicitly that .md/.markdown and .json/.xml are rejected, naming 'senso kb create-raw' for markdown.
- [ ] Help: name the four per-file statuses and what each means, and say the 100MB per-file limit.
- [ ] Validate the derived content_type locally against the API's accepted set - a file the API will certainly reject should exit 2 before any upload, naming the file and the reason.
- [ ] Validate --folder-id as a UUID before the request - exit 2.
- [ ] Exit non-zero (or at least emit a warnings array) on a PARTIAL failure, not only on a total one, so a script can tell 10/10 from 3/10.
- [ ] Add markdown_requires_raw_ingestion to the UploadResultItem status union and give it its own message naming 'senso kb create-raw'.

### `senso permissions` <sub>3 items</sub>

**`senso permissions`** · group

- [x] Group description: 'The catalog of permission keys a role can hold (the same for every org). Not your key's permissions — an org API key is not subject to them.'

**`senso permissions list`** · 🟢 low

- [x] Help: say the list is static and platform-wide, that no CLI command consumes a key, and what category means (the resource part of the key).
- [x] Table columns: key, category (name/description add nothing).

### `senso tags` <sub>25 items</sub>

**`senso tags`** · group

- [ ] Rewrite the group description in the §2.1 group shape: purpose, id spaces (tag `id` vs the resource ids kb_node_id/content_id/prompt_id), and an ordered workflow.
- [ ] Add a 'See also' line naming `senso kb tags`, `senso content tags`, `senso prompts tags` and `senso auto-tag` (the setting that governs whether tags are minted automatically).
- [ ] Say that `tags list` shows only curated tags by default and point at the new `--include-uncurated` flag.
- [ ] Add the cross-reference the other way round: a 'See also: senso tags list' line in the kb/content/prompts tags group descriptions.

**`senso tags create`** · 🟠 medium

- [ ] Validate --name before the request: non-empty after trim, ≤255 characters → exit 2 naming the flag and the length.
- [ ] Help: say the response's `id` is the tag id, that counts are not included, and that `senso kb tags attach <id> --name <name>` creates the tag implicitly.
- [ ] 409: prefix with what was attempted and add a runnable hint — `senso tags list | grep -i <name>`.
- [ ] Add Returns / Exit codes / Examples.

**`senso tags delete`** · 🟠 medium

- [ ] Validate <id> as a UUID → exit 2.
- [ ] Help: tell the agent to check the counts first (`senso tags get <id>`), and state plainly that the resources survive, only the label goes.
- [ ] JSON: emit `data: { action: "deleted", resource: "tag", id: "…" }`.
- [ ] 404: 'Tag <id> not found in this organization (it may already be deleted).' with hint `senso tags list`.

**`senso tags get`** · 🔴 high

- [ ] Validate <id> as a UUID → exit 2 with the received value and a pointer to `senso tags list`.
- [ ] Help: name the id space explicitly and say what it is NOT (kb_node_id / content_id / prompt_id).
- [ ] 404 message: 'Tag <id> not found in this organization.' with hint `senso tags list`.
- [ ] Help: enumerate the seven counts and what each one counts.

**`senso tags list`** · 🔴 high

- [ ] Fix the column list: `id, name, curated, prompt_count, content_count, created_at`. Do the same in kb.ts, content.ts and prompts.ts, and fix the MSW fixtures to use `id` so the policy test protects the real shape.
- [ ] Add `--include-uncurated` mapping to the API's include_uncurated=true.
- [ ] Help: list all seven count fields, explain `curated`, and state that the endpoint is unpaginated and returns every tag.
- [ ] Empty list: print 'No tags found.' on stdout and, on stderr, 'Auto-minted tags are hidden by default — retry with --include-uncurated.'
- [ ] Add Returns / Exit codes / Examples per §2.1.

**`senso tags update`** · 🟠 medium

- [ ] Validate <id> as a UUID and --name as 1–255 chars → exit 2.
- [ ] Help: name the id space; state that the rename is visible everywhere the tag is attached, immediately.
- [ ] 409 hint: name the collision and the manual merge path (`senso tags get <other-id>` then re-tag and `senso tags delete`).
- [ ] Help Returns: say counts are not in this response and point at `tags get`.

### `senso product-lines` <sub>27 items</sub>

**`senso product-lines`** · group

- [ ] Rewrite the group description in the §2.1 shape: purpose, the `product_line_id` id space, the GEO + read/update:product_line requirement, and an ordered workflow (list → create → generate with --product-line-ids).
- [ ] State what `details` actually becomes: flattened, per-leaf, into the evidence inventory as approved evidence for generated claims, keyed 'details.<path>'. Warn that anything untrue or stale in there is something the generator may assert.
- [ ] Add 'See also: senso generate --product-line-ids, senso brand-kit, senso content-types'.

**`senso product-lines create`** · 🔴 high

- [ ] Validate the --data shape before the request: require `name` (non-empty string ≤255 chars); require `details`, when present, to be a JSON object; name any unknown top-level keys in a warning. All exit 2.
- [ ] Help: document that `details` leaves become approved evidence for generation, and that key order is not preserved.
- [ ] Confirmation: '✓ Created product line <product_line_id>.' and a Next line pointing at `senso generate --product-line-ids <id>`.
- [ ] Help: state the GEO requirement, update:product_line, and the 409 on duplicate name.

**`senso product-lines delete`** · 🟠 medium

- [ ] Validate <id> as a UUID → exit 2.
- [ ] Help: say what else references a product_line_id (generate --product-line-ids, Builder workspace selections) so the agent knows what breaks.
- [ ] JSON: `data: { action: "deleted", resource: "product_line", id: "…" }`.
- [ ] 404: 'Product line <id> not found in this organization (it may already be deleted).' hint `senso product-lines list`.

**`senso product-lines get`** · 🟠 medium

- [ ] Validate <id> as a UUID → exit 2.
- [ ] Render `details` as an indented sub-block in plain, and in table fall back to a 'see --output json' note rather than a truncated blob.
- [ ] Help: name the id space, list the returned fields, state the GEO + read:product_line requirement.
- [ ] 404: 'Product line <id> not found in this organization.' hint `senso product-lines list`.

**`senso product-lines list`** · 🔴 high

- [ ] Validate --limit (integer ≥ 1) and --offset (integer ≥ 0) with parseIntFlag → exit 2 naming the flag and the value.
- [ ] Print the pagination line on stderr: 'Showing 1–50 of 50 on this page. Next page: senso product-lines list --offset 50' and say plainly that `total` is the page size, not the org total.
- [ ] Render `details` as an indented sub-block in plain output.
- [ ] Help: name the GEO requirement and the read:product_line permission, and say that `details` is truncated out of the table on purpose.

**`senso product-lines patch`** · 🔴 high

- [ ] Fix the help: state that `details` is REPLACED, not merged, and change the example to show the full blob. Add the merge recipe: `senso product-lines get <id> --output json | jq '.data.details + {price_usd:129}'`.
- [ ] Validate --data client-side: at least one of name/details; `details` must be an object; `name` non-empty ≤255. All exit 2.
- [ ] Validate <id> as a UUID → exit 2.
- [ ] Change the confirmation to '✓ Patched product line <id> (fields: details).' so it differs from `update`.

**`senso product-lines update`** · 🔴 high

- [ ] Refuse a --data without `details` (exit 2) with the message that PUT resets it to {}, and point at `product-lines patch` — or require an explicit `--data '{"name":"…","details":{}}'` to clear it.
- [ ] Validate <id> as a UUID and `name` as a non-empty ≤255-char string → exit 2.
- [ ] Emit a warning when the new `details` is {} and the previous value was not, e.g. warnings: ['details was replaced with {} — 4 evidence fields removed'] (requires a GET first, or at minimum a static warning when details is absent).
- [ ] Help: add the 409, the GEO requirement, and the sorted-keys note.

### `senso roles` <sub>4 items</sub>

**`senso roles`** · group

- [x] Add 'See also: senso permissions list' and note that roles cannot be created or edited over the API.

**`senso roles list`** · 🟢 low

- [x] Table columns: role_id, name, is_system, description.
- [x] Help: Returns section; say is_system marks the built-ins; say to ignore rows with deleted_at; mention that permission keys per role are not exposed (senso permissions list shows the universe).
- [x] Plain: numbered blocks, role_id first.

### `senso competitors` <sub>32 items</sub>

**`senso competitors`** · group

- [ ] State the 50-per-org cap in the group description and distinguish it from the 50-items-per-request batch limit.
- [ ] Name the id space (`id` in the payload, passed as <competitorId>) and the permission split (read is open, writes need update:org).
- [ ] Add the ordered workflow: suggest → filter already_tracked → batch-add → list.
- [ ] Add 'See also: senso analytics share-of-voice' (or whichever analytics command consumes this) so the agent knows why the list matters.

**`senso competitors add`** · 🔴 high

- [ ] Validate --name (non-empty after trim, ≤255) and --url (parses as an absolute http/https URL, ≤2048) before the request → exit 2 naming the flag and, for the URL, showing the corrected form.
- [ ] Help: state the 50-per-org cap, that `source` is always 'manual' here, and that adding a name that already exists is a 409, not an upsert.
- [ ] Map a 500 whose message is 'Failed to perform competitor operation' on this endpoint to a cap-specific hint — or better, have the API fix the status (see api_changes) and key off that.
- [ ] Confirmation: '✓ Added competitor <id> ("Acme Analytics").' plus a Next line for `competitors list`.
- [ ] 409 hint: `senso competitors list --output json | jq '.data.competitors[] | select(.name=="…")'`.

**`senso competitors batch-add`** · 🔴 high

- [ ] Validate --data before the request: `items` present, an array, 1–50 entries; each item has a non-empty `name` ≤255; `source` in the enum; `confidence` a number 0–1; `rationale` ≤280 characters; unknown keys named. Exit 2, and report the item INDEX in the message.
- [ ] Compare the request against the response and emit warnings: items not present in the response (truncated by the cap or skipped for a blank name), and items whose returned created_at predates this call (already tracked).
- [ ] Confirmation: '✓ Added N competitors (M were already tracked, K skipped).'
- [ ] Help: separate the two 50s, and document the 280-character rationale cap with a jq recipe that truncates suggest output to fit.
- [ ] Map the cap 500 to the same explanatory message as `competitors add`.

**`senso competitors delete`** · 🟠 medium

- [ ] Validate <competitorId> as a UUID → exit 2.
- [ ] JSON: `data: { action: "deleted", resource: "competitor", id: "…" }`.
- [ ] Help: mention the 50-per-org cap this frees a slot in, and that the row is soft-deleted (it disappears from every list and from analytics queries).
- [ ] 404: 'Competitor <id> not found in this organization (it may already be removed).' hint `senso competitors list`.

**`senso competitors list`** · 🔴 high

- [ ] Fix the columns to `id, name, url, source, confidence, created_at`, and fix the MSW fixtures so the tests protect the real field name.
- [ ] Help: define the three `source` values, name `rationale`/`confidence`, and say the list is complete (no paging) and capped at 50 per org.
- [ ] Empty list: 'No tracked competitors found.' on stdout, and on stderr 'Ask for candidates with `senso competitors suggest`.'
- [ ] Add Returns / Exit codes / Examples.

**`senso competitors suggest`** · 🔴 high

- [ ] Supply a hand-written `plain` and `table` rendering (EmitOptions.table.rows = data.suggestions) so the columns actually apply. Columns: name, confidence, already_tracked, source, url. Print `mode`, `cached` and `duration_ms` on stderr as context.
- [ ] Help: document mode, already_tracked, sampled_run_ids, the 5-per-hour rate limit, the 10-minute cache, and that the call costs model tokens.
- [ ] 429: replace the generic message with 'Competitor suggestions are limited to 5 per hour for this organization. The last result is cached for 10 minutes — retry then.'
- [ ] 422: hint 'Set a website with `senso org update --website https://…`, or run prompts first (`senso prompts run …`).'
- [ ] 503: say the feature is not enabled on this deployment rather than 'API error (503)'.
- [ ] Emit next steps: the exact `competitors batch-add` pipeline that filters already_tracked and truncates rationale to 280 characters.

**`senso competitors update`** · 🔴 high

- [ ] Fix the semantics or the help. Either send `url` only when --url is given and document that the API clears it (the API cannot express 'leave alone'), or — better — require the agent to opt in: add --clear-url, and when --url is absent, refuse with exit 2 explaining that PUT would clear it.
- [ ] Validate <competitorId> as a UUID, --name (non-empty ≤255) and --url (absolute URL ≤2048) → exit 2.
- [ ] Confirmation: name what changed, and warn 'url cleared' when the request omits it.
- [ ] Help: say provenance fields are preserved; name the 409 and the 404 semantics (another org's competitor reads as not found).

### `senso tracked-sources` <sub>24 items</sub>

**`senso tracked-sources`** · group

- [ ] Rewrite in the §2.1 group shape with the id space (`id`, passed as <sourceId>), the update:org requirement on mutations (reads are ungated), and an ordered workflow.
- [ ] State all three source_origin values and exactly what each allows: manual and onboarding are fully editable and deletable; published can only be activated/deactivated and cannot be deleted.
- [ ] Warn that a PUT on a published rule silently ignores everything but --active, and that the CLI will refuse it client-side once source_origin is known.
- [ ] Say that mutations kick off an async rollup recalc, so analytics lag a rule change by minutes.

**`senso tracked-sources add`** · 🔴 high

- [ ] Validate --category with parseEnumFlag against the four values → exit 2, the same way --match-type and --tier already are.
- [ ] Refuse --category with a tier other than `tracked` → exit 2, saying the API would discard it.
- [ ] Validate client-side that --match-type path_prefix/exact_url has a pattern containing a path → exit 2.
- [ ] Help: document normalization (and show the normalized value in the confirmation), tier meanings, the specificity-then-priority resolution order, and the async recalc.
- [ ] 409 hint: `senso tracked-sources list --search <pattern>`.

**`senso tracked-sources delete`** · 🔴 high

- [ ] Validate <sourceId> as a UUID → exit 2.
- [ ] On the 409, print the ready-made deactivate command with the rule's own pattern/match_type/tier filled in (the CLI can fetch the row from the list first, or from the search endpoint).
- [ ] Help: name the published-rule refusal on this command, not only in the group description, and say the delete triggers a rollup recalc.
- [ ] JSON: `data: { action: "deleted", resource: "tracked_source", id: "…" }`.
- [ ] 404: 'Tracked source <id> not found in this organization (it may already be removed).' hint `senso tracked-sources list`.

**`senso tracked-sources list`** · 🔴 high

- [ ] Add --limit (1–100, default 50), --offset (≥0) and --search, validated client-side with parseIntFlag → exit 2, matching the API's own bounds.
- [ ] Fix the columns to `id, pattern, match_type, tier, source_origin, active, priority`, and fix the MSW fixtures to use `id`.
- [ ] Print the paging line on stderr: 'Showing 1–50 of 312. Next page: senso tracked-sources list --offset 50' — the data for it is already in the response.
- [ ] Help: explain source_origin, tier, match_type and the specificity/priority resolution order.
- [ ] Empty list: 'No tracked source rules found.' plus 'Every citation is classified External until you add a rule: senso tracked-sources add --pattern <your-domain> --match-type domain --tier primary'.

**`senso tracked-sources update`** · 🔴 high

- [ ] Fetch the rule first (or read source_origin from a prior list) and refuse a published rule with anything other than --active/--no-active → exit 2, explaining that the API would accept it and do nothing.
- [ ] Add a dedicated `tracked-sources deactivate <sourceId>` / `activate <sourceId>` pair, or make --pattern/--match-type/--tier optional when only --active/--no-active is given.
- [ ] Help: spell out the omission semantics of every optional flag — which ones clear and which ones preserve.
- [ ] Validate --category with parseEnumFlag, and validate <sourceId> as a UUID → exit 2.
- [ ] Warn on stderr when the response's pattern/tier differs from what was sent, and when a recalc was queued.

### `senso generated-content` <sub>12 items</sub>

**`senso generated-content`** · group

- [ ] Group help: state that content_id here is the same id space as `senso content` and `senso engine`, and say when to prefer `content verification` (owners, tags, destinations, publish_record_id, citation metrics) over `generated-content list` (title, question_text, editorial_status only).
- [ ] Add the workflow: engine draft -> generated-content list --status drafts -> engine publish -> generated-content list --status published.

**`senso generated-content get`** · 🟠 medium

- [ ] Validate <id> as a UUID -> exit 2.
- [ ] Help: say knowledge-base content is rejected and point at `senso kb content <kb_node_id>`; name `senso content get` for tags and provenance.
- [ ] Document the response keys, especially `text` as the markdown body and `question_text` as possibly empty.
- [ ] 404: "Generated content <id> not found in organization <slug>." hint `senso generated-content list --status drafts`.
- [ ] Add next-step hints: `senso engine publish --data '{"content_id": ...}'` for a draft, `senso content citation-details <id>` for a published item.

**`senso generated-content list`** · 🔴 high

- [ ] Fix the columns: ["content_id", "title", "editorial_status", "generated_at"].
- [ ] Validate --limit (1..100) and --offset (>= 0) with parseIntFlag -> exit 2, since the API silently falls back to 10 rather than clamping.
- [ ] Show `Showing 1-10 of 42. Next page: senso generated-content list --offset 10` on stderr.
- [ ] Empty result: `No generated content found.` plus a stderr hint to try the other --status value and `senso engine draft`.
- [ ] Help: document the returned fields, especially content_id (feeds engine publish / content get) and version_id (feeds content reject / restore).

### `senso analytics` <sub>45 items</sub>

**`senso analytics`** · group

- [ ] Group help: add 'Requires the GEO product and read:prompt. Dates are YYYY-MM-DD (not the RFC 3339 instants `senso evals` takes). Windows up to 365 days.'
- [ ] Group help: add the id-space note and an ordered workflow list.
- [ ] Map the two 403 texts to distinct messages: product 403 -> 'analytics needs the GEO product' with hint to contact the account owner; permission 403 -> name read:prompt.

**`senso analytics answers`** · 🟠 medium

- [ ] Plain: full text, citations with tier, competitor_mentions; prompt_id on the first line.
- [ ] Paging line on stderr + JSON page{}.
- [ ] Validate --limit/--offset, --from/--to, --models (exit 2).
- [ ] Help: Returns block with enum values; Exit codes; Examples.

**`senso analytics citations`** · 🟠 medium

- [ ] Shared date/model validation (exit 2); guard totals/metrics.
- [ ] Plain per bucket: append 'shares owned a% / tracked b% / external c%'.
- [ ] Help: Returns block stating rate vs share semantics; Exit codes; Examples.

**`senso analytics domains`** · 🟠 medium

- [ ] parseIntFlag --limit {min:1,max:100} and --offset {min:0} -> exit 2 (industries.ts already does this).
- [ ] Print the next page on stderr: 'Showing 1–50 of 213. Next page: senso analytics domains --offset 50'; in JSON add page:{offset,limit,returned,total,has_more,next}.
- [ ] Shared date/model validation.
- [ ] Help: Returns (fields + tier values), Exit codes, Examples, See also.

**`senso analytics filters`** · 🔴 high

- [ ] Plain/table: print model ids, with the display name in parentheses: '--models chatgpt (ChatGPT), gemini (Gemini), aioverview (Google AI Overviews)'.
- [ ] Print 'Tracked competitors' with ids and point at `senso competitors list`.
- [ ] Add a line 'All model ids: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok' (or fetch it if the API publishes it).
- [ ] Help: Returns, Exit codes, Examples (`--output json | jq -r '.data.models[].id'`).

**`senso analytics glossary`** · 🟢 low

- [ ] Table: add gotcha as a column (or fold it into definition).
- [ ] Help: Returns (fields), Exit codes, Examples; note that it is static.
- [ ] Consider embedding the glossary in the CLI as an offline fallback so `senso analytics glossary --offline` works with no key / no GEO (source of truth stays the API).

**`senso analytics mentions`** · 🟠 medium

- [ ] Render the SoV denominator per bucket: 'SoV 16.1% (36/224)'.
- [ ] Shared date/model validation from filters.ts (exit 2).
- [ ] Guard data.metrics/data.totals; throw CliError on an unexpected shape.
- [ ] Empty series: keep the stdout line, add stderr 'Data exists for 2026-03-02 → 2026-09-14 — run `senso analytics filters`'.
- [ ] Help: add Returns/Exit codes/Examples; note ISO weeks and additivity ('sum the counts across buckets, never average the rates').

**`senso analytics pages`** · 🟠 medium

- [ ] Plain: print the prompt_id beside each top prompt and do not truncate the text.
- [ ] Add the stderr next-page line and JSON page{} block.
- [ ] Validate --limit/--offset (exit 2); shared date/model validation.
- [ ] Help: Returns/Exit codes/Examples; say which follow-up takes prompt_id.

**`senso analytics prompt`** · 🔴 high

- [ ] Validate <promptId> as a UUID -> exit 2 with the id-space hint.
- [ ] 404: 'Prompt <id> not found in organization <slug>. Org prompt ids come from `senso analytics prompts`; industry prompt ids (`senso industries prompts`) are not accepted here.'
- [ ] Plain: full response_text, then citations (url [tier]) and competitor_mentions per answer.
- [ ] Reuse addWindowOptions wording (defaults, max span, filters pointer); shared date/model validation; guard totals/metrics.
- [ ] Help: Arguments/Returns/Exit codes/Examples.

**`senso analytics prompts`** · 🟠 medium

- [ ] Plain: prompt_id first line, full text, denominators for SoV and owned citation rate.
- [ ] Add stderr paging line and JSON page{}.
- [ ] Validate --limit/--offset; shared date/model validation; guard data.metrics.
- [ ] Help: Returns block explaining latest vs window; Exit codes; Examples with --order asc.

**`senso analytics summary`** · 🔴 high

- [ ] Guard the renderer: if data.totals or data.metrics is missing, throw CliError('Unexpected response from /org/analytics/summary: missing totals/metrics', EXIT.ERROR, {code:'error', hint:'Re-run with SENSO_DEBUG=1 and report the payload.'}) instead of letting a TypeError escape.
- [ ] Validate --from/--to as YYYY-MM-DD, from <= to, span <= 365 days -> exit 2 before the request (shared in filters.ts so every windowed command gets it).
- [ ] Validate --models against the fixed id list (gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok) -> exit 2, hint `senso analytics filters --output json | jq -r '.models[].id'`.
- [ ] Distinguish the two 403 texts: product -> 'analytics needs the GEO product' with an account-owner hint; permission -> 'this key lacks read:prompt'.
- [ ] Help: add Returns (metrics, deltas semantics, data_quality levels), Exit codes, Examples, See also.
- [ ] JSON: wrap in the standard envelope {ok, command, data, next:[{why:'Find the prompts you are invisible on', command:'senso analytics prompts --order asc'}]}.

### `senso history-imports` <sub>16 items</sub>

**`senso history-imports`** · group

- [ ] Move the `completed` caveat into BOTH leaf commands' help and into the output of `get` (a stderr line whenever status is completed and historic_runs_imported is 0 or null).
- [ ] List the four statuses and say `failed` is not terminal (a failed job is retried and may return to running); the terminal-for-your-purposes test is completed with historic_runs_imported > 0.
- [ ] Say the group is read-only, that jobs are started only by `senso industries import-prompts`, and that both commands need the GEO product.
- [ ] Add the workflow to the group description.

**`senso history-imports get`** · 🔴 high

- [ ] Repeat the caveat in this command's help AND act on it in the output: when status is completed and historic_runs_imported is 0 or null, print on stderr 'Completed, but no historic runs were imported — the job matched no prompts. Check `senso prompts list`.'
- [ ] Print the state on stderr: for pending/running, 'Still importing. Poll again: senso history-imports get <id>'; for completed with runs > 0, '✓ Imported N historic runs across M prompts.'; for failed, 'This attempt failed; failed imports are retried automatically — poll again before giving up.'
- [ ] Validate <importId> as a UUID before the request; exit 2 with a hint naming both sources of the id.
- [ ] Render null prompts_count / historic_runs_imported as '(not yet known)' rather than blank.
- [ ] 404: 'History import <id> not found in this organization.' with hint `senso history-imports list`.
- [ ] Special-case 501 and 502 as in `list`.
- [ ] Add Returns / Exit codes / Examples, including the jq one-liner that polls correctly (status completed AND historic_runs_imported > 0).

**`senso history-imports list`** · 🟠 medium

- [ ] Empty result: print 'No history imports found.' on stdout and, on stderr, 'Imports are started by `senso industries import-prompts`.'
- [ ] Explain in the help why prompts_count and historic_runs_imported are in the default columns, and that they are null until the job completes.
- [ ] Special-case 501: 'History imports are not available on this Senso deployment.' with no retry hint and exit 1.
- [ ] Special-case 502: 'Senso could not reach the history-import ledger.' with hint 'Retry in a minute; the prompts themselves are unaffected.'
- [ ] Add Returns / Exit codes / Examples, and say that `error` is always a fixed sentence.

### `senso industries` <sub>46 items</sub>

**`senso industries`** · group

- [ ] Add an ordered workflow to the group description: 1) senso industries list, 2) senso org set-industry <industry_id> (once, if not already set), 3) senso industries prompts <industry>, 4) senso industries import-prompts <industry> --prompt-ids ..., 5) senso history-imports get <import_id>.
- [ ] Name the id spaces: industry_id (industries list) vs industry prompt id (industries prompts `id`) vs geo_question_id (the org prompt that import-prompts creates).
- [ ] State that every command except `list` requires the GEO product, and that reads also require read:prompt for `prompts`.
- [ ] State that a name <industry> resolves to the first search match, and tell the caller to pass a UUID when the name is ambiguous.
- [ ] State the shared window contract once: --from/--to are YYYY-MM-DD, default last 30 days, maximum span 90 days; --models is one of the documented model keys; --location is a 2-letter country code.

**`senso industries brand`** · 🔴 high

- [ ] Hand-written `plain` renderer: resolved identity block, then mentioned, then metrics as indented sub-lines, then by_model as numbered blocks, then notes — never inline JSON.
- [ ] When `mentioned` is false, print on stderr: 'Air Kanada was not named in this industry over 2026-08-01..2026-08-31. This is an answer, not an error. Check the spelling against `senso industries brands <industry>`.'
- [ ] Add to the help: a name the registry has not seen is created on first lookup (a write on a GET); prefer `brand-by-id` for repeat calls.
- [ ] Add Returns naming resolved.brand_id as the value to store and pass to brand-by-id, and explain matched_on / match_confidence / surface_forms.
- [ ] Validate --from/--to/--models before the request (exit 2), as in `industries brands`.
- [ ] Reject an empty/whitespace <brandName> with exit 2 rather than a 400.

**`senso industries brand-by-id`** · 🟠 medium

- [ ] Validate <brandId> as a UUID before the request; exit 2 with the hint `senso industries brands <industry>` and an explicit 'brand_key is not a brand_id'.
- [ ] Share the hand-written plain renderer with `industries brand`.
- [ ] Help: document the merge/self-heal behavior — always write back resolved.brand_id.
- [ ] Distinguish the two 404s by the request path so the message can name either the industry or the brand.
- [ ] Validate --from/--to/--models before the request.

**`senso industries brands`** · 🔴 high

- [ ] Give the command a hand-written `plain` renderer (EmitOptions.plain) and a `table` override (EmitOptions.table) that pass `brands` as the rows and print window/totals as a header block — the generic findRows cannot classify this payload and never will.
- [ ] Validate --from/--to as YYYY-MM-DD, enforce from <= to and the 90-day span, and exit 2 before the request, mirroring evals' parseInstantFlag.
- [ ] Validate --models against the documented model keys and exit 2 listing them; document the keys in the flag help.
- [ ] Warn on stderr when --rollup parent is combined with --no-canonicalize, and add it to `warnings` in the JSON envelope.
- [ ] Add Returns / Exit codes / Examples, including the share-of-voice formula with the field names.

**`senso industries domain`** · 🟠 medium

- [ ] Help: state plainly that --url overrides <domain>; better, warn on stderr and add a `warnings` entry when both are given and they disagree.
- [ ] Hand-written plain renderer: resolved block, cited, citation_references, rank_in_industry, share_of_citations, then co_mentioned_brands as numbered rows.
- [ ] On cited=false, stderr: 'aircanada.com was not cited in this industry over 2026-08-01..2026-08-31. Check the window, or list the domains that were cited.'
- [ ] Add Returns naming the ownership values and warning that citation_references counts occurrences.
- [ ] Validate --from/--to/--models before the request.

**`senso industries import-prompts`** · 🔴 high

- [ ] Hand-written plain output: a summary line (created N, skipped M), then outcomes as numbered blocks, then defaults_seeded as a named list of what activation wrote, then history_import with the poll command spelled out.
- [ ] Always print the poll command on stderr when import_id is present: 'Next: senso history-imports get <import_id>' — and when history_import.status is `skipped`, print the reason plus 'Re-run this command to retry the history import; the prompts are already copied.'
- [ ] Add `next` to the JSON envelope carrying the same poll command, and `warnings` for every skipped outcome and for `skipped` history imports.
- [ ] 403 'Industry does not match the organization's industry': message 'Industry <id> is not your organization's industry, so its prompts cannot be imported.' hint '`senso org get` shows your industry_id; `senso org set-industry` sets it (once).'
- [ ] 403 'Organization has no industry set': hint 'Run `senso org set-industry <industry_id>` first — pick one from `senso industries list`.'
- [ ] 403 from RequireProduct: name GEO, as elsewhere in the group.
- [ ] Prefix the 400 rejections: 'Could not import industry prompts: <API message>' with hint '`senso industries prompts <industry>` lists the active ids this accepts.'
- [ ] Restructure the help per §2.1 and put the ACTIVATES warning on its own line near the top.

**`senso industries list`** · 🟠 medium

- [ ] Add Returns / Exit codes / Examples to the help; say industry_id is the <industry> argument everywhere else and the argument to `senso org set-industry`.
- [ ] Say model_count 0 = never run = no history to import, active_prompt_count 0 = nothing to import.
- [ ] Say the catalog is public industries only.
- [ ] Print a pagination footer on stderr: 'Showing 1-50 of 212. Next page: senso industries list --offset 50'.
- [ ] Print 'No industries found.' on stdout plus, on stderr, 'Your --search matched nothing; drop it to see the whole catalog.' when the list is empty.
- [ ] Add `page` to the JSON envelope (offset/limit/returned/total/has_more/next).

**`senso industries prompts`** · 🟠 medium

- [ ] Add Returns / Exit codes / Examples; name the id space explicitly ('id' is an industry prompt id, not a geo_question_id) and list the funnel_stage values the API emits.
- [ ] Validate a UUID-shaped <industry> before the request and exit 2 with the catalog command as the hint.
- [ ] 403 on GEO: 'Your organization does not have the GEO product, which `senso industries prompts` requires.' hint 'Contact your Senso account owner to add GEO; `senso org get` shows what your org has.'
- [ ] 404: 'Industry <id> not found, or it is a private industry your organization cannot read.' hint 'senso industries list'.
- [ ] Pagination footer on stderr plus `page` in the JSON envelope.
- [ ] Next-step line on stderr: 'Next: senso industries import-prompts <industry> --prompt-ids <id>,<id>'.

### `senso partner` <sub>41 items</sub>

**`senso partner`** · group

- [ ] Say exactly what happens: 'An organization key returns HTTP 401 Authentication required from the partner auth middleware. Logging in again will not help — `senso login` stores an organization key.'
- [ ] Say how to pass a partner key: `senso partner ... --api-key <partner-key>` or `SENSO_API_KEY=<partner-key> senso partner ...`, and that it is never stored.
- [ ] Add the explicit org-key equivalence table to the group help.
- [ ] Note which two commands have no org-key equivalent (summary, prompt-metrics) and that glossary is partner-only.
- [ ] State the shared window contract (YYYY-MM-DD, --models allow-list, --location) once here, as for `industries`.

**`senso partner industries`** · group

- [ ] Correct the scope sentence: `list` shows what this partner owns or subscribes to; the CI reads accept any industry that exists, so an industry_id from elsewhere will work even though `list` does not show it.
- [ ] Say the leaderboard is `senso industries brands` (org key) — there is no partner leaderboard command here.
- [ ] Name the id spaces and state the shared window contract.

**`senso partner glossary`** · 🟠 medium

- [ ] Add `gotcha` to the declared columns, or better, give this command a hand-written plain renderer: metric, then definition, denominator and gotcha as indented lines.
- [ ] Mirror the glossary under an org-key-reachable command (for example `senso industries glossary`, or a --glossary flag on the CI reads) so the definitions reach the callers who see the numbers. If no org route exists, ship the eight entries in the CLI and serve them locally — they are static content in the API too.
- [ ] Add Returns / Exit codes / Examples, and list the eight metric keys in the help so an agent can look one up without calling.
- [ ] Warn on stderr under --output table that definitions are truncated, and suggest plain or json.

**`senso partner industries brand`** · 🟠 medium

- [ ] Share the hand-written plain renderer with `senso industries brand`.
- [ ] Add a `partner industries brand-by-id <industry> <brandId>` command wrapping GET /partner/industries/:id/brands-by-id/:brand_id, and point at it from here — the endpoint exists and the CLI does not expose it.
- [ ] Help: warn that a never-seen brand name is added to the registry on first lookup; explain matched_on / match_confidence / surface_forms.
- [ ] On mentioned=false, explain on stderr that it is an answer, not an error.
- [ ] Validate <brandName> (non-empty), --from/--to and --models before the request; exit 2.
- [ ] State the window default and the 90-day cap in the flag help.

**`senso partner industries domain`** · 🟠 medium

- [ ] Either add --url (sending ?url=) as in `senso industries domain`, or rename the argument to <domain> and say a URL is not accepted. Silently treating a URL as a domain is the worst of the three options.
- [ ] Hand-written plain renderer: resolved block, cited, counts, then co_mentioned_brands as numbered rows.
- [ ] On cited=false, explain on stderr that it is an answer and suggest widening the window.
- [ ] Document the ownership values and that citation_references counts occurrences.
- [ ] Validate --from/--to and --models before the request; state the default window and the 90-day cap.
- [ ] Consider adding `partner industries citations` for GET /partner/industries/:id/citations so a caller can discover domains.

**`senso partner industries list`** · 🔴 high

- [ ] Add --limit (1-100, default 10, validated) and --offset (>= 0, validated) and pass them through; without them the command cannot return more than 10 rows.
- [ ] Add relationship, model_count and location_count to the default columns.
- [ ] Say what 'visible' means in the description: owned plus subscribed.
- [ ] Split the partner-auth hint: one runnable hint ('Retry with a partner key: senso partner industries list --api-key <partner-key>') and move the `senso industries` / `senso analytics` alternatives into the message body or a `next` block.
- [ ] Add a pagination footer and `page` to the JSON envelope.

**`senso partner industries prompt-metrics`** · 🔴 high

- [ ] Hand-written plain/table renderer that uses industry_prompts as the rows and prints window/total as a header — the generic renderer cannot classify this payload.
- [ ] Validate --limit (1-100) and --offset (>= 0) with parseIntFlag and exit 2, matching every other paged command in the CLI.
- [ ] Add --group-by funnel_stage (parseEnumFlag over a one-value set) to expose the stage rollup, and describe the different payload it returns.
- [ ] Say in the help that a nonexistent industry_id returns an EMPTY list rather than a 404, and tell the caller to confirm the id with `senso partner industries list`.
- [ ] Add Returns naming industry_prompt_id as an industry prompt id (not a geo_question_id), and describing models[] and top_three_mentioned[].
- [ ] Validate --from/--to and --models before the request.
- [ ] Print a pagination footer and `page` in the JSON envelope; add a warning when the result is empty ('either this industry has no prompts in the window, or the industry_id does not exist — this endpoint does not 404').

**`senso partner industries summary`** · 🟠 medium

- [ ] Hand-written plain renderer with named sections: industry, window, answers_analyzed, top brand, citation summary, top external citers as numbered rows.
- [ ] Render a null share as '(not available — the official-domain registry is not seeded for this industry)', never as blank.
- [ ] Validate --from/--to (format, order, 90-day span) and --models before the request; exit 2.
- [ ] Document the defaults (last 30 days) and the 90-day cap in the flag help, matching the `industries` group wording.
- [ ] Add Returns / Exit codes / Examples and a pointer to `senso partner glossary`.

### `senso update` <sub>4 items</sub>

**`senso update`** · 🟠 medium

- [x] Capture npm's output and relay it to stderr (log.raw) instead of stdio: 'inherit', so stdout stays the payload.
- [x] Install the exact version reported (`@<latest>`), and after the install verify process.argv[1] is under npm's global root, else exit 1 with the path.
- [x] Network failure message: name the host and the timeout; keep exit 5.
- [x] Help per §2.1.

### `senso uninstall` <sub>6 items</sub>

**`senso uninstall`** · 🟠 medium

- [x] Capture npm's output and relay it to stderr; keep stdout for the payload.
- [x] Check runningBinaryPath() before removing anything and surface it in --dry-run (cli.path, cli.npmGlobal: bool); refuse up front (exit 1) with nothing removed when the running copy is not npm's.
- [x] Treat shipables 'not installed' for a recorded skill as skipped (reason 'files already gone'), not as a failure that aborts.
- [x] Canceled prompt: exit 0 with nothing on stdout; 'Uninstall canceled' on stderr; under json emit {canceled: true}.
- [x] Gate the SENSO_API_KEY warning on !quiet and put it in warnings[] in the envelope.
- [x] Help per §2.1 with the ordered steps and Exit codes.

---

## Part E — Per-command changes in `senso-api`

323 items across 170 commands. These are the things the CLI cannot fix alone.

### `senso global` <sub>2 items</sub>

**`senso --output json envelope`** · 🔴 high

- [ ] Use one list envelope ({items, total, limit, offset}) everywhere (per-group reviewers record the exceptions).

**`senso error reporting (reportError/toCliError)`** · 🔴 high

- [ ] 403 middleware messages should name the permission or product; 404 bodies should name the resource type; 409 bodies keep existing_content_id (per-group reviewers to confirm).

### `senso auth` <sub>1 items</sub>

**`senso whoami`** · 🟠 medium — `GET /org/me`

- [ ] /org/me does not report the API key's own permissions or shared-KB scope; a `me`-style field (key name, permissions[], kb_scope_configured) would let whoami warn before a search 403s with 'No KB scope configured'.

### `senso org` <sub>6 items</sub>

**`senso org get`** · 🟠 medium — `GET /org/me`

- [ ] Consider always emitting websites/locations/models as [] rather than omitting them (omitempty) so a client can distinguish 'none' from 'field missing'.

**`senso org set-industry`** · 🟠 medium — `PUT /org/me/industry`

- [ ] A malformed industry_id should be a field validation error ({field: industry_id, message: 'Invalid UUID format'}) rather than 'Invalid request payload'.

**`senso org set-runs`** · 🟢 low — `PATCH /org/me/runs-enabled`

- [ ] Fix the stale router comment ('Requires JWT') or add the guard deliberately and tell the CLI.

**`senso org update`** · 🔴 high — `PUT /org/me`

- [ ] Reject unknown keys in UpdateOrgSelfRequest (DisallowUnknownFields) or at least org_website_id/org_location_id inside entries, instead of dropping them silently.
- [ ] Validation error field should be the JSON path (websites[0].url) and the message should name the rule ('Must be a valid URL', 'Must be exactly 2 characters') — getErrorMessage falls to 'Invalid value' for url and len tags.
- [ ] Use iso3166_1_alpha2 for country_code as the admin variant already does.

### `senso users` <sub>6 items</sub>

**`senso users add`** · 🟠 medium — `POST /org/users`

- [ ] Malformed UUID should produce a field validation error naming user_id/role_id, not 'Invalid request payload'.

**`senso users invite`** · 🟠 medium — `POST /org/users/invite`

- [ ] Document whether an invitation email is sent. Clarify whether /invite is meant to reject existing users (help says so; handler does not).

**`senso users list`** · 🟠 medium — `GET /org/users`

- [ ] Return a list envelope {items, total, limit, offset} instead of a bare array (the api-keys and members endpoints already do), and include email/role name or document that clients should use /org/members.
- [ ] Reject an invalid limit/offset with 400 rather than silently substituting defaults.

**`senso users remove`** · 🟢 low — `DELETE /org/users/{userId}`

- [ ] Refuse to remove the last admin membership (409) rather than allowing an org with no admin.

**`senso users update`** · 🟠 medium — `PUT /org/users/{userId}`

- [ ] Allow is_current-only updates (role_id optional) or document that role_id is mandatory.

### `senso api-keys` <sub>4 items</sub>

**`senso api-keys create`** · 🔴 high — `POST /org/api-keys`

- [ ] None required. If the product wants agents to mint keys, the API would need a policy for API-key-authenticated creation (e.g. an admin key may create scoped keys) — currently ruled out by design (router.go comment: a key must not be able to modify itself or any other key).

**`senso api-keys get`** · 🟠 medium — `GET /org/api-keys/{keyId}`

- [ ] Emit nullable timestamps as null rather than omitting them.

**`senso api-keys kb-permissions-get`** · 🟠 medium — `GET /org/api-keys/{keyId}/kb-permissions`

- [ ] Return 404 for an unknown key id instead of [] so unscoped and unknown are distinguishable.

**`senso api-keys list`** · 🟠 medium — `GET /org/api-keys`

- [ ] Emit expires_at/revoked_at/last_used_at as null rather than omitting them.

### `senso search` <sub>10 items</sub>

**`senso search <query>`** · 🔴 high — `POST /org/search`

- [ ] Return 402 (not 403) for "Insufficient Credits for action" and "Insufficient Spending Limit for action" on all five search endpoints, matching /org/kb/upload; a 403 tells clients to fix permissions.
- [ ] "Failed to check balance for action" is a server-side failure and should be 500 or 503, not 403.
- [ ] Reject max_results outside 1-20 with a 400 naming the field instead of clamping silently, so a client that forgets to validate still learns the bound.
- [ ] Say in the response whether the turn was filed as a gap (e.g. gap_eligible: true/false), so a client can tell the user without re-deriving the projection rules.
- [ ] A content_ids entry that is not a UUID answers a generic "Invalid request body"; name the field.

**`senso search content`** · 🔴 high — `POST /org/search/content`

- [ ] Same 402/400 asks as `search`.
- [ ] The envelope keys differ from the sibling endpoints (contents/total vs results/total_results); aligning on results/total_results, or documenting the difference in the spec, would stop clients from special-casing this variant.

**`senso search context`** · 🟠 medium — `POST /org/search/context`

- [ ] Same as `search`: 402 for credit refusals; 400 naming max_results/content_ids instead of clamping or 'Invalid request body'.

**`senso search full`** · 🔴 high — `POST /org/search/full`

- [ ] Same as `search` (402 for credits; 400 naming the field instead of clamping).

**`senso search stream`** · 🟠 medium — `POST /org/search/stream (text/event-stream)`

- [ ] Same as `search`. Also: the `sources` event does not carry `query`; the CLI has to echo it from the input.

### `senso ingest` <sub>6 items</sub>

**`senso ingest reprocess`** · 🟠 medium — `PUT /org/kb/nodes/{id}/file (then one PUT to the presigned upload_url)`

- [ ] UpdateFile returns 500 'Failed to ingest content.' for validateFile errors other than markdown (unsupported content type, >100 MB, Word lock file) because IngestFileContentUpdate returns them unwrapped and the handler matches only ErrKBNodeInvalid/ErrFileAlreadyProcessing/ErrMarkdownRequiresRawIngestion. They should be 400 with the validation message, as UploadFiles reports them per item.
- [ ] 'Invalid node ID' for a non-UUID should be a field-level validation error (400 is right; the field is not named).

**`senso ingest upload`** · 🔴 high — `POST /org/kb/upload (then one PUT per file to the presigned upload_url)`

- [ ] kb_folder_node_id that is not a UUID answers 'Invalid request payload' without naming the field; return a field-level validation error.
- [ ] A batch whose only accepted-then-conflicting files are all conflicts commits and returns nil from the transaction (ingestion_service.go:513 FIXME) — confirm the 422 path still carries results.
- [ ] Document markdown_requires_raw_ingestion in the spec's status enum; the SDK spec lists only upload_pending/conflict/duplicate/invalid.
- [ ] Consider accepting application/json and application/xml, or state in the spec that they are unsupported.

### `senso website-import` <sub>3 items</sub>

**`senso website-import start`** · 🟠 medium — `POST /org/website-import (202), then GET /org/website-import/status every 2 s for up to 180 s`

- [ ] The 409 and 422 bodies extend the standard envelope (current / error_code); document both in the SDK spec so clients keep the fields.
- [ ] Return error_code on the 503 as well (FEATURE_UNAVAILABLE exists in the enum but is only set on runs).

**`senso website-import status`** · 🟢 low — `GET /org/website-import/status`

- [ ] A read gated on update:brand_kit means a key that can only read cannot poll an import someone else started; consider gating GET /status on a read permission.

### `senso content` <sub>37 items</sub>

**`senso content citation-details`** · 🔴 high — `GET /org/content/{id}/citation-details`

- [ ] supportedRunModelsList in the 400 message omits three values the allow-list accepts (google_ai_overviews, claude, gpt), so the error tells the caller the wrong set.
- [ ] `locations` has no allow-list, so an unknown location silently returns an empty result instead of 400.
- [ ] The response mixes the resource (content_id, title, summary) with two lists (destinations, trend), which defeats generic list detection in any client.

**`senso content citation-prompts`** · 🟠 medium — `GET /org/content/{id}/citation-prompts`

- [ ] `destinations` silently ignores unknown publisher slugs; echo back the slugs actually applied, or 400 on an unknown one.
- [ ] The response mixes the resource (content_id, date_range, models, external_urls) with the `prompts` list, which no generic list renderer can detect.
- [ ] The models 400 message lists only 8 of the 11 accepted values.

**`senso content delete`** · 🔴 high — `DELETE /org/content/{id}`

- [ ] ErrKBContentNotAllowed is returned as 400 in two different places with two different capitalizations of the same sentence; make it one message with a stable code.
- [ ] A 502 after the external delete has partially run leaves the caller unable to tell what was deleted; return which destinations succeeded.

**`senso content get`** · 🔴 high — `GET /org/content/{id}`

- [ ] Rejecting a whole category of id with a bare 400 and no machine-readable code is the core problem. Either add a stable code (e.g. {"code":"kb_content_not_allowed"}) to the error body, or return the KB node id so a caller can follow the redirect itself.
- [ ] "Invalid content ID" (malformed UUID) and "Knowledge base content must be accessed through KB node endpoints" (valid id, wrong kind) share status 400 and are indistinguishable without string matching.
- [ ] Also worth fixing in the skills repo: senso-ingest and senso-search instruct agents to call an endpoint that cannot serve KB content.

**`senso content list`** · 🔴 high — `GET /org/kb/my-files`

- [ ] GET /org/kb/my-files silently clamps limit to 50 and silently substitutes defaults for unparseable limit/offset. Return 400 naming the parameter and the accepted range instead.
- [ ] The envelope uses `nodes` rather than `items`, which the generic list renderer has to special-case.

**`senso content owners`** · 🟢 low — `GET /org/content/{id}/owners`

- [ ] The endpoint returns a bare array with no count and no envelope, unlike every other list in this group. Harmless for the CLI, but inconsistent.

**`senso content provenance`** · 🔴 high — `GET /org/content/provenance?published_url={url}`

- [ ] The URL lookup is an exact string match with no normalization; normalize scheme, host case and trailing slash server-side, or return the near-miss candidates in the 404 body.
- [ ] The 404 message "published content provenance not found" does not echo the URL that was searched for.

**`senso content record-edits`** · 🔴 high — `POST /org/content/{id}/edit-events/bulk`

- [ ] The handler drops insertedCount/duplicateCount on the error path even though the service returns them. Return them in the error body so a caller knows where the batch stopped.
- [ ] The batch is not transactional; either wrap it in one, or return the index of the failing event.
- [ ] Invalid event_type / edit_source are 400s with a free-text message and no field name - RespondWithValidationErrors with the allowed set would let a client correct it without string matching.

**`senso content reject`** · 🔴 high — `POST /org/content/versions/{versionId}/reject`

- [ ] POST .../reject accepts any version in any state, including published, with no conflict response. If rejecting a live version is meaningless, return 409; if it is meaningful, say what it does to the publish records.
- [ ] The 404 message "Content version not found" is the same for a wrong id and a cross-org id, and does not distinguish being handed a content_id.

**`senso content remove-owner`** · 🟠 medium — `DELETE /org/content/{id}/owners/{userId}`

- [ ] Removing a non-owner returns 204, indistinguishable from a real removal. Either return the resulting owner list, or 404 when the owner row did not exist.

**`senso content restore`** · 🟠 medium — `POST /org/content/versions/{versionId}/restore`

- [ ] POST .../restore does not check the current editorial status. Restoring a live version to draft while its publish records stay live is an inconsistent state; return 409, or unpublish as part of the call.

**`senso content set-owners`** · 🟠 medium — `PUT /org/content/{id}/owners`

- [ ] "Invalid request body" is returned for a malformed user_ids entry with no field name and no value - RespondWithValidationErrors would let a client point at the bad id.
- [ ] "User is not a member of this organization" does not identify which user_id failed, so a caller replacing five owners cannot tell which one to drop.

**`senso content unpublish`** · 🔴 high — `POST /org/content/{id}/unpublish`

- [ ] POST /org/content/{id}/unpublish must NOT ignore the body bind error. `_ = c.ShouldBindJSON(&body)` turns a malformed publish_record_ids into a silent unpublish-all. Return 400 naming the field when a body is present but invalid, and only treat an ABSENT body as unpublish-all.
- [ ] The endpoint returns 204 on one path and 200 with a body on two others. Always return {unpublished_count, failures}.
- [ ] A partial failure is reported as 200 with a non-empty `failures` array of free-text strings; give each failure a publish_record_id and a code so a caller can retry just those with `senso publish-records retry`.
- [ ] A KB content_id returns 400 "Content type does not support unpublish" rather than the KB-specific message used by the sibling endpoints.

**`senso content verification`** · 🔴 high — `GET /org/content/verification`

- [ ] The list envelope mixes pagination (limit/offset/total_count) with three aggregate counts (draft_count, rejected_count, pending_published_draft_count), which defeats generic list detection. Nest them under a `counts` object.
- [ ] `status=review` silently maps to `draft`. Either implement a real review state or reject the value.
- [ ] limit/offset outside their ranges are silently replaced with defaults instead of returning 400.

**`senso content verification-counts`** · 🟠 medium — `GET /org/content/verification/counts`

- [ ] GET /org/content/verification/counts is missing the RequirePermission(read:content) guard its siblings carry.
- [ ] The response has no `total_count`; a caller has to add the four counts and cannot tell whether they are disjoint.

**`senso content verification-velocity`** · 🟠 medium — `GET /org/content/verification/velocity`

- [ ] Null vs zero is ambiguous for pages_with_citations / avg_days_to_first_citation across the summary and the destination rows; a `measured` flag or an explicit `has_citations` boolean would remove the guesswork.

**`senso content versions`** · 🔴 high — `GET /org/content/{id}/versions`

- [ ] The envelope {content_id, versions} defeats generic list detection; `items` plus the usual pagination keys (even with a single page) would render everywhere without a per-command override.
- [ ] This endpoint serves knowledge-base content while its sibling GET /org/content/{id} refuses it. Pick one rule.

### `senso content tags` <sub>7 items</sub>

**`senso content tags add`** · 🟠 medium — `POST /org/content/{id}/tags`

- [ ] POST /org/content/{id}/tags returns 204 with no body even when it CREATED a tag, so the caller never learns the new tag_id. Return the tag, or the resulting collection.
- [ ] A malformed tag_id produces "Invalid request body" with no field name.

**`senso content tags list`** · 🟢 low — `GET /org/content/{id}/tags`

- [ ] verifyContentBelongsToOrg answers 401 "Organization ID not found" where the other content handlers answer 400 "Organization context not found" for the same condition; the CLI therefore exits 3 here and 1 elsewhere for an identical failure.

**`senso content tags remove`** · 🟠 medium — `DELETE /org/content/{id}/tags/{tagId} with --id, or DELETE /org/content/{id}/tags?name={name} with --name`

- [ ] Both detach paths return 204 whether or not anything was removed, and the --name path also 204s for a name that does not exist in the org. Returning the resulting collection (or 404 for an unknown name) would let a caller tell a typo from a real detach.
- [ ] Detach by name and detach by id are two different routes with different error shapes for the same user-level operation.

**`senso content tags set`** · 🔴 high — `PUT /org/content/{id}/tags`

- [ ] PUT /org/content/{id}/tags treats an empty body as "remove all tags". An explicit {tag_ids: []} should mean that; an absent body should be a 400.
- [ ] The tag 400s ("tag not found", "tag does not belong to this organization", "invalid tag name") do not say WHICH id or name failed.

### `senso ctas` <sub>3 items</sub>

**`senso ctas clear-default`** · 🟢 low — `DELETE /org/ctas/default`

- [ ] Return the number of live content items switched to none (the service already has the list) so the impact is visible.

**`senso ctas create`** · 🟠 medium — `POST /org/ctas (201)`

- [ ] The url validator's message should say 'Must be an absolute URL' rather than 'Invalid value'.

**`senso ctas set-for-content`** · 🟠 medium — `PUT /org/content/{id}/cta  body {selection_type, cta_id?}`

- [ ] Either return the requested selection_type template with the cta_id, or document the collapse to default in the spec.

### `senso evals` <sub>18 items</sub>

**`senso evals claims`** · 🟠 medium — `GET /org/evals/claims`

- [ ] There is no verdict / passed / bucket filter, so 'show me what failed' has to be done client-side over a paged list — the single most obvious query against this endpoint.
- [ ] bucket carries two different closed sets depending on the run's mode and the response never says which mode produced the row; a client cannot interpret `bucket` without fetching the run.
- [ ] No has_more in the envelope, and limit/offset are silently coerced rather than rejected.
- [ ] An unknown run_id returns an empty page rather than a 404, so a typo'd (but well-formed) run id is indistinguishable from a run with no claims.

**`senso evals content`** · 🔴 high — `POST /org/evals/content (202 Accepted)`

- [ ] 404 'Subject not found' collapses 'no such content', 'another organization' and 'you passed a kb_node_id'. A distinct code (or a hint field) for a syntactically valid id from the wrong space would remove the most likely mistake with this endpoint.
- [ ] The subject loader's 'has no saved version' / 'has no text' 422s are free text with no stable code to branch on.
- [ ] Same as `evals text`: 503 for a configuration state, and an unpublished judge-model allowlist.

**`senso evals evaluators`** · 🟢 low — `GET /org/evals/evaluators`

- [ ] The response fakes a page envelope: limit = len(items), offset = 0, total = len(items). Either paginate it or return a bare list; as it stands a client cannot tell a full page from a truncated one.
- [ ] `buckets` is in EvaluatorResponse but never set by ListEvaluators — an always-absent field in the published shape.
- [ ] metrics is a raw JSON blob lifted out of scoring_config with no schema in the DTO; a client rendering it generically (its stated purpose) has nothing to code against.

**`senso evals get`** · 🔴 high — `GET /org/evals/runs/{runId}`

- [ ] claims are embedded here and also served by GET /org/evals/claims?run_id=, with no way to ask for the run without them; a run with hundreds of claims cannot be fetched cheaply for its status alone (the poll loop in --wait pays that cost every 2 seconds).
- [ ] subject, outputs, searches and evidence_chunks are untyped json.RawMessage in the published DTO, so a client has no schema for the audit trail that the endpoint exists to provide.

**`senso evals runs`** · 🟠 medium — `GET /org/evals/runs`

- [ ] The list envelope has no has_more; a client derives it from offset + len(items) < total.
- [ ] limit and offset are silently coerced (unparseable -> default, > 100 -> 100, negative -> 0) rather than rejected, so a caller cannot tell that its page size was ignored.
- [ ] evaluator and subject_type filters accept any string and return an empty page for an unknown one — the same 'looks like no data' failure the gaps handler rejects values to avoid.

**`senso evals text`** · 🔴 high — `POST /org/evals/text (202 Accepted; 200 when the API's own wait= is used, which this CLI never sends)`

- [ ] 503 'Evals are not enabled in this environment' is a configuration state, not a transient one; a status that suggests retrying is misleading. A 501/422 or a documented error_code would let a client distinguish 'never going to work here' from 'try again'.
- [ ] The judge-model allowlist is enforced but never published — neither GET /org/evals/evaluators nor any other endpoint exposes the permitted models, so --judge-model can only be used by trial and error.
- [ ] The gating errors are 422 with free-text messages built by fmt.Errorf; there is no stable error code to branch on (contrast the run's own error_code field).

### `senso gaps` <sub>12 items</sub>

**`senso gaps answer`** · 🟠 medium — `POST /org/gaps/{gapId}/resolutions (201 Created) with resolution_type answered | content_updated`

- [ ] Same as `gaps resolve`: an unknown gap is 400 "gap not found" rather than 404, every service error becomes a 400 with a raw message, and produced_content_id is not checked for existence or org ownership.

**`senso gaps dismiss`** · 🟠 medium — `POST /org/gaps/{gapId}/resolutions (201 Created) with resolution_type dismissed`

- [ ] Same as `gaps resolve`: 400 "gap not found" instead of 404, and every service error flattened into a 400.

**`senso gaps list`** · 🔴 high — `GET /org/gaps`

- [ ] Only `problems` is validated. `statuses`, `kinds`, `surfaces`, `origin_kinds` and `sort` accept anything: an unknown value silently narrows to zero rows (or, for sort, falls back to severity), which is indistinguishable from an empty queue — the exact failure the handler's own comment at gap_handler.go:58 says rejection exists to prevent. Validate them the same way.
- [ ] An unparseable tag_id is dropped silently (gap_handler.go:71) rather than rejected, so `?tag_ids=nonsense` returns the unfiltered queue.
- [ ] The list envelope has no has_more; a client must derive it from offset + len(gaps) < total.
- [ ] limit is clamped to 50 when out of range rather than rejected, so a caller asking for 500 gets 50 with no indication the request was altered.

**`senso gaps resolve`** · 🟠 medium — `POST /org/gaps/{gapId}/resolutions (201 Created)`

- [ ] POST /org/gaps/{gapId}/resolutions answers an unknown gap with 400 "gap not found" (internal/services/gaps/service.go:208, surfaced by gap_handler.go:238) where GET /org/gaps/{gapId} answers 404 "Gap not found". The CLI compensates in notFoundAware() by pattern-matching the message and exiting 4. Return 404 so exit-code branching does not depend on an English string.
- [ ] The handler turns EVERY error from the service into a 400 with err.Error(), so a repository or database failure is reported to the caller as a client error carrying a raw Go error string. Classify: 404 for the missing gap, 422 for the resolution-matrix failures, 500 (with a fixed message) for everything else.
- [ ] The resolution-matrix failures are 400 where 422 belongs — they are semantically invalid, not malformed.
- [ ] produced_content_id / authority_content_id are never checked for existence or org ownership; a typo'd or foreign content id is recorded as the fix and the gap moves to addressed.
- [ ] No enum validation on ruling_side at the DTO level, and no cross-check that ruling_side agrees with resolution_type.

**`senso gaps undo`** · 🟠 medium — `DELETE /org/gaps/{gapId}/resolutions/{resolutionId} (204 No Content)`

- [ ] DELETE returns 204 with no body, so the recomputed status — the entire point of the operation, and something only the server knows — requires a second request. Return the updated gap (or at least { gap_id, status, status_changed_at }) with 200.

### `senso generate` <sub>14 items</sub>

**`senso generate industry-draft`** · 🟠 medium — `POST /org/content-generation/industry-prompt-draft (synchronous; CLI timeout 120 s, server retrieval 45 s + draft 90 s)`

- [ ] 'Invalid request payload' should name the field that failed UUID parsing.

**`senso generate job-context`** · 🟠 medium — `GET /org/content-generation/job-context`

- [ ] Drop or document citeables_action; the DTO comment calls it legacy.

**`senso generate run`** · 🔴 high — `POST /org/content-generation/run (202)`

- [ ] 'Invalid request payload' for a non-UUID id should name the field.
- [ ] A disabled generation setting or no selected publishers surfaces as 502 'Failed to trigger content engine run'; return 422 with the reason.

**`senso generate runs-get`** · 🔴 high — `GET /org/content-generation/runs/{run_id}`

- [ ] The {run: …} wrapper exists for items/logs that this route never fills; return the run object directly or populate items/logs.

**`senso generate runs-list`** · 🔴 high — `GET /org/content-generation/runs`

- [ ] Validate the status query parameter against the enum and return 400 'Invalid status' as the items endpoint already does.
- [ ] Reject limit <= 0 / non-numeric with 400 instead of silently substituting the default.

**`senso generate runs-logs`** · 🟢 low — `GET /org/content-generation/runs/{run_id}/logs`

- [ ] Document the level and event_type vocabularies in the spec.

**`senso generate sample`** · 🔴 high — `POST /org/content-generation/sample (202) then GET /org/content-generation/sample-jobs/{sample_job_id} every 2 s for up to 180 s`

- [ ] The 202 accepts ids the job will immediately reject (prompt of another org, unknown content type); validate ownership at submit time and return 400/404 with the field named.
- [ ] 'Invalid request payload' on a non-UUID id should name the field.
- [ ] `expired` exists in the enum but nothing sets it; either implement a TTL or drop it from the contract.

**`senso generate settings`** · 🟠 medium — `GET /org/content-generation`

- [ ] Return selected_content_type_id as null rather than omitting it, so the key is always present.

**`senso generate update-settings`** · 🔴 high — `PATCH /org/content-generation`

- [ ] The validator's 'Should be at most 6 characters' for content_schedule dive/max is misleading for integers; return 'Must be between 0 and 6'.
- [ ] 'Invalid request payload' does not name the offending field; return the JSON binding error's field.

### `senso engine` <sub>7 items</sub>

**`senso engine draft`** · 🔴 high — `POST /org/content-engine/draft`

- [ ] The request DTO has no binding tags and every requirement is a hand-written 400 with a free-text message and no field name; validation errors should name the field.
- [ ] geo_question_id being optional is correct but is not reflected in any published contract - the CLI help, and any client written from it, has it wrong.
- [ ] draft and publish differ in whether they reject missing-evidence placeholders; that asymmetry should be documented in the API spec, not just in the handler.

**`senso engine publish`** · 🔴 high — `POST /org/content-engine/publish`

- [ ] A publish whose destinations all failed returns HTTP 200 with publish_status "failed". Use a non-2xx status, or at minimum document that 200 vs 201 is the success signal - it is currently the only machine-readable difference.
- [ ] The request DTO has no binding tags; every requirement is a hand-written 400 with a free-text message and no field name. Validation errors should name the field.
- [ ] "Invalid request body" is returned for any malformed field, including a bad publisher_ids UUID, with nothing to identify it.
- [ ] citeables_action and publish_destination are documented in the DTO as legacy compatibility fields but are still returned unlabeled.

### `senso destinations` <sub>5 items</sub>

**`senso destinations add`** · 🔴 high — `POST /org/destinations (201; 200 when the domain is already registered to the org)`

- [ ] Validate --domain server-side and return 400 naming the field rather than delegating to citeables.
- [ ] 'Invalid request payload' on a missing field should name it.

**`senso destinations list`** · 🟠 medium — `GET /org/destinations`

- [ ] Type is always 'citeables' for the shared trio; document the type enum (citeables, manual) and that codeables/cucopilot are slugs, not types.

**`senso destinations remove`** · 🔴 high — `POST /org/destinations/{publisherId}/remove`

- [ ] Return 409 or 400 with 'cannot delete shared publisher' for --also-remove-destination on a shared destination instead of 404.
- [ ] Return 207/200 with partial_failures rather than 502 when the action aborts mid-loop, so the caller knows what was done.

### `senso publish-records` <sub>3 items</sub>

**`senso publish-records retry`** · 🔴 high — `POST /org/publish-records/{id}/retry`

- [ ] POST /org/publish-records/{id}/retry returns 204 with no body; returning the updated publish record (state, external_url, last_error) would remove the follow-up query and let a client distinguish live from failed without relying on the status code.
- [ ] A destination refusal is reported as 502, the same status used for infrastructure failures, so a client cannot tell a retryable outage from a content the destination will never accept. last_error is written to the record but never returned.
- [ ] Three different not-found causes share the same 404 status with three different messages that a client must string-match.

### `senso brand-kit` <sub>5 items</sub>

**`senso brand-kit get`** · 🟠 medium — `GET /org/brand-kit`

- [ ] GET /org/brand-kit fabricates a record for an org with no brand kit: brand_kit_id is the zero UUID and created_at/updated_at are 0001-01-01T00:00:00Z. Omitting those fields (or returning a 'saved: false' flag) would let a client tell the two states apart without string-matching a zero UUID.

**`senso brand-kit patch`** · 🟢 low — `PATCH /org/brand-kit`

- [ ] PATCH reports validation failures usefully ('unknown field "mascot"') while PUT flattens them to 'Invalid guidelines data'. Make PUT match PATCH.
- [ ] There is no way to remove a single field: null is not accepted as 'delete', so the only removal path is a full PUT. A JSON-merge-patch semantic (null = delete) would be the conventional answer.

**`senso brand-kit set`** · 🟠 medium — `PUT /org/brand-kit`

- [ ] PUT /org/brand-kit collapses every validation failure to 'Invalid guidelines data', discarding the service's message, while PATCH passes the same message through. The two write paths should report identically.
- [ ] PUT silently ignores any top-level key other than 'guidelines' and answers 200, so a mis-nested field is indistinguishable from a successful save.

### `senso content-types` <sub>6 items</sub>

**`senso content-types create`** · 🔴 high — `POST /org/content-types`

- [ ] dto.CreateContentTypeRequest uses 'validate:' tags but the handler binds with ShouldBindJSON, which only honors 'binding:' tags — so name's min=1/max=255 and config's required are dead. The service catches the important cases, but the 255-character name limit is not enforced at all.
- [ ] template_spec is accepted on input and then discarded. Either reject it as an unknown field on write or document it as output-only.

**`senso content-types delete`** · 🟢 low — `DELETE /org/content-types/{id}`

- [ ] The API does not report whether anything references the content type, so neither can the CLI. A reference count on the delete response (or a 409 when in use) would make this safe.

**`senso content-types list`** · 🟠 medium — `GET /org/content-types`

- [ ] ContentTypeListResponse.Total is set to len(response) instead of a COUNT over the org's content types. A client cannot paginate correctly; either fix it or drop the field.

**`senso content-types update`** · 🔴 high — `PUT /org/content-types/{id}`

- [ ] Same dead 'validate:' tags as create: name's max=255 is never enforced.
- [ ] A PUT that omits config entirely reports 'Invalid config JSON' rather than 'config is required', which sends the caller looking for a syntax error.

### `senso prompts` <sub>9 items</sub>

**`senso prompts create`** · 🔴 high — `POST /org/prompts`

- [ ] POST /org/prompts silently accepts and drops keys it does not model (tag_ids, geo_pool_id) although POST /org/questions accepts both on the same table.
- [ ] question_text is max=500 here and max=255 on POST /org/questions for the same column — one of the two limits is wrong.

**`senso prompts delete`** · 🟠 medium — `DELETE /org/prompts/{promptId}`

- [ ] The other-org case answers 403 where 404 belongs.
- [ ] 204 carries no body, so a JSON caller has nothing to confirm against beyond the exit code.

**`senso prompts get`** · 🔴 high — `GET /org/prompts/{promptId}`

- [ ] A prompt id from another org answers 403 where 404 is the honest answer (it also confirms the id exists elsewhere).
- [ ] 'Invalid prompt ID' is a 400 for what is a malformed path parameter; 404 or a message naming the expected format would be clearer.
- [ ] The detail response has no pagination over 'runs' — a long-tracked prompt returns every run it has ever had in one body.

**`senso prompts list`** · 🟠 medium — `GET /org/prompts`

- [ ] GET /org/prompts silently clamps limit > 100 and ignores an unparseable limit/offset. Returning 400 with the accepted range would let a client find its own bug.
- [ ] The list envelope key is 'prompts' rather than 'items'; total/limit/offset are standard, so only the list key differs from the other list endpoints.

### `senso prompts tags` <sub>6 items</sub>

**`senso prompts tags add`** · 🟠 medium — `POST /org/prompts/{promptId}/tags`

- [ ] AttachTagByBody maps every error from AddTagToPrompt to 400 with err.Error(), including internal failures — a database error is reported to the client as a bad request and its text is echoed.
- [ ] 204 with no body means a tag created by name cannot be identified without a second call; returning the tag would remove that round trip.

**`senso prompts tags list`** · 🟠 medium — `GET /org/prompts/{promptId}/tags`

- [ ] The response is a bare array while every other list endpoint in the API returns an envelope; a client cannot tell 'no tags' from 'endpoint returned nothing'.

**`senso prompts tags remove`** · 🟠 medium — `DELETE /org/prompts/{promptId}/tags/{tagId} (with --id) or DELETE /org/prompts/{promptId}/tags?name=... (with --name)`

- [ ] Both detach routes answer 204 unconditionally, so the API cannot tell a client that the tag it named does not exist. A 404 for an unknown tag NAME (as distinct from an unattached one) would make typos visible.

**`senso prompts tags set`** · 🔴 high — `PUT /org/prompts/{promptId}/tags`

- [ ] An empty body on PUT means 'clear all' but is indistinguishable from a client bug; an explicit {"tag_ids": []} requirement would be safer.
- [ ] 'Invalid request body' on a bind failure names no field, so a bad UUID in tag_ids cannot be located from the response.

### `senso run-config` <sub>11 items</sub>

**`senso run-config model-options`** · 🔴 high — `GET /org/run-models/options`

- [ ] The response mixes a scalar ('scope') with the list, which defeats generic list detection in clients. Moving scope under a meta key, or dropping it, would make this a plain list envelope.
- [ ] The options endpoint deliberately advertises fewer names than the write endpoint accepts (hiddenPickerModels). Documenting that gap in the response — e.g. a 'hidden' flag rather than an omission — would stop clients treating the options list as the validation list.

**`senso run-config models`** · 🟠 medium — `GET /org/run-models`

- [ ] None. The envelope is clean ({models: [...]} with no extra keys).

**`senso run-config schedule`** · 🟢 low — `GET /org/run-schedule`

- [ ] The response carries no timezone or run time, so a client cannot say when the next run is.

**`senso run-config scheduler-models`** · 🟠 medium — `GET /org/scheduler-models`

- [ ] There is no route serving the scheduler-supported catalog (OrgRunConfigService.ListSupportedModels is unrouted), so the only way to discover a valid provider/model id is to send an invalid write and read valid_models from the 400.
- [ ] The response does not include the joined 'provider/model' identifier that the write endpoint requires; clients must concatenate two fields.

**`senso run-config set-models`** · 🔴 high — `PUT /org/run-models`

- [ ] The model-validation 400 sends BOTH 'error' (terse) and 'message' (useful) at the top level; clients that follow the usual 'error first' convention lose the useful one. Consider dropping 'error' or making 'message' the only human-facing field.
- [ ] The unsupported-model failure is a 400 for a value problem in a well-formed body; 422 would be more honest, but the code is already public.

**`senso run-config set-schedule`** · 🟠 medium — `PUT /org/run-schedule`

- [ ] PUT /org/run-schedule cannot express 'no run days': the validator's 'required' rejects an empty array. If turning runs off is meant to be possible here, the tag should be omitempty/min=0; if it is not, the error message should say so rather than 'This field is required'.

**`senso run-config set-scheduler-models`** · 🔴 high — `PUT /org/scheduler-models`

- [ ] EXPOSE THE CATALOG: route OrgRunConfigService.ListSupportedModels (it already exists) as GET /org/scheduler-models/options, mirroring GET /org/run-models/options. Today a client can only learn the accepted ids by provoking a 400.
- [ ] The 400 body sends both 'error' (terse) and 'message' (useful); clients following the 'error first' convention lose the useful one.

### `senso skills` <sub>1 items</sub>

**`senso skills install`** · 🔴 high — `n/a (local: spawns `shipables install <pkg> <--claude|…|--all> [--global] [--env SENSO_API_KEY=<key>] --yes`, or `npx --yes @senso-ai/shipables …` when shipables is not on PATH; src/commands/skills.ts)`

- [ ] None (no API). Upstream ask to shipables: read process.env for an --env name with no value, so the key need not be in argv (already recorded in SECURITY.md).

### `senso members` <sub>1 items</sub>

**`senso members list`** · 🟠 medium — `GET /org/members`

- [ ] Reject an unknown sort and an out-of-range limit with 400 instead of silently substituting defaults.

### `senso questions` <sub>9 items</sub>

**`senso questions create`** · 🔴 high — `POST /org/questions`

- [ ] question_text is max=255 here and max=500 on POST /org/prompts for the same column.
- [ ] POST /org/questions rejects the legacy type spellings that POST /org/prompts normalizes; the two write paths to one table should share services.NormalizeQuestionType.
- [ ] A failure while attaching tag_ids is logged and swallowed: the client gets 201 and no indication the tags were not applied.

**`senso questions delete`** · 🟠 medium — `DELETE /org/questions/{questionId}`

- [ ] The other-org case answers 403 where 404 belongs.
- [ ] DELETE /org/questions/:id and DELETE /org/prompts/:id do the same thing through two services (QuestionService.DeleteQuestion vs OrgPromptService.DeletePrompt) with different error sentinels and different messages for the same conditions.

**`senso questions list`** · 🔴 high — `GET /org/questions?question_type={organization|network}`

- [ ] GET /org/questions returns limit, offset and sort_by which the handler never populates — they are always 0/0/''. Either implement them or drop them from the response; 'sort_by' in particular breaks generic list detection in clients.
- [ ] The endpoint has no pagination while its twin GET /org/prompts does, over the same table.

**`senso questions patch`** · 🔴 high — `PATCH /org/questions/{questionId}`

- [ ] PATCH cannot distinguish 'tag_ids omitted' from 'tag_ids: null', so there is no JSON-null way to clear tags; the empty array is the only one. Either accept null as 'clear' or document it.
- [ ] The other-org case is a 403 where 404 belongs.

### `senso kb` <sub>56 items</sub>

**`senso kb ancestors`** · 🟠 medium — `GET /org/kb/nodes/{id}/ancestors`

- [ ] The envelope key is 'ancestors' with no total and no limit/offset - a third list shape in the same group (nodes, grants, ancestors, plus the bare array from the tag endpoints). One list envelope across the API would remove the heuristic in lib/output.ts.

**`senso kb bulk-delete`** · 🟠 medium — `POST /org/kb/nodes/bulk-delete`

- [ ] 204 with no body means the caller cannot confirm what was deleted, and the all-or-nothing errors deliberately name no node. A 200 with {deleted: [ids]} - or at least a failing-id list on the 404/403 - would remove the bisect.
- [ ] 'too many nodes in one request' is a 400 whose message does not state the limit (100).

**`senso kb children`** · 🔴 high — `GET /org/kb/nodes/{id}/children?limit&offset&type&status&role&sort_by&sort_order&tag_ids`

- [ ] 'invalid kb node data: node is not a folder' is a 400 whose message leaks an internal sentinel string ('invalid kb node data'). A field-free 422 or a message that names the node type would render better.

**`senso kb create-folder`** · 🟠 medium — `POST /org/kb/folders`

- [ ] 400 'Invalid request payload' for a malformed parent_id names no field, so the CLI cannot turn it into a field-level error. RespondWithValidationErrors is used for tag failures on the same struct - a binding failure should carry the same field detail.
- [ ] There is no public find-or-create. The internal route POST /internal/kb/folders/ensure exists for exactly this and is not exposed to org keys, so every agent has to implement find-then-create itself.

**`senso kb create-raw`** · 🔴 high — `POST /org/kb/raw`

- [ ] The create response is keyed by `id` = content_id, with kb_node_id as a secondary field. Every other endpoint in the group is addressed by kb_node_id. Making kb_node_id the primary key of this payload (or renaming `id` to content_id) would remove the single most likely agent error in the group.
- [ ] This handler returns 400 'Organization context not found' where the read handlers return 401 for the identical condition, so the CLI maps the same failure to exit 1 here and exit 3 there.
- [ ] tag_ids is present on dto.CreateRawContentRequest, bound, and then never used. An accepted-and-ignored field should be rejected or honored.
- [ ] The 409 duplicate message ('duplicate content: identical content already exists in this organization') does not include the existing content's id or node id, so a caller cannot reuse what is already there.

**`senso kb delete`** · 🔴 high — `DELETE /org/kb/nodes/{id}`

- [ ] 409 'This document is still ingesting; retry when it completes' carries no retry-after and no content id, so a caller cannot tell which document in a subtree blocked the delete.

**`senso kb download-url`** · 🟠 medium — `GET /org/kb/nodes/{id}/download-url?version={n}`

- [ ] expiry_utc_ms is an absolute epoch with no expires_in sibling, unlike the upload response which returns expires_in seconds. Two conventions for the same concept inside one group.
- [ ] 'Content is not a downloadable file' is a 400 for a type mismatch that the caller could only discover by trying; the node payload does not distinguish a raw node from a file node except through content.content_type.

**`senso kb find`** · 🔴 high — `GET /org/kb/find?q&limit&offset&type&status&role&sort_by&sort_order&tag_ids`

- [ ] q="" returns 200 with an empty page instead of 400. It also resets limit to 50, discarding the caller's paging parameters, so an empty query is indistinguishable from a genuine no-match at a different page size.

**`senso kb get`** · 🔴 high — `GET /org/kb/nodes/{id}`

- [ ] 400 'Invalid node ID' is used for a malformed UUID while 404 is used for a well-formed one that does not resolve. That is defensible, but the 400 body names no field, so the CLI cannot turn it into a field-level validation error.
- [ ] The node payload nests the content_id as content.id while also exposing a sibling content_id. Two names for one value in one object is the reason agents mix the id spaces up.

**`senso kb get-content`** · 🔴 high — `GET /org/kb/nodes/{id}/content?version={n}`

- [ ] The response's primary key is `id` (a content_id) while the request key is a kb_node_id and there is no kb_node_id in the response. dto.MapContentWithVersionToKBResponse exists precisely to add kb_node_id to KB content responses - GetContent uses MapContentWithVersionToDetailResponse, which does not, so the round trip cannot be closed.
- [ ] 'Node has no associated content' is a 400 for what is really 'wrong kind of node' - the same condition 'kb children' reports as 400 'node is not a folder'. Neither names a field.

**`senso kb move`** · 🔴 high — `PATCH /org/kb/nodes/{id}/move`

- [ ] Move answers 404 'Node not found' for a missing node and a missing destination alike. The destination's existence is not a secret in the same way - the caller supplied it and must hold a role on it - so two distinct messages would be safe and far more useful.
- [ ] 'Cannot move root node', 'Invalid parent folder' and 'Cannot move a folder into its own subtree' are all 400 with no error code, so a client cannot branch on them without matching English.

**`senso kb my-files`** · 🔴 high — `GET /org/kb/my-files?limit&offset&type&status&role&sort_by&sort_order&tag_ids`

- [ ] The list envelope uses 'nodes' rather than 'items'. Every other paginated Senso list the CLI renders uses items/total/limit/offset; the special-case key is why lib/output.ts needs a heuristic instead of a rule.
- [ ] limit above 50 is silently capped and limit below 1 is silently read as 50 (strconv.Atoi guarded by parsedLimit > 0). A 400 naming the range would be better than a page that is quietly not what was asked for.

**`senso kb patch-raw`** · 🟠 medium — `PATCH /org/kb/nodes/{id}/raw`

- [ ] Same post-commit tag write as PUT: apply tags in the same transaction, or report a partial success.
- [ ] 'At least one field must be provided for update' is a hand-written 400 with no field list, so a client cannot tell which keys would have satisfied it.
- [ ] Same `id` = content_id primary key problem as create-raw / update-raw.

**`senso kb permissions add`** · 🟠 medium — `POST /org/kb/nodes/{id}/permissions`

- [ ] The 409 tells the caller to use PATCH but does not return the existing permission id, so the caller cannot act on the advice without a second request.
- [ ] A group the caller cannot see answers 404 'Group not found', identical to a group that does not exist. That is a deliberate non-disclosure choice, but combined with the CLI's 'Not found.' it is unactionable.
- [ ] dto.GrantPermissionRequest's validate tag is oneof=viewer editor owner while the handler rejects owner - the DTO advertises a value the endpoint refuses.

**`senso kb permissions list`** · 🟠 medium — `GET /org/kb/nodes/{id}/permissions`

- [ ] No total, and group grants the caller cannot see are silently dropped, so the list is neither complete nor countable. A filtered_count would let a client say 'and 2 group grants you cannot see'.
- [ ] The envelope key is 'grants' with no pagination fields - a fourth list shape in this group.

**`senso kb permissions remove`** · 🟠 medium — `DELETE /org/kb/nodes/{id}/permissions/{permissionId}`

- [ ] DELETE returns 200 with {"message": "Permission revoked"} where the node deletes return 204. Two conventions for the same kind of operation inside one handler file.
- [ ] The response does not identify what was revoked, so an audit trail has to be reconstructed from the request.

**`senso kb permissions update`** · 🟠 medium — `PATCH /org/kb/nodes/{id}/permissions/{permissionId}`

- [ ] PATCH returns {"message": "Permission updated"} instead of the updated dto.KBNodeGrant. Every other mutation in the group returns the resource; this one returns prose.
- [ ] 404 'Permission not found' covers three distinct conditions (absent, wrong node, invisible group grant) with one message.

**`senso kb rename`** · 🟠 medium — `PATCH /org/kb/nodes/{id}/rename`

- [ ] Rename returns mapKBNodeToResponse while GetByID returns mapKBNodeWithContentToResponse. Two shapes under one type name means a caller that parses 'kb get' cannot reuse the parse for 'kb rename'.
- [ ] 'invalid kb node data: cannot rename root node' leaks the internal sentinel text into a user-facing message.

**`senso kb root`** · 🟢 low — `GET /org/kb/root`

- [ ] GetRoot returns 500 when an org has no root node. A missing root is a data condition, not an internal failure; 404 with a message naming the org would let the CLI say something useful.

**`senso kb stats`** · 🟢 low — `GET /org/kb/stats`

- [ ] Consider adding a per-status breakdown (complete/processing/failed) so an agent can tell a healthy KB from one where ingestion is failing without paging my-files four times.

**`senso kb sync-status`** · 🟠 medium — `GET /org/kb/sync-status`

- [ ] The response is a bare {syncing: bool} with no indication of what is syncing, how many operations are outstanding, or when it started. A caller cannot distinguish 'one delete, nearly done' from 'stuck'.

**`senso kb tags add`** · 🟠 medium — `POST /org/kb/nodes/{id}/tags`

- [ ] One endpoint, two success statuses and two body shapes depending on which field the body carried. Returning the attached tag in both cases (201/200 with the tag) would remove a branch from every client.
- [ ] There are two routes for the same operation - POST /kb/nodes/:id/tags (body) and POST /kb/nodes/:id/tags/:tagId (path) - with different status codes. The CLI only uses the first.

**`senso kb tags list`** · 🟠 medium — `GET /org/kb/nodes/{id}/tags`

- [ ] The endpoint returns a bare array where every other list in the group returns an envelope ({nodes, total, limit, offset}; {grants}; {ancestors}). Four list shapes in one group.
- [ ] There is no pagination on node tags, which is fine, but there is also no total, so it cannot be told apart from a truncated list.

**`senso kb tags remove`** · 🟠 medium — `DELETE /org/kb/nodes/{id}/tags/{tagId}  (with --id)  or  DELETE /org/kb/nodes/{id}/tags?name={name}  (with --name)`

- [ ] Both detach paths answer 204 whether or not a link existed, so no client can report what happened. Returning the resulting tag set (as PUT does) or a {removed: bool} would fix it for every caller.
- [ ] Detach-by-name is a query parameter on a collection DELETE while detach-by-id is a path segment; two shapes for one operation.

**`senso kb tags set`** · 🔴 high — `PUT /org/kb/nodes/{id}/tags`

- [ ] An empty PUT body means 'clear all tags'. A destructive interpretation of an empty body is a sharp edge for every client; requiring an explicit empty array would be safer.
- [ ] The tag request errors go through respondTagError, which returns the service's own text at 400 with no field name, so a client cannot tell which of several supplied ids was rejected.

**`senso kb update-file`** · 🔴 high — `PUT /org/kb/nodes/{id}/file, then PUT to the returned presigned S3 URL (done by the CLI)`

- [ ] validateFile's content-type, size and Word-lock-file rejections are plain fmt.Errorf values with no sentinel, so UpdateFile answers 500 'Failed to ingest content.' for what are plainly client errors. The batch endpoint reports the identical conditions as a per-file 'invalid' with the reason. Same validation, two very different answers.
- [ ] The success payload returns upload_url after the caller has used it, and returns no processing_status, so there is nothing to poll on in the response itself.

**`senso kb update-raw`** · 🔴 high — `PUT /org/kb/nodes/{id}/raw`

- [ ] The tag write is a second transaction after the content update commits, so a tag failure leaves the document updated and the tags not, reported as a 500. The endpoint should either apply tags in the same transaction or report a partial success.
- [ ] Same `id` = content_id primary key problem as create-raw.
- [ ] 'Title is required' and 'Content text is required' are hand-written 400s that bypass RespondWithValidationErrors, so they carry no field name even though the DTO has validation tags for both.

**`senso kb upload`** · 🔴 high — `POST /org/kb/upload, then PUT to each returned presigned S3 URL (done by the CLI, not the API)`

- [ ] The all-skipped case answers 422 with a SUCCESS-shaped body (summary + results), not middleware.RespondWithError's {status, message}. Every client has to special-case it - the CLI has isBatchRejection() for exactly this.
- [ ] 'invalid' folds three different rejections together (unsupported content type, over 100MB, Word lock file) and puts the distinction only in a free-text error string.
- [ ] markdown_requires_raw_ingestion is a per-file status not declared in dto.IngestionUploadResultItem's documentation comment, which lists only upload_pending, conflict, duplicate and invalid.
- [ ] The 'conflict' error text truncates the hash to 8 characters and returns existing_content_id (a content_id) but not the existing node's kb_node_id, so a caller cannot navigate to what already exists.

### `senso tags` <sub>7 items</sub>

**`senso tags create`** · 🟠 medium — `POST /org/tags`

- [ ] The 409 body should carry the existing tag's id so the caller can attach it without a second round trip.
- [ ] The 400 leaks the Go struct path ('Key: 'CreateTagRequest.Name' Error:Field validation ...'). CreateTag uses ShouldBindJSON + raw err.Error() rather than middleware.ValidateRequest, so it does not get the field-level {field, message} list the competitor and tracked-source endpoints return.

**`senso tags delete`** · 🟠 medium — `DELETE /org/tags/{id}`

- [ ] 204 with no body means the caller cannot report how many attachments were removed. Returning `{deleted: true, detached: {prompts: n, content: n, kb_nodes: n}}` would let the CLI show the blast radius after the fact.

**`senso tags list`** · 🔴 high — `GET /org/tags?counts=true`

- [ ] `total_count` is len(items), which makes it indistinguishable from a page count. Either add real limit/offset paging (and make total_count the org total) or rename it `count`.
- [ ] The list envelope key is `items` with `total_count`; the sibling groups in this batch use `competitors`/`total`, `tracked_sources`/`total`, `product_lines`/`total`. Four endpoints, three envelope conventions.

**`senso tags update`** · 🟠 medium — `PATCH /org/tags/{id}`

- [ ] There is no merge endpoint, so folding 'Pricing' into 'pricing' means re-tagging every resource by hand. A PATCH that accepted `merge_into_tag_id` would make the common cleanup one call.
- [ ] UpdateTag uses ShouldBindJSON + raw err.Error(), leaking 'Key: 'UpdateTagRequest.Name'…' instead of the field-level list the middleware validator produces.

### `senso product-lines` <sub>10 items</sub>

**`senso product-lines create`** · 🔴 high — `POST /org/product-lines`

- [ ] 'Invalid request body' (product_line_handler.go:34) names no field. This endpoint binds with ShouldBindJSON and discards the error, unlike the competitor/tracked-source endpoints which return the field-level list.
- [ ] dto.CreateProductLineRequest tags are `validate:` but the handler uses ShouldBindJSON, which only honours `binding:`. Neither `name` nor `details` is actually enforced at bind time — the service is the only check, and it accepts a missing details as {}.
- [ ] 'invalid product line details JSON' is returned for details that ARE valid JSON but not an object; the message is misleading.

**`senso product-lines delete`** · 🟠 medium — `DELETE /org/product-lines/{id}`

- [ ] 204 with no body means the caller learns nothing about dangling references. Reporting how many Builder workspaces still select this id would let the CLI warn.

**`senso product-lines list`** · 🔴 high — `GET /org/product-lines?limit=&offset=`

- [ ] `total` must be the org's row count for the filter, not len(page). As written, paging is undecidable from the response.
- [ ] Invalid limit/offset are silently replaced by defaults instead of returning 400. The tracked-source list on the same API does the right thing (parsePaginationQuery → 400 'Invalid limit. Must be 1-100'); this endpoint should use it too.
- [ ] There is no upper bound on `limit`, so `--limit 100000` is honoured.
- [ ] The list envelope key is `product_lines` rather than `items`.

**`senso product-lines patch`** · 🔴 high — `PATCH /org/product-lines/{id}`

- [ ] There is no deep-merge option for `details`. A `details_merge` mode, or JSON-merge-patch semantics, would make the common 'change one field' case safe. As it stands PATCH and PUT differ only in whether `name` is required.

**`senso product-lines update`** · 🔴 high — `PUT /org/product-lines/{id}`

- [ ] PUT should reject a body without `details` (400) rather than treating absent as {}. The DTO says validate:"required" but the handler binds with ShouldBindJSON, which never runs `validate:` tags — so the declared contract and the enforced contract differ.

### `senso roles` <sub>1 items</sub>

**`senso roles list`** · 🟢 low — `GET /org/roles`

- [ ] Return RoleWithPermissionsResponse (permissions[]) so a client can see what a role grants; filter deleted roles.

### `senso competitors` <sub>17 items</sub>

**`senso competitors add`** · 🔴 high — `POST /org/competitors`

- [ ] The 50-competitor cap must not be a 500. Give it a sentinel (ErrCompetitorCapReached) and return 409 or 422 with the message 'competitor cap of 50 reached for this org'. As written it is indistinguishable from a database outage and every client will retry it.
- [ ] The `url` validation tag produces 'Invalid value' with no explanation. Add a `url` case to getErrorMessage, e.g. 'Must be an absolute URL including the scheme (https://…)'.

**`senso competitors batch-add`** · 🔴 high — `POST /org/competitors/batch`

- [ ] The response must distinguish created from pre-existing, and must report what was dropped. Something like { created: [...], already_tracked: [...], skipped: [{index, name, reason}] }. Today a 201 is returned even when 45 of 50 items were silently discarded.
- [ ] Truncating to the remaining cap instead of failing is a surprising choice for an API; at minimum it should be reported.
- [ ] Validation errors name the leaf field, not the item index — 'source: Must be one of: …' for a 50-item batch is unactionable. Include the path (items[7].source).
- [ ] The 280-character `rationale` cap is tighter than what `suggest` produces, so the documented accept flow can fail on the API's own output.
- [ ] The 50-per-org cap surfaces as 500 here too.

**`senso competitors delete`** · 🟠 medium — `DELETE /org/competitors/{competitorId}`

- [ ] DELETE returns 200 {deleted:true} where every other delete in this batch returns 204. Pick one.
- [ ] The response does not say whether historical analytics keep counting the removed competitor.

**`senso competitors list`** · 🔴 high — `GET /org/competitors`

- [ ] The list envelope key is `competitors` with `total`, which differs from tags (`items`/`total_count`), product lines (`product_lines`/`total`) and tracked sources (`tracked_sources`/`total`).
- [ ] No filter or sort parameters. With a 50-row cap that is defensible, but there is also no `created_by_user_id` in the response even though it is stored, so 'who added this' is not answerable from the CLI.

**`senso competitors suggest`** · 🔴 high — `POST /org/competitors/suggest`

- [ ] The response mixes the list with metadata (mode, duration_ms, cached), which is precisely the §2.6 case: a generic client cannot tell the list from the envelope. Either nest as { suggestions: {items: [...]}, meta: {...} } or add the suggestions under an `items` key.
- [ ] `rationale` returned here is unbounded but `batch-add` caps it at 280 characters, so the documented accept flow can fail on the API's own output.
- [ ] There is no way to ask for a specific mode from this surface, although the service supports ForceMode (run_text | web_search). Exposing it would let an agent retry deterministically.
- [ ] Suggest is gated on update:org even though it writes nothing but an audit log.

**`senso competitors update`** · 🔴 high — `PUT /org/competitors/{competitorId}`

- [ ] PUT with an absent `url` clears it. Because the DTO uses *string, absent and null are indistinguishable, so no client can express 'keep the current URL' — the only way is to read it first and send it back. Support PATCH, or treat absent as 'unchanged' and require an explicit null to clear.
- [ ] The update endpoint cannot edit `rationale` or `confidence` even though batch-add can set them.

### `senso tracked-sources` <sub>10 items</sub>

**`senso tracked-sources add`** · 🔴 high — `POST /org/tracked-sources`

- [ ] Silently discarding `category` for a non-tracked tier should be a 400 or at least reported in the response.
- [ ] 'a path is required for path_prefix and exact_url scopes' is a 400 that reads like a server error; it is a field error on the pattern/match_type combination and should be returned as a field-level validation error naming both.
- [ ] The response does not indicate that a rollup recalculation was queued, so no client can tell the user when analytics will catch up.

**`senso tracked-sources delete`** · 🔴 high — `DELETE /org/tracked-sources/{sourceId}`

- [ ] DELETE returns 200 {deleted:true}; the tag and product-line deletes on the same API return 204. Pick one.
- [ ] The 409 says 'deactivate instead' but the only way to deactivate requires resending pattern, match_type and tier — values the caller may not have and is not allowed to change. A PATCH, or a dedicated deactivate endpoint, would make the advice followable.

**`senso tracked-sources list`** · 🔴 high — `GET /org/tracked-sources?limit=&offset=&search=`

- [ ] The list envelope key is `tracked_sources` rather than `items` — a fourth spelling across the four groups in this batch.
- [ ] Good: `total` here IS the org-wide count for the filter (dto.MapTrackedSourceListToResponse documents it), unlike competitors, product lines and tags. Worth keeping and copying to the others.

**`senso tracked-sources update`** · 🔴 high — `PUT /org/tracked-sources/{sourceId}`

- [ ] A PUT on a published rule that changes anything but `active` must fail (409, matching the delete path) rather than returning 200 with the change dropped. This is the clearest 'looks like success, was not' in the group.
- [ ] `label` and `category` are cleared when absent while `priority` and `active` are preserved when absent, in the same request body. Make the semantics uniform.
- [ ] There is no PATCH, so toggling `active` requires resending pattern, match_type and tier — which for a published rule are values the caller is not allowed to change anyway.

### `senso generated-content` <sub>3 items</sub>

**`senso generated-content get`** · 🟠 medium — `GET /org/generated-content/{id}`

- [ ] GET /org/generated-content/{id} and GET /org/content/{id} serve the same row with disjoint field sets; one of them should be a superset, or the difference should be a query parameter.

**`senso generated-content list`** · 🔴 high — `GET /org/generated-content/published or GET /org/generated-content/drafts`

- [ ] limit/offset outside their ranges are silently replaced with the DEFAULT (10), not clamped to the maximum; return 400 naming the parameter.
- [ ] published and drafts are separate paths rather than a `status` query parameter, which makes the two listings impossible to page over together.

### `senso analytics` <sub>4 items</sub>

**`senso analytics filters`** · 🔴 high — `GET /org/analytics/filters`

- [ ] Optional: expose the fixed allow-list (`all_model_ids`) so the CLI need not hard-code it.

**`senso analytics glossary`** · 🟢 low — `GET /org/analytics/glossary`

- [ ] Move GET /org/analytics/glossary out of the GEO product gate (keep auth): static definitions should be readable by any org key.
- [ ] Add glossary entries for tracked_citation_share, external_citation_share, latest.share_of_voice and sov_pct.

**`senso analytics summary`** · 🔴 high — `GET /org/analytics/summary`

- [ ] None required. Optional: the fixed model allow-list could be published on /org/analytics/filters as `all_model_ids` so the CLI need not hard-code it.

### `senso history-imports` <sub>3 items</sub>

**`senso history-imports get`** · 🔴 high — `GET /org/history-imports/{importId}`

- [ ] A `terminal` boolean (or an explicit statement that failed is retried) would remove the need for every client to encode 'failed is not final' as folklore.

**`senso history-imports list`** · 🟠 medium — `GET /org/history-imports`

- [ ] GET /org/history-imports returns {imports: [...]} with no `total`, so a client cannot tell whether the fixed 50-row window truncated the answer.
- [ ] The list is capped at 50 with no limit/offset. Either paginate it or return a `truncated` flag.

### `senso industries` <sub>11 items</sub>

**`senso industries brand`** · 🔴 high — `GET /org/industries/{industry_id}/brands/{brandName}`

- [ ] GET .../brands/:brand mints a brand registry row (with a model call for aliases) on a GET, with no rate limit. A typo'd brand name permanently adds a record. Either make it idempotent-read-only or document the write in the spec.
- [ ] `by_stage` is always null and `notes` explains why in prose. A typed `available: false` flag would let a client branch without parsing English.

**`senso industries brand-by-id`** · 🟠 medium — `GET /org/industries/{industry_id}/brands-by-id/{brand_id}`

- [ ] Both 404s use the bare envelope, so a client cannot tell 'Industry not found' from 'Brand not found' without string-matching English. A stable `code` field on the error body would fix it for every endpoint.

**`senso industries brands`** · 🔴 high — `GET /org/industries/{industry_id}/brands`

- [ ] GET /org/industries/:id/brands CLAMPS limit to 100 rather than rejecting an out-of-range value, while GET /org/industries/:id/prompts on the same resource rejects it with a 400. Two paging behaviors in one group is a trap.
- [ ] supportedRunModels accepts three values (google_ai_overviews, claude, gpt) that are not in supportedRunModelsList, so the 400 message advertises a smaller set than the endpoint accepts.
- [ ] There is no /org route that lists an industry's location codes (only /partner and /admin have GET /industries/:id/locations), so an org-key caller cannot discover what --location takes.

**`senso industries domain`** · 🟠 medium — `GET /org/industries/{industry_id}/domains/{domain}[?url=...]`

- [ ] The /org surface has no 'top cited domains' read; only /partner/industries/:id/citations offers it. An org-key agent has to guess a domain before it can ask about one.
- [ ] ?url= silently overriding the :domain path segment is a footgun in the API itself — rejecting the combination, or documenting it in the spec, would be safer.

**`senso industries import-prompts`** · 🔴 high — `POST /org/industries/{industry_id}/prompts/import`

- [ ] The own-industry refusal and the missing-industry refusal are both 403 with no machine-readable code, so the CLI has to string-match English to choose the right hint. A stable `code` on the error body would fix it.
- [ ] Every prompt-level rejection (not found / inactive / empty text / too long / identical text) is a 400. `inactive`, `empty_text`, `text_too_long` and `identical_text` are semantic refusals of a well-formed request — 422 would let a client distinguish 'you sent nonsense' from 'these particular rows cannot be imported'.

**`senso industries list`** · 🟠 medium — `GET /org/industries`

- [ ] GET /org/industries silently falls back to limit=50 for a limit outside 1-100 and to sort=name_asc for an unknown sort, while GET /org/industries/:id/prompts REJECTS both with a 400 (parsePagingOrReject). The two should behave the same way; rejecting is the better behavior.

### `senso partner` <sub>9 items</sub>

**`senso partner glossary`** · 🟠 medium — `GET /partner/glossary`

- [ ] GET /partner/glossary is partner-only, but every metric it defines is returned by /org/industries/* to organization keys. Expose the same static payload on an org route (or make it unauthenticated — it contains no customer data).

**`senso partner industries brand`** · 🟠 medium — `GET /partner/industries/{industry_id}/brands/{brandName}`

- [ ] The partner route also mints brand registry rows on a GET (router.go:915-917 documents it), with no rate limit on either surface.

**`senso partner industries domain`** · 🟠 medium — `GET /partner/industries/{industry_id}/domains/{domainOrUrl}`

- [ ] The :domain path segment and the ?url= query parameter overlap, with url silently winning. Documenting or rejecting the combination would prevent clients from guessing.

**`senso partner industries list`** · 🔴 high — `GET /partner/industries`

- [ ] GET /partner/industries defaults to limit=10 while GET /org/industries defaults to 50; both silently ignore an out-of-range limit. One default and one behavior would be better.
- [ ] An organization key on any /partner/* route gets 401 "Authentication required", which is indistinguishable from an expired or malformed key. A distinct message ("This endpoint requires a partner key") would let a client tell 'wrong kind of credential' from 'bad credential' without the CLI having to infer it.

**`senso partner industries prompt-metrics`** · 🔴 high — `GET /partner/industries/{industry_id}/prompt-metrics`

- [ ] GET /partner/industries/:id/prompt-metrics has no industry-existence gate, so an unknown id is a 200 with an empty list rather than a 404. Every sibling read (summary, brands, brands/:brand, domains/:domain) does 404. Add RequireIndustry here.
- [ ] This endpoint clamps limit/offset while GET /org/industries/:id/prompts rejects them. Pick one.
- [ ] ?group_by=funnel_stage changes the response to a completely different shape with no discriminator beyond the echoed `group_by` field; documenting it in the spec would let clients parse safely.

**`senso partner industries summary`** · 🟠 medium — `GET /partner/industries/{industry_id}/summary`

- [ ] prompts_by_stage is permanently null with the reason in a prose `notes` entry; a typed availability flag would let clients branch.
