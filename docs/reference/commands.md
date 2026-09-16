# Command reference

**This file is generated.** Run `make reference` after changing a command; a policy test fails if it is stale.

Generated from the command tree of `@senso-ai/cli`. Every command accepts the [global options](#global-options).

## Contents

- [`senso login`](#senso-login) — Authenticate with Senso.
- [`senso logout`](#senso-logout) — Remove stored API key and organization info from local config.
- [`senso whoami`](#senso-whoami) — Show which organization you are authenticated as, including org ID, slug, tier, API key prefix and which credential source is in effect.
- [`senso org`](#senso-org) — Read and change the organization your API key belongs to.
- [`senso users`](#senso-users) — Memberships of the organization your API key belongs to.
- [`senso api-keys`](#senso-api-keys) — Inspect the API keys of the organization your key belongs to.
- [`senso search`](#senso-search) — Search the knowledge base with natural language queries.
- [`senso ingest`](#senso-ingest) — Ingest files into the knowledge base.
- [`senso website-import`](#senso-website-import) — Import your organization's website into the knowledge base.
- [`senso content`](#senso-content) — Inspect and manage GENERATED content — items created by `senso engine draft` and `senso engine publish` — through review, publication and ownership.
- [`senso ctas`](#senso-ctas) — Call-to-action templates: the card attached to a published content-engine page, and which one each content item carries.
- [`senso evals`](#senso-evals) — Judge text against your organization's ground truth.
- [`senso gaps`](#senso-gaps) — The gap report: questions and claims your knowledge base could not back up, and what was decided about each — the same queue the Senso app shows.
- [`senso generate`](#senso-generate) — Content generation: read and change the engine's settings, generate one piece of content for a prompt, or start a full run and follow it.
- [`senso engine`](#senso-engine) — Create, update and publish content through the content engine.
- [`senso destinations`](#senso-destinations) — Where published content lands.
- [`senso publish-records`](#senso-publish-records) — Retry a publish that failed for ONE destination, without republishing the whole item.
- [`senso brand-kit`](#senso-brand-kit) — One brand kit per organization: the brand facts and voice rules the AI writer follows when generating content.
- [`senso content-types`](#senso-content-types) — Manage content types — the reusable output formats for AI-generated content (blog post, FAQ, landing page).
- [`senso prompts`](#senso-prompts) — Manage prompts — the tracked GEO questions AI models are asked on your run schedule, which also seed content generation.
- [`senso run-config`](#senso-run-config) — Configure which AI models answer this organization's prompts, and on which days.
- [`senso skills`](#senso-skills) — Install and manage the official Senso skills for AI coding agents (Claude Code, Cursor, Codex, Copilot, Gemini, Cline).
- [`senso members`](#senso-members) — Read-only directory of the organization's members, with email, name, role name and groups.
- [`senso credits`](#senso-credits) — The credit balance of the organization this API key belongs to.
- [`senso questions`](#senso-questions) — Manage the organization's geo questions.
- [`senso kb`](#senso-kb) — The organization's knowledge base: a tree of folders and documents that Senso search and generation read from.
- [`senso permissions`](#senso-permissions) — The catalog of permission keys (action:resource, e.g.
- [`senso tags`](#senso-tags) — Manage the organization's tag library — the shared vocabulary that prompts, KB nodes and content items are labeled with.
- [`senso product-lines`](#senso-product-lines) — Manage product lines — the organization's product and service definitions.
- [`senso roles`](#senso-roles) — The roles of the organization your key belongs to.
- [`senso competitors`](#senso-competitors) — Manage the organization's curated competitor list.
- [`senso tracked-sources`](#senso-tracked-sources) — Manage the rules that classify every URL an AI answer cites into one of three tiers.
- [`senso generated-content`](#senso-generated-content) — Browse content produced by the content engine (`senso engine draft` and `senso engine publish`).
- [`senso analytics`](#senso-analytics) — GEO analytics for your organization — brand visibility, share of voice, and citations across the AI models you monitor.
- [`senso history-imports`](#senso-history-imports) — Read-only view of the run-history import jobs that back-fill this organization's prompts with the history already collected for its industry.
- [`senso industries`](#senso-industries) — Browse the public industry catalog and the competitive intelligence Senso collects for it — brand leaderboards, domain citations and the prompts each industry runs.
- [`senso partner`](#senso-partner) — Partner-network commands.
- [`senso update`](#senso-update) — Update this CLI to the newest @senso-ai/cli published on npm.
- [`senso uninstall`](#senso-uninstall) — Remove everything this CLI put on the machine: the Senso agent skills, the stored API key, then the npm package itself — in that order, so a failure leaves you the CLI to retry with.

## Global options

These are accepted by every command.

| Flag | Description |
|---|---|
| `-v, --version` | output the version number |
| `--api-key <key>` | Override API key (or set SENSO_API_KEY) |
| `--base-url <url>` | Override API base URL |
| `--output <format>` | Output format: json \| table \| plain |
| `--quiet` | Suppress non-essential output |
| `--no-update-check` | Skip version check |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | The API or the runtime refused the request |
| 2 | Usage error: unknown command, missing argument, bad flag |
| 3 | Authentication: no key, or the key was rejected |
| 4 | Not found |
| 5 | Network failure or timeout |

---

## senso login

Authenticate with Senso. Paste your API key and it will be validated against your organization, then stored locally. Interactive only: without a terminal it exits 2 and names the two alternatives.

```
senso login [options]
```

## senso logout

Remove stored API key and organization info from local config. Does not affect SENSO_API_KEY or --api-key.

```
senso logout [options]
```

## senso whoami

Show which organization you are authenticated as, including org ID, slug, tier, API key prefix and which credential source is in effect. Makes one request to GET /org/me.

```
senso whoami [options]
```

## senso org

Read and change the organization your API key belongs to. There is no organization id to pass — every command here acts on the key's own organization (see `senso whoami`). Workflow: `org get` reads the record, `org update` changes name/slug/logo and REPLACES the websites and locations lists, `org set-industry` picks an industry from `senso industries list` once and for all, `org set-runs` is the org-wide pause switch for every scheduled run.

```
senso org [options] [command]
```

### senso org get

Read the organization your API key belongs to: name, slug, logo, websites, locations, industry, AI models, schedules and the org-wide runs switch. Read-only.

```
senso org get [options]
```

### senso org update

Change the organization's name, slug, logo, websites or locations. Only the keys you pass are changed, but `websites` and `locations` REPLACE their whole list: every entry you leave out is deleted. Returns the organization record after the write, and warns about the entries the write removed.

```
senso org update [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON object with any of: "name" (1-255), "slug" (1-255, unique across Senso), "logo_url" ("" clears it), "websites" ([{"url":"https://acme.com"}], the FULL list; [] clears it; an entry takes only url), "locations" ([{"country_code":"US","region_name":"California"}], the FULL list; country_code is exactly 2 letters). Unknown keys exit 2 before any request. |  |

### senso org set-industry

Point the organization at an industry from the public catalog. This can be done ONCE: a second call is refused and changing it afterwards is not self-serve. The industry is what `senso industries import-prompts` and `senso generate industry-draft` work from, and where an org with no models or locations of its own inherits them on activation. Nothing else happens — no prompts are created and no runs start.

```
senso org set-industry [options] <industryId>
```

### senso org set-runs

Flip the organization-wide runs master switch (the `enable_runs` field of `senso org get`). false pauses every scheduled prompt run and content-generation run; true resumes the schedule. Runs already in progress are not canceled.

```
senso org set-runs [options]
```

| Option | Description | Default |
|---|---|---|
| `--enabled <bool>` | true or false. Maps to the API field enable_runs |  |

## senso users

Memberships of the organization your API key belongs to. Three ids appear here: user_id (the person — what every <userId> argument takes), org_user_id (the membership row, informational only) and role_id (a per-organization role UUID from `senso roles list`). This group returns ids only; for emails and names use `senso members list`. Which command to add someone with: `invite` for a brand-new person, `invite-existing` when they already have a Senso account and you know the email, `add` when you already hold their user_id.

```
senso users [options] [command]
```

### senso users list

List memberships of the organization, one row per user: user_id, role_id and whether this organization is the user's active one. Ids only — for emails and names use `senso members list`.

```
senso users list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Rows per page, integer >= 1 (the API defaults to 10) |  |
| `--offset <n>` | Rows to skip, integer >= 0 (default 0) |  |

### senso users add

Add a person who already has a Senso account to the organization, by user_id. Use `senso users invite-existing` when you only know the email, and `senso users invite` when the person has no Senso account yet.

```
senso users add [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "user_id": "<uuid>", "role_id": "<uuid>", "is_current": false }. user_id comes from `senso members list`; role_id from `senso roles list` and must be a role of THIS organization. is_current is optional and is forced true when the person has no active organization yet. |  |

### senso users get

Read one membership: the person's role_id in this organization and whether this organization is their active one. Ids only — for email and name use `senso members list`.

```
senso users get [options] <userId>
```

### senso users update

Change a member's role in this organization, and optionally whether this organization is their active one. role_id is required on every call, even when only is_current is changing.

```
senso users update [options] <userId>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "role_id": "<uuid>", "is_current": true }. role_id is required by the API on every update and must be a role of THIS organization (`senso roles list`); is_current is optional. |  |

### senso users remove

Remove a member from this organization. Their Senso account and their memberships in other organizations are untouched.

```
senso users remove [options] <userId>
```

### senso users set-current

Make this organization the member's active (current) organization: the one the Senso dashboard opens for them. Only one organization is current per user. Same effect as is_current in `senso users update`, without having to send a role_id.

```
senso users set-current [options] <userId>
```

### senso users invite

Create a Senso account for a person (in Clerk and Senso) and add them to this organization with a role. An account that already exists for the email is reused. This command does not send an invitation email.

```
senso users invite [options]
```

| Option | Description | Default |
|---|---|---|
| `--email <email>` | The person's email address |  |
| `--given-name <name>` | First name, 1-255 characters (API field given_name) |  |
| `--family-name <name>` | Last name, 1-255 characters (API field family_name) |  |
| `--role-id <uuid>` | A role of THIS organization — resolve the name with `senso roles list` |  |
| `--is-current` | Make this organization the person's active organization |  |

### senso users invite-existing

Add a person who already has a Senso account to this organization, by email. Answers 404 when no account has that email — use `senso users invite` to create one.

```
senso users invite-existing [options]
```

| Option | Description | Default |
|---|---|---|
| `--email <email>` | Email of an existing Senso account |  |
| `--role-id <uuid>` | A role of THIS organization — resolve the name with `senso roles list` |  |
| `--is-current` | Make this organization the person's active organization |  |

## senso api-keys

Inspect the API keys of the organization your key belongs to. Every command takes the key's id (a UUID from `api-keys list`), never the secret. Creating, renaming, revoking, deleting a key and changing its knowledge-base scope require a signed-in dashboard user — the API answers 403 to any API key — so over the CLI this group is effectively read-only: `list` → `get` → `kb-permissions-get`.

```
senso api-keys [options] [command]
```

### senso api-keys list

One page of the organization's API keys. Secrets are never returned. Revoked keys (revoked_at set) and expired keys (expires_at in the past) are included.

```
senso api-keys list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Rows per page, integer >= 1 (the API defaults to 10) |  |
| `--offset <n>` | Rows to skip, integer >= 0 (default 0) |  |

### senso api-keys create

Create an API key. The secret is in the `key` field of the payload and is returned exactly once — the API never shows it again, and no other command can retrieve it.

```
senso api-keys create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "ci-deploy", "expires_at": "2026-12-31T00:00:00Z" }. name is required (1-255 characters); expires_at is optional ISO 8601 — omit it for a key that never expires. |  |

### senso api-keys get

Read one API key of the organization. The secret is never returned.

```
senso api-keys get [options] <keyId>
```

### senso api-keys update

Rename an API key or change its expiry. The API requires `name` on every update, so an expires_at-only change is not possible.

```
senso api-keys update [options] <keyId>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "new-name", "expires_at": "2027-01-01T00:00:00Z" }. name is required by the API even when only the expiry is changing; expires_at is optional ISO 8601. |  |

### senso api-keys delete

Permanently delete an API key. This cannot be undone.

```
senso api-keys delete [options] <keyId>
```

### senso api-keys revoke

Revoke an API key. The key stays listed, with revoked_at set, and no longer authenticates.

```
senso api-keys revoke [options] <keyId>
```

### senso api-keys kb-permissions-get

List the knowledge base folder grants that restrict a key. A scoped key can only read and search within the folders listed; an unscoped key has full organization access.

```
senso api-keys kb-permissions-get [options] <keyId>
```

### senso api-keys kb-permissions-set

Set the knowledge base folder grants for an API key. REPLACES the existing grants: the list you send becomes the whole scope. At least one grant is required — to clear the scope use `senso api-keys kb-permissions-delete`.

```
senso api-keys kb-permissions-set [options] <keyId>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "grants": [{ "node_id": "<kb_node_id>", "role": "viewer" }] }. node_id is a folder from `senso kb my-files`; role is one of viewer, editor, owner (`admin` is the org-admin bypass and is not grantable). At least one grant. |  |

### senso api-keys kb-permissions-delete

Remove every knowledge base folder grant from an API key, restoring full organization access for that key.

```
senso api-keys kb-permissions-delete [options] <keyId>
```

## senso search

Search the knowledge base with natural language queries. Returns AI-generated answers synthesized from matching content chunks, or raw chunks/content IDs. An answering search (`search`, `search full`, `search stream`) that finds nothing is filed in the organization's gap report as an API search gap — read them with `senso gaps list --origin api_unanswered_question --status weak --status open`. Pass --no-gap-signals, or set SENSO_GAP_SIGNALS=off, on probes and tests so they do not.

```
senso search [options] [command] <query>
```

| Option | Description | Default |
|---|---|---|
| `--max-results <n>` | How many results to return. Integer 1-20; out of range exits 2, nothing is clamped | `5` |
| `--content-ids <ids...>` | Restrict the search to these content items. Space-separated content_id UUIDs from a previous result — NOT kb_node_ids |  |
| `--require-scoped-ids` | Fail rather than fall back to the whole knowledge base. Requires --content-ids |  |
| `--no-gap-signals` | Keep this search out of the organization's gap report (sends X-Senso-Signals: off). Use it for probes, tests and monitors — a real question that finds nothing should be left eligible. The search still runs, costs credits and is recorded. Set SENSO_GAP_SIGNALS=off to do this for every search. |  |

### senso search context

Search the knowledge base — returns matching content chunks only, without AI answer generation. Use this to feed verified chunks into your own LLM pipeline instead of using Senso's generated answer.

```
senso search context [options] <query>
```

| Option | Description | Default |
|---|---|---|
| `--max-results <n>` | How many results to return. Integer 1-20; out of range exits 2, nothing is clamped | `5` |
| `--content-ids <ids...>` | Restrict the search to these content items. Space-separated content_id UUIDs from a previous result — NOT kb_node_ids |  |
| `--require-scoped-ids` | Fail rather than fall back to the whole knowledge base. Requires --content-ids |  |
| `--no-gap-signals` | Keep this search out of the organization's gap report (sends X-Senso-Signals: off). Use it for probes, tests and monitors — a real question that finds nothing should be left eligible. The search still runs, costs credits and is recorded. Set SENSO_GAP_SIGNALS=off to do this for every search. |  |

### senso search content

Search the knowledge base — returns deduplicated matches with no chunks: each carries the KB node ID to read it with 'kb get <id>', and the content ID to scope a later search with --content-ids.

```
senso search content [options] <query>
```

| Option | Description | Default |
|---|---|---|
| `--max-results <n>` | How many results to return. Integer 1-20; out of range exits 2, nothing is clamped | `5` |
| `--content-ids <ids...>` | Restrict the search to these content items. Space-separated content_id UUIDs from a previous result — NOT kb_node_ids |  |
| `--require-scoped-ids` | Fail rather than fall back to the whole knowledge base. Requires --content-ids |  |
| `--no-gap-signals` | Keep this search out of the organization's gap report (sends X-Senso-Signals: off). Use it for probes, tests and monitors — a real question that finds nothing should be left eligible. The search still runs, costs credits and is recorded. Set SENSO_GAP_SIGNALS=off to do this for every search. |  |

### senso search full

Alias for the default search — returns AI answer plus matching chunks. Equivalent to 'senso search <query>', and renders identically.

```
senso search full [options] <query>
```

| Option | Description | Default |
|---|---|---|
| `--max-results <n>` | How many results to return. Integer 1-20; out of range exits 2, nothing is clamped | `5` |
| `--content-ids <ids...>` | Restrict the search to these content items. Space-separated content_id UUIDs from a previous result — NOT kb_node_ids |  |
| `--require-scoped-ids` | Fail rather than fall back to the whole knowledge base. Requires --content-ids |  |
| `--no-gap-signals` | Keep this search out of the organization's gap report (sends X-Senso-Signals: off). Use it for probes, tests and monitors — a real question that finds nothing should be left eligible. The search still runs, costs credits and is recorded. Set SENSO_GAP_SIGNALS=off to do this for every search. |  |

### senso search stream

Streaming search — returns AI answer tokens in real-time via SSE, followed by source chunks. Use this for a responsive, live search experience.

```
senso search stream [options] <query>
```

| Option | Description | Default |
|---|---|---|
| `--max-results <n>` | How many results to return. Integer 1-20; out of range exits 2, nothing is clamped | `5` |
| `--content-ids <ids...>` | Restrict the search to these content items. Space-separated content_id UUIDs from a previous result — NOT kb_node_ids |  |
| `--require-scoped-ids` | Fail rather than fall back to the whole knowledge base. Requires --content-ids |  |
| `--no-gap-signals` | Keep this search out of the organization's gap report (sends X-Senso-Signals: off). Use it for probes, tests and monitors — a real question that finds nothing should be left eligible. The search still runs, costs credits and is recorded. Set SENSO_GAP_SIGNALS=off to do this for every search. |  |

## senso ingest

Ingest files into the knowledge base. Upload documents (PDF, TXT, DOCX, etc.) to be parsed, chunked, and embedded for semantic search. Ingestion is asynchronous: the id to keep is kb_node_id, and `senso kb get <kb_node_id>` says when the file is searchable.

```
senso ingest [options] [command]
```

### senso ingest upload

Upload files to the knowledge base. Accepts local file paths (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker. Poll 'senso kb get <kb_node_id>' — the kb_node_id printed for each accepted file — until content.processing_status is 'complete' before searching the uploaded content.

```
senso ingest upload [options] <files...>
```

| Option | Description | Default |
|---|---|---|
| `--folder-id <id>` | Destination folder, as its kb_node_id (from `senso kb my-files`). Without it: the interactive picker on a terminal, the organization's root folder otherwise |  |

### senso ingest reprocess

Re-ingest an existing document with a new file version. The node keeps its kb_node_id and content_id; a new version and a new ingestion run are created.

```
senso ingest reprocess [options] <kb_node_id> <file>
```

## senso website-import

Import your organization's website into the knowledge base. Fetches the home page plus up to 10 linked pages, ingests each as a document under a folder named 'Website', and drafts a brand kit if the organization does not have one yet.

```
senso website-import [options] [command]
```

### senso website-import start

Start a website import and wait for it to finish. The site imported is the one on file for your organization — see 'senso org get' — not a value you pass, so this takes no arguments. Exits 1 if the import finishes in a failed state.

```
senso website-import start [options]
```

| Option | Description | Default |
|---|---|---|
| `--no-wait` | Return the accepted run immediately instead of polling until the import finishes. |  |

### senso website-import status

Show the website import in flight and the most recently finished one. Either may be absent. This is a read: it exits 0 even when the last import failed.

```
senso website-import status [options]
```

## senso content

Inspect and manage GENERATED content — items created by `senso engine draft` and `senso engine publish` — through review, publication and ownership. Knowledge base documents are not managed here: use `senso kb`. Ids: content_id from `senso content verification` (items[].content_id), version_id from `senso content versions` (reject and restore take that one), publish_record_id from `senso content verification` (items[].destinations[].publish_record_id). Most commands need the GEO product; `content list` and `content tags` do not.

```
senso content [options] [command]
```

### senso content list

List top-level knowledge base files and folders. Deprecated: this returns KB NODES, so each id is a kb_node_id and `senso content get` rejects it. Prefer `senso kb my-files`, which returns the same rows with every field.

```
senso content list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Items per page. The API caps this at 50 | `10` |
| `--offset <n>` | Pagination offset | `0` |

### senso content get

Read one GENERATED content item: its current version's title, summary, rendered text, editorial status and tags. This endpoint serves generated content ONLY — a knowledge base document is refused, even though its id is a valid content_id. Read those with `senso kb get <kb_node_id>` (metadata) or `senso kb content <kb_node_id>` (text). It does NOT return the version history (`senso content versions`) or publish records (`senso content verification`).

```
senso content get [options] <id>
```

### senso content delete

Permanently delete one GENERATED content item and remove it from every external destination. This cannot be undone, and it is not atomic: the destinations are cleared first, so a failure there leaves the local item in place. Knowledge base documents are refused — delete those with `senso kb delete <kb_node_id>`.

```
senso content delete [options] <id>
```

### senso content unpublish

Retract a published content item. With no flags it removes the content from EVERY destination it is live on, and the version returns to draft once no live publish record remains. With --publish-record-ids only those destinations are retracted and the rest stay live. Only generated content — content created by `senso engine publish` — can be unpublished.

```
senso content unpublish [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--publish-record-ids <ids...>` | Restrict the unpublish to these publish_record_id UUIDs, from `senso content verification --status published` (items[].destinations[].publish_record_id). Every value must be a UUID: the API reads a list it cannot parse as no list at all and would then unpublish everywhere |  |

### senso content verification

List generated content in the review pipeline with its editorial status, owners, tags, per-destination publish records and citation metrics. This is where content_id, version_id and publish_record_id all come from.

```
senso content verification [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Rows per page, 1-100. The API silently returns 10 for anything else |  |
| `--offset <n>` | Rows to skip |  |
| `--search <query>` | Substring match on the title |  |
| `--status <status>` | Filter by editorial status: all \| draft \| review \| rejected \| published. NOTE: the API treats `review` as an alias for `draft` — the two return the same rows |  |
| `--substatus <substatus>` | Narrow one status further: pending_draft (requires --status published) \| unpublished (requires --status draft) |  |
| `--tag-ids <ids>` | Comma-separated tag UUIDs, from `senso tags list` |  |
| `--sort <sort>` | Order the queue: citation_rate_desc \| citation_rate_asc \| raw_citations_desc \| raw_citations_asc |  |

### senso content verification-counts

Count generated content by editorial status, plus a per-publisher rollup of published items and how often they are cited. One cheap call instead of paging through `content verification`. Requires the GEO product.

```
senso content verification-counts [options]
```

### senso content verification-velocity

How long published content takes to earn its first AI citation, for the whole organization and per publisher. All-time: there is no date window. Requires the GEO product.

```
senso content verification-velocity [options]
```

### senso content provenance

Audit one live published URL end to end: how its knowledge base sources were ingested, the retrieved chunks and model context, the accepted generation attempt, the editing history, and every publish record. Each stage reports what the stored evidence proves and what is missing rather than guessing. Requires the GEO product.

```
senso content provenance [options]
```

| Option | Description | Default |
|---|---|---|
| `--url <url>` | The live published URL to audit, matched EXACTLY against a publish record's external_url — scheme, case and a trailing slash all matter. Real URLs come from `senso content verification --status published` (items[].destinations[].external_url) |  |

### senso content citation-details

Citation performance for one PUBLISHED content item: a pooled summary across its live destinations, the same metrics per destination, and a daily trend. Requires the GEO product.

```
senso content citation-details [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--start-date <YYYY-MM-DD>` | Inclusive start of the window. Omit both dates for all time |  |
| `--end-date <YYYY-MM-DD>` | Inclusive end of the window; not before --start-date |  |
| `--models <list>` | Comma-separated models to filter by. Currently: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok, google_ai_overviews, claude, gpt. Omit for all |  |
| `--locations <list>` | Comma-separated locations to filter by. There is no allow-list: an unrecognized name returns an empty result rather than an error |  |

### senso content citation-prompts

Which prompts a published page is winning: every prompt/model pair whose question runs cite one of this content's live URLs, with the mention-rate and share-of-voice LIFT against runs of the same prompt that cite none of them. Requires the GEO product.

```
senso content citation-prompts [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--start-date <YYYY-MM-DD>` | Inclusive start of the window. Omit both dates for all time |  |
| `--end-date <YYYY-MM-DD>` | Inclusive end of the window; not before --start-date |  |
| `--models <list>` | Comma-separated models to filter by. Currently: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok, google_ai_overviews, claude, gpt. Omit for all |  |
| `--locations <list>` | Comma-separated locations to filter by. No allow-list: an unknown name narrows to nothing silently |  |
| `--destinations <list>` | Comma-separated publisher slugs to restrict to. The API IGNORES a slug it does not recognize, so a typo widens the result instead of failing |  |

### senso content record-edits

Record Builder edit-telemetry events for one content item in bulk, and return how many were inserted versus skipped as duplicates. Events are written ONE AT A TIME with no transaction: if one is rejected the request fails with the earlier events already recorded, and the API does not report how many that was. Give every event a client_event_id — an event repeating one already seen is skipped — so that retrying the whole batch is safe. Requires the GEO product.

```
senso content record-edits [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "events": [{ "event_type": "<ai_patch_requested \| ai_patch_proposed \| ai_patch_accepted \| ai_patch_rejected \| ai_patch_failed \| manual_edit_session_closed \| draft_saved \| published>", "edit_source": "<manual \| ai \| system>", "client_event_id": "<uuid>", "session_id": "<uuid>", "content_version_id": "<uuid>", "generation_run_id": "<uuid>", "payload": {}, "meta_data": {}, "client_created_at": "<RFC3339>" }] } |  |

### senso content versions

List the full revision history of one content item, newest first. Every version is returned — there is no paging. This is where version_id values come from: `content reject` and `content restore` take a version_id, not a content_id.

```
senso content versions [options] <id>
```

### senso content reject

Reject one content VERSION in the review workflow: its editorial status becomes `rejected` and the reason is recorded against it. Rejecting does NOT take a live page down — use `senso content unpublish` for that. Undo it with `senso content restore`.

```
senso content reject [options] <versionId>
```

| Option | Description | Default |
|---|---|---|
| `--reason <text>` | Why it was rejected. Strongly recommended: this is the only record of the decision, and it surfaces as items[].rejection.reason on `senso content verification --status rejected` |  |

### senso content restore

Set one content VERSION back to draft so it can be edited and published again. Normally used to undo `senso content reject`. The API does not check the version's current status: restoring a PUBLISHED version marks it draft but leaves its publish records live, so the page stays up while the record says draft. Take a live page down with `senso content unpublish <content_id>`.

```
senso content restore [options] <versionId>
```

### senso content owners

List the organization members assigned as owners of one content item. Owners are metadata: they are recorded here and surfaced as items[].owners on `senso content verification`, and nothing in the CLI enforces their approval.

```
senso content owners [options] <id>
```

### senso content set-owners

Replace the owner list of one content item. This is a REPLACE, not an add: any owner not named in --user-ids is removed. To drop one owner without listing all the others, use `senso content remove-owner`.

```
senso content set-owners [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--user-ids <ids...>` | One or more user_id UUIDs, from `senso members list`. Each must already be a member of this organization |  |

### senso content remove-owner

Remove one owner from one content item. Idempotent: removing someone who is not an owner succeeds.

```
senso content remove-owner [options] <id> <userId>
```

### senso content tags

Manage the tags attached to one content item. Unlike the rest of `senso content`, these four commands accept BOTH knowledge-base and generated content_id values, and they need neither the GEO product nor a permission scope. Content is auto-tagged when it is created (KB uploads once ingestion finishes, raw content on create); these override that afterwards. Tag names are resolved against the organization's tag library and unknown names are created. Note the flag shapes differ: `set` takes the comma-separated lists --names / --ids, while `add` and `remove` take a single --name / --id.

```
senso content tags [options] [command]
```

### senso content tags list

List the tags attached to one content item. Works on knowledge-base documents and generated content alike.

```
senso content tags list [options] <id>
```

### senso content tags set

REPLACE the whole tag collection of one content item: any tag not named in --names or --ids is detached. To empty the collection pass --clear; a bare `set` with no flags is refused rather than silently removing every tag, which is what the API does with an empty body.

```
senso content tags set [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--names <list>` | Comma-separated tag names. Names not in the tag library are created |  |
| `--ids <list>` | Comma-separated existing tag UUIDs, from `senso tags list` |  |
| `--clear` | Detach every tag. Mutually exclusive with --names and --ids |  |

### senso content tags add

Attach ONE tag to a content item. Idempotent: attaching a tag that is already attached succeeds. Works on knowledge-base documents and generated content alike.

```
senso content tags add [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name. Created in the organization's tag library if it is new |  |
| `--id <tagId>` | Existing tag UUID, from `senso tags list` |  |

### senso content tags remove

Detach ONE tag from a content item. This is a silent no-op when the tag is not attached and — with --name — when no tag of that name exists in the organization at all, so a typo reports success. Check the result with `senso content tags list <id>`.

```
senso content tags remove [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name to detach, sent as the `name` query parameter |  |
| `--id <tagId>` | Existing tag UUID to detach, from `senso tags list` |  |

## senso ctas

Call-to-action templates: the card attached to a published content-engine page, and which one each content item carries. One template can be the organization default; each item inherits it (default), pins one (template), or carries none. Requires the GEO product.

```
senso ctas [options] [command]
```

### senso ctas list

List the organization's CTA templates, the default first and the rest oldest first. This is where a cta_id comes from for `ctas update`, `ctas delete`, `ctas set-default` and `ctas set-for-content`.

```
senso ctas list [options]
```

### senso ctas create

Create a CTA template and return it with its new cta_id. With "is_default": true it becomes the organization default in the same call, replacing any previous default — and the live pages that inherit the default are updated.

```
senso ctas create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "title": <=255, "button_label": <=120, "target_url": absolute URL, "description": <=2000, "eyebrow": <=120, "image_url": absolute URL, "image_position": {"x":0-1,"y":0-1}, "agent_text": <=2000, "is_default": bool } |  |

### senso ctas update

Replace a CTA template (PUT) and return it. The body is the WHOLE template: any optional key you omit is cleared, so read the current values with `senso ctas list` first. "is_default": true promotes it; false or omitted leaves the default flag as it is. Live pages carrying this template are updated to match.

```
senso ctas update [options] <ctaId>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON with the same keys and limits as `senso ctas create`. title, button_label and target_url are required on every call. |  |

### senso ctas delete

Delete a CTA template. The organization default cannot be deleted: clear it with `senso ctas clear-default`, or make another template the default first. Content items pinned to the deleted template fall back to the default.

```
senso ctas delete [options] <ctaId>
```

### senso ctas set-default

Make a template the organization default, replacing any previous default, and return it. Every content item on the `default` selection now resolves to this template: pages that are already live and inherit the default are updated immediately, and everything else picks it up at its next publish.

```
senso ctas set-default [options] <ctaId>
```

### senso ctas clear-default

Make no template the organization default. Live content items that inherit the default switch to no CTA and their pages drop the card; items that are not live keep the `default` selection, which resolves to nothing until a default is set again. Succeeds even when no default was set.

```
senso ctas clear-default [options]
```

### senso ctas for-content

Show which CTA a content item carries when it is published — default (the organization default), template (a pinned cta_id), or none — and the template that selection resolves to.

```
senso ctas for-content [options] <contentId>
```

### senso ctas set-for-content

Choose which CTA a content item carries when it is published, and return the stored selection. This replaces the previous selection, and if the item is already live its page is updated now.

```
senso ctas set-for-content [options] <contentId>
```

| Option | Description | Default |
|---|---|---|
| `--selection <type>` | default (inherit the organization default) \| template (pin --cta-id) \| none (publish without a card) |  |
| `--cta-id <uuid>` | The template to pin, from `senso ctas list`. Required with --selection template, and rejected otherwise. |  |

### senso ctas upload-url

Get a short-lived pre-signed URL for a CTA image. The CLI does not upload the file: PUT the bytes to upload_url yourself with exactly the returned upload_headers, then pass the returned image_url as a template's image_url in `ctas create` or `ctas update`.

```
senso ctas upload-url [options]
```

| Option | Description | Default |
|---|---|---|
| `--filename <name>` | The file's name, at most 255 characters. Its extension, when it has one, must match --content-type. |  |
| `--content-type <type>` | The image media type: image/png \| image/jpeg \| image/webp \| image/gif |  |
| `--size <bytes>` | The file size in bytes, 1 to 10485760 (10 MiB) |  |

## senso evals

Judge text against your organization's ground truth. `kb_accuracy` verifies the factual claims a text makes about your brand against your knowledge base; `brand_alignment` grades it against your brand kit's writing rules. Every run records the claims it checked, the verdict and the evidence, so a score can be audited rather than trusted. Judge model spend is recorded on each run but is not billed against your credit balance. Typical loop: `evals evaluators` to see what can run, `evals text --wait` or `evals content --wait` to judge something, then `evals claims --run-id <id>` for the grain the score is built from.

```
senso evals [options] [command]
```

### senso evals evaluators

List the evaluators available to this organization, with the version each one is currently on. Use `latest_version` here to pin `--evaluator-version` on a trigger.

```
senso evals evaluators [options]
```

### senso evals text

Judge text you supply. Pass it with --text, or --text-file to read it from a file. Returns straight away with a run handle; add --wait to poll until the run finishes and print the finished run instead.

```
senso evals text [options]
```

| Option | Description | Default |
|---|---|---|
| `--evaluator <key>` | Which check to run: kb_accuracy, brand_alignment (default kb_accuracy) |  |
| `--evaluator-version <v>` | Pin an evaluator version (see `senso evals evaluators`) |  |
| `--judge-model <model>` | Override the model that judges the text |  |
| `--label <text>` | Free-form tag stored on the run, for finding it later |  |
| `--idempotency-key <key>` | Makes the trigger safe to retry — the same key returns the original run |  |
| `--wait` | Poll until the run finishes instead of returning a handle straight away |  |
| `--text <text>` | The text to judge. Mutually exclusive with --text-file |  |
| `--text-file <path>` | Read the text to judge from a file. Mutually exclusive with --text |  |
| `--title <title>` | Optional title, stored with the run's subject (max 255 chars) |  |

### senso evals runs

List eval runs, newest first. Each row carries the score and the claim counts behind it, so a run can be read without opening it.

```
senso evals runs [options]
```

| Option | Description | Default |
|---|---|---|
| `--from <instant>` | Only items created at or after this RFC 3339 instant, e.g. 2026-09-01T00:00:00Z |  |
| `--to <instant>` | Only items created before this RFC 3339 instant (exclusive) |  |
| `--evaluator <key>` | Filter by evaluator key (see `senso evals evaluators`) |  |
| `--subject-type <type>` | Filter by subject type, e.g. inline or content |  |
| `--limit <n>` | Page size, 1-100 (default 25) |  |
| `--offset <n>` | Number of items to skip (default 0) |  |

### senso evals get

Get one eval run in full — every claim it checked, the verdict, the evidence behind it, and what the judge searched for. This is the auditable form of a score.

```
senso evals get [options] <runId>
```

### senso evals claims

List the individual claims evaluators have judged, across runs. This is the grain a score is built from: each row carries the claim, the verdict, whether it counted toward the score, and the evidence the judge relied on. Narrow to one run with --run-id.

```
senso evals claims [options]
```

| Option | Description | Default |
|---|---|---|
| `--from <instant>` | Only items created at or after this RFC 3339 instant, e.g. 2026-09-01T00:00:00Z |  |
| `--to <instant>` | Only items created before this RFC 3339 instant (exclusive) |  |
| `--evaluator <key>` | Filter by evaluator key (see `senso evals evaluators`) |  |
| `--subject-type <type>` | Filter by subject type, e.g. inline or content |  |
| `--limit <n>` | Page size, 1-100 (default 25) |  |
| `--offset <n>` | Number of items to skip (default 0) |  |
| `--run-id <id>` | Only claims from this eval run (an eval_run_id from `senso evals runs`) |  |

### senso evals content

Judge a saved content item by its content id. Its latest saved version is what gets judged. Add --wait to poll until the run finishes.

```
senso evals content [options] <contentId>
```

| Option | Description | Default |
|---|---|---|
| `--evaluator <key>` | Which check to run: kb_accuracy, brand_alignment (default kb_accuracy) |  |
| `--evaluator-version <v>` | Pin an evaluator version (see `senso evals evaluators`) |  |
| `--judge-model <model>` | Override the model that judges the text |  |
| `--label <text>` | Free-form tag stored on the run, for finding it later |  |
| `--idempotency-key <key>` | Makes the trigger safe to retry — the same key returns the original run |  |
| `--wait` | Poll until the run finishes instead of returning a handle straight away |  |

## senso gaps

The gap report: questions and claims your knowledge base could not back up, and what was decided about each — the same queue the Senso app shows. Each gap has a PROBLEM (not_found: a question nothing answered; no_source: a claim nothing backs; conflict: the knowledge base contradicts it; flagged: a person marked an answer wrong), a STATUS (weak: seen once and hidden by default; open; reopened; addressed: a fix is recorded and awaits confirmation; resolved; dismissed; dormant), and an ORIGIN saying where it came from. A search through the API, the MCP server or this CLI that finds nothing files an api_unanswered_question gap: weak on the first call, open on the second, and resolved by a later API search that finds a sourced answer. Typical loop: `gaps list` to find work, `gaps get <id>` for the evidence and the exact next commands, write content with `kb create-raw`, then `gaps answer <id> --content-id <id>`; or `gaps dismiss <id>` for noise. Every decision can be undone with `gaps undo`.

```
senso gaps [options] [command]
```

### senso gaps list

List gaps, most severe first. With no --status, only open, reopened and addressed gaps are returned — a gap seen once is weak and hidden, so pass --status weak (or --status all) to see new API search gaps. Repeat a filter or comma-separate it to OR values; different filters are ANDed. Plain output ends with the paging position and the command to read a gap.

```
senso gaps list [options]
```

| Option | Description | Default |
|---|---|---|
| `--status <status>` | Filter by status, repeatable: weak, open, reopened, addressed, resolved, dismissed, dormant, or all (default open, reopened, addressed) |  |
| `--problem <problem>` | Filter by problem, repeatable: conflict, not_found, no_source, flagged |  |
| `--origin <origin>` | Filter by origin, repeatable: claim, unanswered_question, documents_didnt_answer, flagged_answer, api_unanswered_question. api_unanswered_question is a search through the API, MCP server or CLI that found nothing |  |
| `--surface <surface>` | Filter by where it was seen, repeatable: search_turn, content, question_run, api_search |  |
| `--kind <kind>` | Filter by kind, repeatable: missing, conflict, kb_conflict, flagged |  |
| `--tag <tagId>` | Filter by topic tag id, repeatable (see `senso tags list`) |  |
| `--search <text>` | Only gaps whose text contains this |  |
| `--sort <order>` | severity \| recent \| demand (default severity) |  |
| `--limit <n>` | Page size, 1-100 (default 50) |  |
| `--offset <n>` | Number of gaps to skip (default 0) |  |

### senso gaps get

Get one gap in full: the gap, every sighting behind it, every decision recorded against it, and the evidence — what the search found (retrieval counts and best score), the quote and reasoning behind a judged claim, the documents weighed or cited with their kb_node_id and content_id, and any feedback a person left. Plain output ends with the exact commands to act on this gap, chosen from its problem and status.

```
senso gaps get [options] <gapId>
```

### senso gaps resolve

Record what was done about a gap, and move it accordingly. Types, with the status each leaves the gap in: answered → addressed: an answer was written into the knowledge base. Needs --produced-content-id. content_added → addressed: a new document was added. Needs --produced-content-id. content_updated → addressed: an existing document was improved. Needs --produced-content-id. ruled_kb_correct → resolved: the knowledge base was already right; the claim was wrong. ruled_claim_correct → no status change: the claim is right and the named document is stale; update that document next and record content_updated. Needs --authority-content-id. ruled_document → no status change: of two contradicting documents, the named one is right; update the other and record content_updated. Needs --authority-content-id. dismissed → dismissed: it does not matter. not_relevant → dismissed: nothing was wrong. we_dont_do_this → resolved: the organization does not do this, and recording that is the fix. source_irrelevant → dismissed: the answer used the wrong source; the named document should not have been used. Needs --authority-content-id. For the two common cases use the shortcuts `gaps answer` and `gaps dismiss`. Undo any decision with `gaps undo`.

```
senso gaps resolve [options] <gapId>
```

| Option | Description | Default |
|---|---|---|
| `--type <type>` | One of: answered, content_added, content_updated, ruled_kb_correct, ruled_claim_correct, ruled_document, dismissed, not_relevant, we_dont_do_this, source_irrelevant |  |
| `--produced-content-id <id>` | The content that was written — required for answered, content_added and content_updated |  |
| `--authority-content-id <id>` | The document the decision is about — required for ruled_claim_correct, ruled_document and source_irrelevant |  |
| `--ruling-side <side>` | Which side a ruling found correct: kb, claim, document |  |
| `--notes <text>` | Why, in a sentence — shown on the gap's timeline |  |

### senso gaps answer

Record that content was written to fix a gap — the usual last step after `senso kb create-raw`. Records `answered` (or `content_updated` with --updated, when an existing document was improved instead). The gap becomes addressed and resolves when a later search or evaluation confirms the answer; for an API search gap, that is the next API search for the same question that returns a sourced answer.

```
senso gaps answer [options] <gapId>
```

| Option | Description | Default |
|---|---|---|
| `--content-id <id>` | The content that answers it: the `id` from `senso kb create-raw`, or a `content_id` from `senso kb get` |  |
| `--updated` | An existing document was improved, rather than a new one written |  |
| `--notes <text>` | What was written, in a sentence |  |

### senso gaps dismiss

Close a gap that does not need fixing — integration noise, a test or probe search, a question nobody needs answered. Records `dismissed`. A dismissed gap stays closed even if it is seen again; only `gaps undo` reopens it. To keep future probe searches out of the report, run them with `senso search --no-gap-signals`.

```
senso gaps dismiss [options] <gapId>
```

| Option | Description | Default |
|---|---|---|
| `--notes <text>` | Why it does not matter, in a sentence |  |

### senso gaps undo

Retract one recorded decision. The gap's status is recomputed from the decisions that remain — undoing the newer of two returns it to what the older one implied, and undoing the only one makes it open again. Resolution ids are on `gaps get` and in the output of `resolve`, `answer` and `dismiss`.

```
senso gaps undo [options] <gapId> <resolutionId>
```

## senso generate

Content generation: read and change the engine's settings, generate one piece of content for a prompt, or start a full run and follow it. Requires the GEO product; `sample`, `run` and `industry-draft` consume credits.

```
senso generate [options] [command]
```

### senso generate settings

Show the organization's content generation settings: whether generation and auto-publish are on, the days scheduled runs happen, the default content type, and the destinations selected for generation.

```
senso generate settings [options]
```

### senso generate update-settings

Change the organization's content generation settings. PATCH semantics: a key you omit is left unchanged, and "selected_content_type_id": null clears the selection. Returns the full settings object.

```
senso generate update-settings [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON with any of: enable_content_generation (bool), content_auto_publish (bool), content_schedule (array of 0-6, 0 = Sunday), selected_content_type_id (uuid or null) |  |

### senso generate sample

Generate one piece of content for a prompt and wait for it. Submits an async job, polls every 2 s for up to 180 s, and returns the generated draft. The draft IS saved (it comes back with a content_id); with --destination it is also published immediately. Consumes credits.

```
senso generate sample [options]
```

| Option | Description | Default |
|---|---|---|
| `--prompt-id <uuid>` | The prompt to write for: a geo_question_id from `senso prompts list` |  |
| `--content-type-id <uuid>` | The format to write in: a content_type_id from `senso content-types list` |  |
| `--destination <slug>` | Publish right after generating. A destination SLUG from `senso destinations list` (citeables, codeables, cucopilot or a custom one) — not a publisher_id. Omit to keep a draft. |  |
| `--no-wait` | Return the accepted job immediately. Poll it with `senso generate sample-status <sample_job_id>`. |  |

### senso generate sample-status

Read one sample generation job: its status, and its result once it has completed. This is what `generate sample --no-wait` hands back an id for.

```
senso generate sample-status [options] <sampleJobId>
```

### senso generate run

Start a content generation run over every prompt, or the ones named. Returns immediately with a run_id; the run continues server-side. Consumes credits per prompt generated, and only one run can be active per organization.

```
senso generate run [options]
```

| Option | Description | Default |
|---|---|---|
| `--prompt-ids <ids...>` | Prompts to process: geo_question_id values from `senso prompts list`. Omit to process every prompt in the job context. |  |
| `--content-type-id <uuid>` | Override the settings' selected_content_type_id for this run (from `senso content-types list`) |  |
| `--publisher-ids <ids...>` | Publish only to these destinations: publisher_id values (not slugs) from `senso destinations list`. Omit to use every destination selected for generation. |  |

### senso generate job-context

Show what a full run would do: every prompt with whether it would create new content or update existing content, plus the counts. This is the set `senso generate run` processes when --prompt-ids is omitted.

```
senso generate job-context [options]
```

### senso generate runs-list

List the organization's content generation runs, newest first. Each run is one execution of `generate run` or of the schedule, with counts of its per-prompt items.

```
senso generate runs-list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Runs per page, at least 1 | `20` |
| `--offset <n>` | Runs to skip | `0` |
| `--status <status>` | Only runs in this status: queued, running, completed, partial_failed, failed, dispatch_failed, blocked, skipped, stopped |  |
| `--active-only` | Only queued and running runs (the API's `active` flag) |  |
| `--start-date <date>` | Runs created on or after this date (YYYY-MM-DD or RFC 3339) |  |
| `--end-date <date>` | Runs created on or before this date (YYYY-MM-DD or RFC 3339) |  |

### senso generate runs-get

Show one content generation run: its status, item counts and timestamps. Poll this until the status is terminal.

```
senso generate runs-get [options] <runId>
```

### senso generate runs-items

List the per-prompt items of a run: which prompt each was, what happened to it, and the content_id it produced.

```
senso generate runs-items [options] <runId>
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Items per page, at least 1 | `100` |
| `--offset <n>` | Items to skip | `0` |
| `--status <status>` | Only items in this status: pending, running, succeeded, failed, skipped, stopped |  |

### senso generate runs-logs

List the log lines a run emitted, oldest first. This is where the reason an item failed is written; run_item_id links a line to a row of `generate runs-items`.

```
senso generate runs-logs [options] <runId>
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Lines per page, at least 1 | `100` |
| `--offset <n>` | Lines to skip | `0` |

### senso generate industry-draft

Draft a complete document from one of your industry's prompts in a single synchronous call, grounded in your knowledge base and written in the given content type. THE RESULT IS NOT STORED: it is returned and then forgotten — nothing appears in `senso generated-content` unless you save it yourself with `senso engine draft`. Consumes credits, and takes 10-30 seconds.

```
senso generate industry-draft [options]
```

| Option | Description | Default |
|---|---|---|
| `--industry-prompt-id <uuid>` | An industry prompt id from `senso industries prompts` — NOT a geo_question_id from `senso prompts list` |  |
| `--content-type-id <uuid>` | A content type id from `senso content-types list`, giving the document its format |  |
| `--product-line-ids <uuids>` | Comma-separated product line ids to ground on, 1 to 100. Omit for all of them. |  |
| `--audience <text>` | Who the document is for (max 500 characters) |  |
| `--style-tone <text>` | Voice and tone guidance (max 500 characters) |  |
| `--extra-instructions <text>` | Further instructions for the writer (max 4000 characters) |  |

## senso engine

Create, update and publish content through the content engine. Requires the GEO product and update:content. BOTH commands create a NEW content item when --data has no content_id, and update that item when it does — omitting content_id while iterating on a draft silently produces duplicates. Ids: geo_question_id (optional) from `senso questions list`, content_id from `senso generated-content list --status drafts`, publisher_ids from `senso destinations list`. Workflow: questions list → engine draft → generated-content get → engine publish → content verification.

```
senso engine [options] [command]
```

### senso engine publish

Publish content to external destinations, or record content that was published somewhere else. Only raw_markdown and seo_title are required; geo_question_id is OPTIONAL despite what older help said. With content_id in --data this publishes a new version of that item; without it a brand-new item is created on every call. A publish that reaches the API but is refused by EVERY destination comes back as publish_status "failed" with editorial_status "draft" — this command exits 1 in that case and names each destination's error.

```
senso engine publish [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON body. REQUIRED: raw_markdown (non-blank; may not contain a `[Missing approved evidence: ...]` placeholder), seo_title (non-blank). OPTIONAL: content_id (update this item instead of creating one), geo_question_id (the prompt this answers, from `senso questions list`), summary, publisher_ids (array of UUIDs; see --publisher-ids), mark_as_published (true records the content as already live elsewhere and first UNPUBLISHES every live destination for the item), manual_published_url (with mark_as_published: where it went live — WITHOUT it the item is published but UNTRACKED and can never be cited), manual_published_at (RFC 3339), generation_run_id, generation_receipt_id, builder_workspace_id and expected_workspace_version_id (Builder provenance; the last two must be sent together), ever_published (legacy, ignored by the server). Example: '{"content_id":"<uuid>","raw_markdown":"# ...","seo_title":"..."}' |  |
| `--publisher-ids <ids...>` | Restrict publishing to these publisher UUIDs, from `senso destinations list`. Overrides any publisher_ids inside --data. Omit to publish to every destination selected for generation |  |

### senso engine draft

Save content as a draft. Nothing reaches any destination until `senso engine publish` runs on it. Only raw_markdown and seo_title are required; geo_question_id is OPTIONAL. With content_id in --data this saves a new VERSION of that item; without it a brand-new item is created on every call, which is how a generation loop ends up with duplicate drafts. Unlike publish, a draft MAY contain `[Missing approved evidence: ...]` placeholders — publishing it later will refuse them.

```
senso engine draft [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON body. REQUIRED: raw_markdown (non-blank), seo_title (non-blank). OPTIONAL: content_id (update this draft instead of creating a new item), geo_question_id (from `senso questions list`), summary, generation_run_id, generation_receipt_id, builder_workspace_id and expected_workspace_version_id (Builder provenance; the last two must be sent together). Example: '{"content_id":"<uuid>","raw_markdown":"# ...","seo_title":"..."}' |  |

## senso destinations

Where published content lands. Three shared destinations exist on the citeables system (citeables, codeables, cucopilot), and an organization can register its own citeables-system domain. `selected_for_generation: true` means generation and publishing use it by default.

```
senso destinations [options] [command]
```

### senso destinations list

List every destination available to the organization: the shared citeables-system ones and any domain you registered, with how many pages are live on each and whether it is selected for generation.

```
senso destinations list [options]
```

### senso destinations add

Register a domain you own as a publish destination on the citeables system, and select it for generation. The domain is registered with citeables synchronously. Calling it again for the same domain returns the destination that already exists. Needs update:org.

```
senso destinations add [options]
```

| Option | Description | Default |
|---|---|---|
| `--domain <hostname>` | A bare hostname you control, e.g. "content.example.com" — no scheme, no path. Its slug becomes content-example-com. |  |
| `--name <name>` | Display name, e.g. "Example Citeables" |  |
| `--type <type>` | Only citeables can be registered today. codeables and cucopilot are shared destinations' slugs, not types. | `citeables` |

### senso destinations remove

Stop publishing to a destination, choosing what happens to the pages already live there. Returns counts of what was done. Needs update:org.

```
senso destinations remove [options] <publisherId>
```

| Option | Description | Default |
|---|---|---|
| `--action <action>` | Required. leave: pages stay live and the content returns to draft here. unpublish: pages are removed from the destination. delete: unpublish, then hard-delete the content records — irreversible. |  |
| `--also-remove-destination` | Also delete the destination itself. Custom (scope: org) destinations only; a shared one can be unlinked but never deleted. |  |
| `--keep-domain` | With --also-remove-destination on a custom citeables domain: keep the domain registered so its URLs keep resolving. |  |

## senso publish-records

Retry a publish that failed for ONE destination, without republishing the whole item. A publish_record is one content item published to one destination. There is no list command here — a publish_record_id comes from `senso content verification` (items[].destinations[].publish_record_id) or `senso content citation-details <content_id>` (destinations[].publish_record_id). States: live (reachable at external_url), pending (queued), publishing (the adapter is running), failed (THE ONLY RETRYABLE STATE), unpublishing, unpublished. The same id is what `senso content unpublish --publish-record-ids` takes.

```
senso publish-records [options] [command]
```

### senso publish-records retry

Re-run the publish for one content+destination pair that failed. Synchronous: the command returns once the destination has answered, and the record is already live or failed again by then. The adapter has a 15-second timeout server-side, so a slow destination can come back as a failure rather than a success. Only a record in the `failed` state can be retried; anything else is a conflict. Requires the GEO product and update:content.

```
senso publish-records retry [options] <publishRecordId>
```

## senso brand-kit

One brand kit per organization: the brand facts and voice rules the AI writer follows when generating content. It is a singleton — there is no id to pass, the key identifies it, 'get' always succeeds, and the first 'set' creates it. The guidelines object accepts exactly these keys and nothing else: brand_name, brand_domain, brand_description, voice_and_tone, author_persona, global_writing_rules (global_writing_rules is an array of strings, the rest are strings). Unknown keys, wrong types and nulls are rejected before the request is sent, with the offending key named. 'senso website-import start' can fill the brand kit in from a website instead — it is gated on the same update:brand_kit permission for that reason. Requires the GEO product and read:brand_kit / update:brand_kit; viewers have no brand kit access.

```
senso brand-kit [options] [command]
```

### senso brand-kit get

Read the organization's brand kit guidelines. Always succeeds: an organization that has never saved one gets an empty guidelines object rather than a 404.

```
senso brand-kit get [options]
```

### senso brand-kit set

Replace the entire brand kit (PUT). Every field you do not send is REMOVED — run 'brand-kit get' first to keep what you are not changing, or use 'brand-kit patch' for a targeted update. This is also what creates the brand kit the first time.

```
senso brand-kit set [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "guidelines": { "brand_name": "Acme", "brand_domain": "https://acme.com", "brand_description": "...", "voice_and_tone": "...", "author_persona": "...", "global_writing_rules": ["..."] } }. Every field is optional, but anything you omit is REMOVED — pass '{"guidelines":{}}' to clear the brand kit entirely. A key beside "guidelines" is rejected here because the API would accept it with a 200 and silently drop it |  |

### senso brand-kit patch

Partially update the brand kit (PATCH). Only the fields you provide are changed; the rest keep their current value. Preferred over 'set' for targeted updates. Two things it cannot do: append to global_writing_rules (sending it replaces the whole list — read the current one with 'brand-kit get' and send it back with the new entry), and remove a field (null is rejected; use 'brand-kit set' with the field omitted).

```
senso brand-kit patch [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "guidelines": { "voice_and_tone": "Warm and approachable" } }. At least one field is required; accepted fields are brand_name, brand_domain, brand_description, voice_and_tone, author_persona, global_writing_rules (global_writing_rules is an array of strings, the rest are strings) |  |

## senso content-types

Manage content types — the reusable output formats for AI-generated content (blog post, FAQ, landing page). Each has a name, unique in the organization, and a config. What defines the format is config.template, a freeform Markdown string: the API parses it into config.template_spec, one section per Markdown heading, and reads word budgets out of phrases in the text — (800-1200 words), target: 900 words, max 500 words, minimum 200 words. Those budgets are ENFORCED on generated output, so a number in a template is a hard constraint rather than a hint. config.template_spec is read-only in practice: whatever is sent is validated and then replaced with the parse of config.template. The stored config is canonicalized on every write, so it always carries all five keys. Workflow: list → create → get (to read the derived template_spec) → use the content_type_id with the generate commands.

```
senso content-types [options] [command]
```

### senso content-types list

List the organization's content types, with their full config.

```
senso content-types list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Rows per page (default: 50) |  |
| `--offset <n>` | Rows to skip (default: 0) |  |

### senso content-types create

Create a content type: a name and a config whose `template` defines the output format.

```
senso content-types create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "Blog Post", "config": { "template": "## Introduction (100-150 words)\n...", "writing_rules": [], "cta_text": "...", "cta_destination": "https://..." } }. Accepted config keys: template, template_spec, cta_text, cta_destination, writing_rules — anything else is rejected. |  |

### senso content-types get

Read one content type: the template that defines the output format, and the parsed spec derived from it.

```
senso content-types get [options] <id>
```

### senso content-types update

Replace a content type's name AND config (PUT). A full replacement twice over: a key left out of --data is cleared, and a key left out of config is cleared too. Run `content-types get <id>` first, or use `content-types patch <id>`.

```
senso content-types update [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "Updated Name", "config": { ... } }. Both required. Accepted config keys: template, template_spec, cta_text, cta_destination, writing_rules; keys omitted from config are CLEARED. |  |

### senso content-types patch

Change part of a content type (PATCH). Keys that are not sent keep their current value. The merge is one level deep: sending writing_rules REPLACES the whole list.

```
senso content-types patch [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON with at least one of "name" and "config", e.g. { "config": { "template": "Updated template instruction" } }. Accepted config keys: template, template_spec, cta_text, cta_destination, writing_rules. |  |

### senso content-types delete

Remove a content type. It disappears from `content-types list` immediately and there is no undelete from the CLI.

```
senso content-types delete [options] <id>
```

## senso prompts

Manage prompts — the tracked GEO questions AI models are asked on your run schedule, which also seed content generation. Prompts and questions are the SAME records: `senso prompts` and `senso questions` read and write the same geo_questions rows, and prompt_id is the same UUID as geo_question_id. Use `prompts` for search, sorting, paging, run history and tags; use `questions` to change a question's funnel stage, to attach tags at creation, or to see the questions a network shares. Workflow: prompts create → prompts tags set → prompts list → (scheduled run) → prompts get. Creating a prompt does NOT run it — runs fire on the days set with `senso run-config set-schedule`. Requires the GEO product.

```
senso prompts [options] [command]
```

### senso prompts list

List the organization's prompts, newest first. --search is a case-insensitive substring of the question text only (not tags); --sort orders the page.

```
senso prompts list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Rows per page, 1-100 (default: 50) |  |
| `--offset <n>` | Rows to skip, 0 or more (default: 0) |  |
| `--search <query>` | Case-insensitive substring of the question text |  |
| `--sort <order>` | Sort order: created_desc, created_asc, text_asc, text_desc, type_asc, type_desc (default: created_desc) |  |

### senso prompts create

Add a tracked prompt (a GEO question). Creating it does NOT run it — runs fire on the org's schedule.

```
senso prompts create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "question_text": "What are the best...", "type": "decision" }. question_text is 1-500 characters; type is awareness \| consideration \| evaluation \| decision. |  |

### senso prompts get

Read one prompt with its full run history: every time the AI models were asked this question, what they said, who they mentioned and what they cited.

```
senso prompts get [options] <promptId>
```

### senso prompts delete

Remove a prompt and hide its run history. The record is soft-deleted: it stops appearing in every prompt, question and analytics endpoint, and there is no undelete.

```
senso prompts delete [options] <promptId>
```

### senso prompts tags

Manage the tags on a prompt. Prompts are auto-tagged in the background when created, so these commands correct or extend that. <promptId> is a prompt_id from `senso prompts list`; --id/--ids take tag ids from `senso tags list` or the `id` field of `prompts tags list`. A --name/--names that the organization does not have is CREATED, and a name that exists but is uncurated (machine-minted from a search query) is ADOPTED into the org's vocabulary — a change to the whole organization, not just this prompt. `set` replaces the whole set; `add` and `remove` change one tag.

```
senso prompts tags [options] [command]
```

### senso prompts tags list

List the tags currently attached to a prompt.

```
senso prompts tags list [options] <promptId>
```

### senso prompts tags set

REPLACE a prompt's tags with exactly the set named. Tags on the prompt that are not named are removed.

```
senso prompts tags set [options] <promptId>
```

| Option | Description | Default |
|---|---|---|
| `--names <list>` | Comma-separated tag names, created if the organization lacks them |  |
| `--ids <list>` | Comma-separated existing tag UUIDs, from `senso tags list` |  |
| `--clear` | Remove every tag from the prompt. Not combinable with --names or --ids. |  |

### senso prompts tags add

Attach one tag to a prompt, leaving its other tags in place.

```
senso prompts tags add [options] <promptId>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name, created if the organization does not have it |  |
| `--id <tagId>` | An existing tag UUID, from `senso tags list` |  |

### senso prompts tags remove

Detach one tag from a prompt. The prompt's other tags are untouched and the tag itself stays in the organization's vocabulary.

```
senso prompts tags remove [options] <promptId>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name to detach |  |
| `--id <tagId>` | Tag UUID to detach, from `senso prompts tags list <promptId>` |  |

## senso run-config

Configure which AI models answer this organization's prompts, and on which days. Two model lists live here, and they are different vocabularies for the same models. Run models (use these) are bare names — chatgpt, perplexity, gemini, grok, google_ai_overviews, claude, gpt — read with `models`, written with `set-models`, discovered with `model-options`. Scheduler models (advanced) are registry ids of the form provider/model, such as anthropic/claude, read with `scheduler-models` and written with `set-scheduler-models`. They are linked in ONE direction: `set-models` also rewrites the scheduler opt-in, so the two stay consistent, while `set-scheduler-models` leaves the run-model list alone and the two reads can then disagree. Prefer `set-models`. Workflow: model-options → set-models → set-schedule → models / schedule to confirm. The read commands need the GEO product; the write commands need the update:org permission.

```
senso run-config [options] [command]
```

### senso run-config models

The AI models currently configured to answer this organization's prompts. An empty list means no runs will be produced at all.

```
senso run-config models [options]
```

### senso run-config set-models

Replace the AI models that answer this organization's prompts. Any model not listed is removed. This also rewrites the scheduler opt-in (`run-config scheduler-models`) to match.

```
senso run-config set-models [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "models": ["chatgpt", "claude"] }. At least one name, from: chatgpt, perplexity, gemini, grok, google_ai_overviews, claude, gpt. The aliases aioverview, claude-sonnet-4-6, gpt-4.1 are accepted too. |  |

### senso run-config model-options

The model names `run-config set-models` accepts, with their display labels. Global rather than per-organization: read them before writing, so an unsupported name does not cost a round trip.

```
senso run-config model-options [options]
```

### senso run-config scheduler-models

The registry models this organization is opted into for scheduled runs. `run-config set-models` rewrites this list to match the run models, so normally the two agree.

```
senso run-config scheduler-models [options]
```

### senso run-config set-scheduler-models

Replace the registry models the scheduler runs for this organization. Advanced: for the usual case use `run-config set-models`, which sets both lists. This does NOT update the run-model list, so afterwards `run-config models` and `run-config scheduler-models` can disagree.

```
senso run-config set-scheduler-models [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "models": ["anthropic/claude", "brightdata/chatgpt"] }. Each entry is provider/model; the bare names `set-models` takes are rejected here. Seeded catalog: brightdata/chatgpt, brightdata/grok, brightdata/perplexity, brightdata/gemini, brightdata_serp/google_ai_overviews, anthropic/claude, openai/gpt. |  |

### senso run-config schedule

The days of the week on which this organization's prompts are run.

```
senso run-config schedule [options]
```

### senso run-config set-schedule

Set which days of the week this organization's prompts are run. REPLACES the whole schedule: days that are not listed are removed.

```
senso run-config set-schedule [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "schedule": [1, 3, 5] } — whole numbers 0-6, 0 = Sunday. At least one day: the API cannot store an empty schedule, so runs cannot be turned off here. |  |

## senso skills

Install and manage the official Senso skills for AI coding agents (Claude Code, Cursor, Codex, Copilot, Gemini, Cline). A skill is a folder of instructions the agent reads before it calls this CLI. Local: nothing is sent to the Senso API.

```
senso skills [options] [command]
```

### senso skills install

Install official Senso skills into this directory's agent skill folders. With no names, or with --all, installs every official skill.

```
senso skills install [options] [names...]
```

| Option | Description | Default |
|---|---|---|
| `--all` | Install every official Senso skill (same as giving no names) |  |
| `--agent <name>` | Install for one agent only: claude, cursor, codex, copilot, gemini, cline. Default: every agent shipables detects here. |  |
| `--global` | Install into your home directory, for every project |  |

### senso skills list

List the skills installed for this directory, or for your home directory with --global.

```
senso skills list [options]
```

| Option | Description | Default |
|---|---|---|
| `--global` | List the home-directory (all projects) scope instead |  |

### senso skills list-available

Show every official Senso skill that `senso skills install` can install. Static and offline: no key, no network, no subprocess.

```
senso skills list-available [options]
```

### senso skills remove

Remove one installed Senso skill from this directory, or from your home directory with --global.

```
senso skills remove [options] <name>
```

| Option | Description | Default |
|---|---|---|
| `--global` | Remove from the home-directory scope |  |

## senso members

Read-only directory of the organization's members, with email, name, role name and groups. The same people as `senso users`, with the human-readable fields: use the user_id from here with `senso users get/update/remove/set-current`.

```
senso members [options] [command]
```

### senso members list

One page of the organization's members with email, name, role and groups. Read-only — to change a membership use `senso users`.

```
senso members list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Rows per page, integer 1-1000 (default 50) |  |
| `--offset <n>` | Rows to skip, integer >= 0 (default 0) |  |
| `--search <query>` | Case-insensitive substring match on name or email |  |
| `--sort <order>` | One of: name_asc, name_desc, email_asc, email_desc, created_asc, created_desc (default name_asc) |  |

## senso credits

The credit balance of the organization this API key belongs to. Credits are spent by AI content generation (`senso generate`) and by search (`senso search`); a 402 from any command in this CLI means this balance, or the organization's spend limit, is exhausted. `senso credits` on its own is the same as `senso credits balance`.

```
senso credits [options] [command]
```

### senso credits balance

Get the organization's credit position: what has been spent, what is left, and whether a spend limit caps it.

```
senso credits balance [options]
```

## senso questions

Manage the organization's geo questions. These are the SAME records as `senso prompts`: both groups read and write the same geo_questions rows behind the same GEO product gate, and geo_question_id is the same UUID as prompt_id. Use this group for what only it does — change a question's funnel stage (`questions patch`), attach tags while creating (`questions create`), and list the questions a network shares (`questions list --type network`). Use `senso prompts` for search, sorting, paging, run history and tag management. Two meanings of "type" live here: `--type` on `questions list` is the SCOPE (organization | network), while `type` inside --data is the FUNNEL STAGE (awareness | consideration | evaluation | decision) and is also the `type` field in the output. `questions delete` removes the question AND its run history, exactly as `prompts delete` does.

```
senso questions [options] [command]
```

### senso questions list

List every question in the organization, or every question its network shares. Not paginated: all rows come back in one response. `senso prompts list` is the paged, searchable, sortable view of the same records.

```
senso questions list [options]
```

| Option | Description | Default |
|---|---|---|
| `--type <scope>` | Which questions to list — organization (yours) or network (shared with you). This is the scope, not the funnel stage. | `organization` |

### senso questions create

Create a question, optionally with tags. Same record as `senso prompts create`; this variant takes tag_ids at creation and is stricter about the stage spelling.

```
senso questions create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "question_text": "...", "type": "decision", "tag_ids": ["<uuid>"] }. question_text is 1-255 characters; type is exactly one of awareness, consideration, evaluation, decision. |  |

### senso questions patch

Change a question's funnel stage and/or its tags. This is the only command that can change the stage — the `prompts` group has no update.

```
senso questions patch [options] <questionId>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON with at least one of: { "type": "awareness\|consideration\|evaluation\|decision" } and { "tag_ids": ["<uuid>"] }. tag_ids REPLACES the question's tags; pass [] to remove them all. tag_ids: null does NOT clear them — the API reads null as "field not supplied" and rejects the request. |  |

### senso questions delete

Remove a question and hide its run history. Identical in effect to `senso prompts delete`: the record is soft-deleted, disappears from every question, prompt and analytics endpoint, and cannot be restored from the CLI.

```
senso questions delete [options] <questionId>
```

## senso kb

The organization's knowledge base: a tree of folders and documents that Senso search and generation read from. Every command here takes a kb_node_id unless it says otherwise; the content_id that appears in payloads addresses the stored document and is what `senso content` takes. Documents are ingested asynchronously — a node exists before its content is searchable, so poll `kb get <id>` until content.processing_status is complete. Workflow: my-files → upload or create-raw → get (poll) → tags set → senso search.

```
senso kb [options] [command]
```

### senso kb root

Get the organization's root folder node.

```
senso kb root [options]
```

### senso kb stats

Count the documents and folders in the knowledge base.

```
senso kb stats [options]
```

### senso kb my-files

List the top level of the knowledge base — files and folders under the root.

```
senso kb my-files [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Items per page, 1-50 (the API caps higher values at 50) | `50` |
| `--offset <n>` | Pagination offset | `0` |
| `--type <type>` | Only nodes of this type: folder \| content |  |
| `--status <status>` | Only documents in this ingestion state: pending \| processing \| complete \| failed. Ignored with --type folder |  |
| `--role <role>` | Only nodes where the caller holds this role: editor \| viewer. Ignored for org-admin keys, which already reach everything |  |
| `--sort-by <field>` | Sort by: name \| updated_at \| created_at \| type \| status \| role |  |
| `--sort-order <dir>` | Sort direction: asc \| desc |  |
| `--tag-ids <ids>` | Comma-separated tag UUIDs from `senso tags list`; only nodes carrying at least one of them |  |

### senso kb find

Search the knowledge base for nodes whose NAME matches a query.

```
senso kb find [options]
```

| Option | Description | Default |
|---|---|---|
| `--query <q>` | Substring to match against node names |  |
| `--limit <n>` | Items per page, 1-50 (the API caps higher values at 50) | `20` |
| `--offset <n>` | Pagination offset | `0` |
| `--type <type>` | Only nodes of this type: folder \| content |  |
| `--status <status>` | Only documents in this ingestion state: pending \| processing \| complete \| failed. Ignored with --type folder |  |
| `--role <role>` | Only nodes where the caller holds this role: editor \| viewer. Ignored for org-admin keys, which already reach everything |  |
| `--sort-by <field>` | Sort by: name \| updated_at \| created_at \| type \| status \| role |  |
| `--sort-order <dir>` | Sort direction: asc \| desc |  |
| `--tag-ids <ids>` | Comma-separated tag UUIDs from `senso tags list`; only nodes carrying at least one of them |  |

### senso kb sync-status

Report whether queued move and delete operations are still propagating.

```
senso kb sync-status [options]
```

### senso kb get

Read one knowledge base node, with its ingestion state and tags.

```
senso kb get [options] <id>
```

### senso kb children

List the direct children of a folder — one level deep.

```
senso kb children [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Items per page, 1-50 (the API caps higher values at 50) | `50` |
| `--offset <n>` | Pagination offset | `0` |
| `--type <type>` | Only nodes of this type: folder \| content |  |
| `--status <status>` | Only documents in this ingestion state: pending \| processing \| complete \| failed. Ignored with --type folder |  |
| `--role <role>` | Only nodes where the caller holds this role: editor \| viewer. Ignored for org-admin keys, which already reach everything |  |
| `--sort-by <field>` | Sort by: name \| updated_at \| created_at \| type \| status \| role |  |
| `--sort-order <dir>` | Sort direction: asc \| desc |  |
| `--tag-ids <ids>` | Comma-separated tag UUIDs from `senso tags list`; only nodes carrying at least one of them |  |

### senso kb ancestors

Get the breadcrumb path to a node, ordered root first.

```
senso kb ancestors [options] <id>
```

### senso kb get-content

Read the stored document behind a content node, including its text.

```
senso kb get-content [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--rev <n>` | Read a specific stored version, by version number (an integer >= 1). The current one is content.version_num from `senso kb get` |  |

### senso kb download-url

Get a presigned S3 URL for the file stored behind a node.

```
senso kb download-url [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--rev <n>` | Download a specific stored version, by version number (an integer >= 1) |  |

### senso kb create-folder

Create a folder in the knowledge base.

```
senso kb create-folder [options]
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Folder name, 1-255 characters |  |
| `--parent-id <id>` | kb_node_id of the folder to create it in; omit to create under the organization root |  |

### senso kb rename

Rename a node in the tree. The document's stored title is unchanged.

```
senso kb rename [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | The new name, 1-255 characters |  |

### senso kb move

Move a node to a different folder. A folder moves with its whole subtree.

```
senso kb move [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--parent-id <parentId>` | kb_node_id of the DESTINATION folder |  |

### senso kb delete

Delete one node. A FOLDER IS DELETED WITH ITS ENTIRE SUBTREE.

```
senso kb delete [options] <id>
```

### senso kb bulk-delete

Delete up to 100 nodes in one all-or-nothing call.

```
senso kb bulk-delete [options] <nodeIds...>
```

### senso kb create-raw

Create a text or markdown document in the knowledge base.

```
senso kb create-raw [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "text": "# Hello", "title": "My doc", "summary": "...", "kb_folder_node_id": "<uuid>" }. Only "text" is required; "tag_ids" is accepted and ignored by the API |  |

### senso kb update-raw

Replace a raw document's title, summary and text, creating a new version.

```
senso kb update-raw [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "title": "Title", "text": "# Updated content", "summary": "...", "tag_ids": ["<uuid>"] }. "title" and "text" are both required. Omitting "summary" CLEARS it. "tag_ids" REPLACES the whole tag set — omit it to keep the current tags, pass [] to clear them |  |

### senso kb patch-raw

Change some of a raw document's fields and leave the rest alone.

```
senso kb patch-raw [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "title": "New title", "text": "Updated text", "summary": "...", "tag_ids": ["<uuid>"] }. At least one of title/summary/text — "tag_ids" on its own is rejected. "tag_ids" REPLACES the whole tag set |  |

### senso kb upload

Upload up to 10 local files to the knowledge base.

```
senso kb upload [options] <files...>
```

| Option | Description | Default |
|---|---|---|
| `--folder-id <id>` | kb_node_id of the folder to upload into; omit for the organization root |  |

### senso kb update-file

Replace the file behind an existing node with a new version.

```
senso kb update-file [options] <id> <file>
```

### senso kb tags

Tags on a knowledge base document. <id> is a kb_node_id; the ids in --ids/--id are tag ids, the `id` field of `senso tags list`; a --name that the organization's tag library does not have is CREATED there. Only CONTENT nodes can be tagged — a folder is rejected. Senso auto-tags content after ingestion, so tags set while processing_status is pending or processing may be added to afterwards. Workflow: tags list → tags set or tags add → tags list.

```
senso kb tags [options] [command]
```

### senso kb tags list

List the tags on a knowledge base node.

```
senso kb tags list [options] <id>
```

### senso kb tags set

Replace a document's entire tag set.

```
senso kb tags set [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--names <list>` | Comma-separated tag names (created in the org's library if missing) |  |
| `--ids <list>` | Comma-separated existing tag UUIDs from `senso tags list` |  |
| `--clear` | Remove every tag. Required to clear — passing no flags is an error |  |

### senso kb tags add

Attach ONE tag, keeping the tags the document already has.

```
senso kb tags add [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name (created in the org's library if missing) |  |
| `--id <tagId>` | Existing tag UUID from `senso tags list` |  |

### senso kb tags remove

Detach ONE tag. The tag itself stays in the organization's library.

```
senso kb tags remove [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name to detach |  |
| `--id <tagId>` | Tag UUID to detach, from `senso kb tags list` |  |

### senso kb permissions

Who can see and change a knowledge base node. Grants INHERIT down the tree: a grant on a folder reaches everything inside it, and `kb get` reports the resolved answer as effective_role. viewer reads; editor also renames, moves, deletes, re-uploads and tags; owner is assigned by the platform and cannot be granted here. Three ids are in play: <id> is a kb_node_id, --grantee-id is a user_id or group_id, and <permissionId> is the grant's own `id` from `kb permissions list`. An org-admin key bypasses grants entirely, so an empty list does not mean nobody has access.

```
senso kb permissions [options] [command]
```

### senso kb permissions list

List the access grants on a node — who holds what role.

```
senso kb permissions list [options] <id>
```

### senso kb permissions add

Grant one user or group viewer or editor access to a node.

```
senso kb permissions add [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--grantee-type <type>` | Who the grant is for: user \| group |  |
| `--grantee-id <id>` | user_id from `senso users list`, or group_id from `senso permissions groups` |  |
| `--role <role>` | Access level to grant: viewer \| editor |  |

### senso kb permissions update

Change an existing grant's role.

```
senso kb permissions update [options] <id> <permissionId>
```

| Option | Description | Default |
|---|---|---|
| `--role <role>` | The new role: viewer \| editor |  |

### senso kb permissions remove

Revoke one access grant on a node.

```
senso kb permissions remove [options] <id> <permissionId>
```

## senso permissions

The catalog of permission keys (action:resource, e.g. update:org) that a dashboard user role can hold. The same list for every organization, and read-only. NOT what your API key may do: an organization API key is not subject to these keys — its only restriction is its knowledge base scope, from `senso api-keys kb-permissions-get`.

```
senso permissions [options] [command]
```

### senso permissions list

List every permission key a role can hold, with the category it belongs to. Reference data: the same for every organization.

```
senso permissions list [options]
```

## senso tags

Manage the organization's tag library — the shared vocabulary that prompts, KB nodes and content items are labeled with. A tag is org-scoped: renaming or deleting one here changes every resource it was applied to, immediately.

Most workflows never need this group. `senso kb tags attach`, `senso content tags attach` and `senso prompts tags attach` all create a tag by name when it does not exist, so the library grows on its own. Senso also auto-tags prompts, KB content and search queries; those machine-minted tags arrive with curated=false and are hidden from `tags list` unless you pass --include-uncurated.

Id spaces: a tag id is the `id` field of `senso tags list`, passed as --id/--ids/--tag-ids on the resource tag commands. A kb_node_id, content_id or prompt_id is the <id> ARGUMENT of those commands, and the two are never interchangeable.

Typical workflow: tags list --counts → attach by name on the resource → tags list --include-uncurated to review what auto-tagging minted → tags update to fold a variant into the canonical name → tags delete to retire one everywhere.

See also: senso kb tags, senso content tags, senso prompts tags, senso auto-tag

```
senso tags [options] [command]
```

### senso tags list

List the organization's tag library. Returns every tag — this endpoint is not paginated.

```
senso tags list [options]
```

| Option | Description | Default |
|---|---|---|
| `--counts` | Include the seven usage counts. Maps to `counts=true` |  |
| `--include-uncurated` | Also return machine-minted tags (curated=false). Maps to `include_uncurated=true` |  |

### senso tags create

Create a tag with no attachments. You rarely need this: `senso kb tags attach`, `senso content tags attach` and `senso prompts tags attach` create a tag by name when it does not exist.

```
senso tags create [options]
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name. 1-255 characters, unique per org (case-insensitive) |  |

### senso tags get

Read one tag with its full usage counts. Unlike `tags list`, counts are always included here.

```
senso tags get [options] <id>
```

### senso tags update

Rename a tag. It keeps its id and every attachment, so the new name appears immediately on every prompt, content item, KB node and search turn it is on. There is no merge: renaming onto an existing name is a conflict, not a fold.

```
senso tags update [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | The new name. 1-255 characters, unique per org (case-insensitive) |  |

### senso tags delete

Delete a tag and detach it from every prompt, content item, KB node and search turn it was applied to. The resources are untouched — only the label goes. This cannot be undone, and recreating the tag does not restore the attachments.

```
senso tags delete [options] <id>
```

## senso product-lines

Manage product lines — the organization's product and service definitions. A product line is a name plus an open-ended JSON `details` object.

`details` is not inert metadata. Every scalar leaf of `details` is flattened into the generation evidence inventory as an APPROVED evidence item (keyed `details.<path>`; arrays become `details.skus[0]`). The generator may assert those values as fact, so only put things in `details` you are willing to see published.

Requires the GEO product, plus read:product_line to read and update:product_line to write (admin and collaborator; viewers have no product line access). A 403 here is usually a plan limitation, not a bad key.

Id space: a product_line_id is the `product_line_id` field of `senso product-lines list`. It is what get/update/patch/delete take, and what `senso generate --product-line-ids` takes.

Typical workflow: product-lines list → product-lines create → product-lines patch to correct one field → senso generate --product-line-ids <product_line_id>.

See also: senso generate, senso brand-kit get, senso content-types list

```
senso product-lines [options] [command]
```

### senso product-lines list

List the organization's product lines. Each item carries its full `details` blob; the table view omits it, so use `product-lines get <id>` or --output json to read it.

```
senso product-lines list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Rows per page. Integer >= 1. Default 50. Maps to `limit` |  |
| `--offset <n>` | Rows to skip. Integer >= 0. Default 0. Maps to `offset` |  |

### senso product-lines create

Create a product line. Every scalar leaf of `details` is flattened into the generation evidence inventory as an APPROVED evidence item (keyed `details.<path>`; arrays become `details.skus[0]`). The generator may assert those values as fact, so only put things in `details` you are willing to see published.

```
senso product-lines create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "Pro Plan", "details": { ... } } |  |

### senso product-lines get

Read one product line, including its full `details` object. This is the command to use when you need to see `details` — `product-lines list` omits it from the table view.

```
senso product-lines get [options] <id>
```

### senso product-lines update

REPLACE a product line's name and details (PUT). Whatever you do not send is gone: the API treats an absent `details` as {}, which removes every evidence field generation was drawing from this product line. Read the current value first, or use `product-lines patch <id>` to change one field.

```
senso product-lines update [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "Updated Name", "details": { ... } } |  |

### senso product-lines patch

Change a product line's name, its details, or both (PATCH). Top-level fields you omit are left alone — but `details` is REPLACED, not merged: sending {"details":{"price_usd":129}} makes that the entire blob and drops every other key. To change one key, read the current blob and send it back whole.

```
senso product-lines patch [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: at least one of { "name": "...", "details": { ... } } |  |

### senso product-lines delete

Delete a product line. This cannot be undone, and there is no soft delete. Anything still holding the id stops resolving — a saved `senso generate --product-line-ids <id>`, and any Builder workspace or agent session whose selection includes it — and generation simply loses the evidence this product line was contributing.

```
senso product-lines delete [options] <id>
```

## senso roles

The roles of the organization your key belongs to. role_ids are PER ORGANIZATION: resolve a name (admin, collaborator, viewer, or a custom role) to its UUID here before passing --role-id to `senso users invite` or role_id to `senso users add` and `senso users update`. Read-only — roles are created and edited in the Senso dashboard.

```
senso roles [options] [command]
```

### senso roles list

List every role of this organization — the built-in admin, collaborator and viewer, plus any custom roles — with the role_id that `senso users` commands take.

```
senso roles list [options]
```

## senso competitors

Manage the organization's curated competitor list. Tracked competitors are what share-of-voice analytics measure you against, and they are fed into content-generation prompts as the brands to position against.

An organization may track at most 50 competitors. Adding past that limit fails, and the API reports the refusal as a 500 rather than a 409.

Reading the list needs no permission; every mutation — add, batch-add, suggest, update, delete — requires update:org.

Id space: a competitor id is the `id` field of `senso competitors list`, and it is the <competitorId> argument of update and delete.

Typical workflow: competitors suggest → filter out already_tracked → competitors batch-add → competitors list.

See also: senso analytics, senso tracked-sources

```
senso competitors [options] [command]
```

### senso competitors list

List every competitor the organization tracks. The list is complete — there is no paging — and an org may hold at most 50. Unlike the rest of this group, reading needs no special permission.

```
senso competitors list [options]
```

### senso competitors add

Add one competitor, recorded with source="manual". Names are unique per organization, case-insensitively: adding an existing name is a conflict, not an update. An organization may track at most 50. Requires update:org.

```
senso competitors add [options]
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Competitor brand name. 1-255 characters after trimming |  |
| `--url <url>` | Competitor website. An absolute URL WITH a scheme (https://acme.example.com), at most 2048 characters |  |

### senso competitors batch-add

Accept a set of competitors in one call, preserving the provenance fields `competitors suggest` returns. Two different limits of 50 apply: at most 50 ITEMS per request, and at most 50 competitors per ORGANIZATION. If the org has room for fewer than you send, the API keeps the first that fit and discards the rest without saying so — this command reports which in warnings. A name already tracked is not re-created; the existing row is returned instead.

```
senso competitors batch-add [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "items": [{ "name": "...", "url": "...", "source": "manual\|suggested_run_text\|suggested_web_search", "rationale": "...", "confidence": 0.85 }, ...] } |  |

### senso competitors suggest

Ask the model for competitor candidates and return them WITHOUT tracking any of them; accepting is a separate call. This costs model tokens, is limited to 5 calls per rolling hour per organization, and a successful result is cached for 10 minutes — a repeat inside that window returns the same suggestions with cached=true. Requires update:org, even though it changes nothing.

```
senso competitors suggest [options]
```

### senso competitors update

REPLACE a tracked competitor's name and URL. This is a PUT and the API cannot express "leave the URL alone": a request without a URL deletes the stored one, so this command requires either --url or --clear-url. Provenance is preserved — source, rationale and confidence keep whatever they were set to and cannot be changed here. Requires update:org.

```
senso competitors update [options] <competitorId>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Competitor brand name. 1-255 characters after trimming |  |
| `--url <url>` | The website to store. Absolute URL with a scheme, at most 2048 characters |  |
| `--clear-url` | Delete the stored URL, which is what the API does with a request that omits it |  |

### senso competitors delete

Remove a competitor from the tracked list. The row is soft-deleted: it disappears from `competitors list` and from the analytics that read the list, and it frees a slot against the 50-competitor per-organization cap. Requires update:org.

```
senso competitors delete [options] <competitorId>
```

## senso tracked-sources

Manage the rules that classify every URL an AI answer cites into one of three tiers. The tier is what share-of-voice and citation analytics count.

  primary    UI label "Owned"    — your own properties.
  tracked    UI label "Tracked"  — third parties you watch. Only this tier carries a --category.
  secondary  UI label "External" — everything else, and the default for a citation that matches no rule.

When two rules match one URL the more specific match type wins (exact_url > path_prefix > host > domain); between two rules of the same match type the higher --priority wins.

Every rule carries a source_origin: manual and onboarding rules are fully editable and deletable; a published rule — created automatically when content was published to a URL — accepts only an active toggle and cannot be deleted.

Changing any rule queues a rollup recalculation that restates citation history. It runs for minutes, so analytics lag a rule change. Reads need no permission; every mutation needs update:org.

Id space: a tracked source id is the `id` field of `senso tracked-sources list`, and it is the <sourceId> argument of update and delete.

Typical workflow: tracked-sources list --search <domain> → tracked-sources add → tracked-sources update <sourceId> --no-active to retire a rule → senso analytics once the recalc lands.

See also: senso analytics, senso competitors, senso publish-records

```
senso tracked-sources [options] [command]
```

### senso tracked-sources list

List the organization's citation-classification rules. This list grows on its own — publishing content creates a `published` rule per live URL — so it is paged, 50 at a time by default. Page or search rather than assuming what you see is everything. Reading needs no permission.

```
senso tracked-sources list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Rows per page. Integer 1-100. Default 50. Maps to `limit` |  |
| `--offset <n>` | Rows to skip. Integer >= 0. Default 0. Maps to `offset` |  |
| `--search <term>` | Substring filter on the pattern, normalized the same way patterns are stored, so "https://www.senso.ai/" matches the row stored as "senso.ai". Maps to `search` |  |

### senso tracked-sources add

Create a citation-classification rule. New rules are always active and always get source_origin="manual". The pattern is NORMALIZED before storage — "https://WWW.Senso.ai/" is stored as "senso.ai" — and that stored form is what `list` shows. Requires update:org.

```
senso tracked-sources add [options]
```

| Option | Description | Default |
|---|---|---|
| `--pattern <pattern>` | Value to match cited URLs against, interpreted per --match-type. At most 2048 characters |  |
| `--match-type <type>` | Match strategy: domain \| host \| path_prefix \| exact_url |  |
| `--tier <tier>` | Classification tier: primary (Owned) \| tracked \| secondary (External) |  |
| `--category <category>` | Sub-category, and ONLY for --tier tracked — the API discards it for any other tier: affiliated_domain \| published_content \| social \| press |  |
| `--label <label>` | Optional human-readable label, at most 255 characters |  |
| `--priority <n>` | Optional integer, default 0. Breaks ties between rules of the SAME match type; higher wins |  |

### senso tracked-sources update

REPLACE a citation-classification rule (PUT). What happens depends on the rule's source_origin: a manual or onboarding rule takes every field, while a published rule accepts ONLY --active/--no-active — the API takes a new pattern, match type or tier, answers 200, and silently keeps the old values, so this command reports that as a failure rather than letting it look like a write. Omission is not uniform: --label and --category are CLEARED when you omit them, while --priority and the active flag are KEPT. Requires update:org.

```
senso tracked-sources update [options] <sourceId>
```

| Option | Description | Default |
|---|---|---|
| `--pattern <pattern>` | Value to match cited URLs against, interpreted per --match-type. Normalized before storage |  |
| `--match-type <type>` | Match strategy: domain \| host \| path_prefix \| exact_url |  |
| `--tier <tier>` | Classification tier: primary (Owned) \| tracked \| secondary (External) |  |
| `--category <category>` | Sub-category, tracked tier only. OMITTING IT CLEARS THE STORED CATEGORY: affiliated_domain \| published_content \| social \| press |  |
| `--label <label>` | Human-readable label. OMITTING IT CLEARS THE STORED LABEL |  |
| `--priority <n>` | Ordering priority (integer). Omitting it keeps the current value |  |
| `--active` | Mark the rule active |  |
| `--no-active` | Mark the rule inactive, so it stops classifying |  |

### senso tracked-sources delete

Delete a citation-classification rule. A rule with source_origin="published" CANNOT be deleted — the publishing pipeline maintains it and would recreate it — so deactivate it instead with `tracked-sources update <sourceId> --pattern <its pattern> --match-type <its match_type> --tier <its tier> --no-active`. Citations that only this rule matched fall back to the External (secondary) tier. Requires update:org.

```
senso tracked-sources delete [options] <sourceId>
```

## senso generated-content

Browse content produced by the content engine (`senso engine draft` and `senso engine publish`). Requires the GEO product and read:content. This is a lighter view of the rows `senso content verification` returns: use that one for owners, tags, per-destination publish records and citation metrics, and this one for id, title, question text and editorial status — or for the rendered body, which only `generated-content get` returns. The content_id here is the SAME id used by `senso content get`, `senso content versions`, `senso content unpublish` and `senso engine publish --data '{"content_id": …}'`. Workflow: engine draft → generated-content list --status drafts → generated-content get → engine publish → generated-content list --status published.

```
senso generated-content [options] [command]
```

### senso generated-content list

List content produced by the content engine, newest first. --status selects the API PATH, not a filter: `drafts` means the item's CURRENT version is a draft, so an item that was published and then edited appears there — which is why these counts can disagree with `senso content verification-counts`.

```
senso generated-content list [options]
```

| Option | Description | Default |
|---|---|---|
| `--status <status>` | Which listing to read: published \| drafts | `published` |
| `--limit <n>` | Rows per page, 1-100. The API silently returns 10 rows for anything outside that, so the CLI rejects it | `10` |
| `--offset <n>` | Rows to skip | `0` |
| `--search <query>` | Substring match on the title |  |

### senso generated-content get

Read one generated content item: the prompt it answers and its rendered markdown body. This serves GENERATED content only — a knowledge base document is refused even though its id is a valid content_id; read those with `senso kb get <kb_node_id>`. `senso content get <id>` returns the same item with tags and upload provenance but WITHOUT question_text; this one returns question_text and the body.

```
senso generated-content get [options] <id>
```

## senso analytics

GEO analytics for your organization — brand visibility, share of voice, and citations across the AI models you monitor. Every payload ships raw counts alongside the rates, and a rate is null (shown as “—”) when its denominator is zero, never a silent 0%. Run 'senso analytics glossary' for the canonical definition and denominator of every metric. Requires the GEO product and the read:prompt permission: a 403 here is usually an entitlement, which no role change fixes. Dates are YYYY-MM-DD (the 'senso evals' group takes RFC 3339 instants under the same flag names) and a window may span at most 365 days. `analytics prompt <promptId>` takes an ORG prompt id — the prompt_id field of 'senso analytics prompts' or 'senso prompts list' — never an industry prompt id from 'senso industries prompts'. Typical order: filters → summary → prompts --order asc → prompt <id> → answers.

```
senso analytics [options] [command]
```

### senso analytics summary

One-call dashboard: every headline metric with its raw counts, plus the preceding equal-length window and the deltas between them.

```
senso analytics summary [options]
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data) |  |
| `--to <date>` | Window end, YYYY-MM-DD, inclusive (max window: 365 days) |  |
| `--models <list>` | Comma-separated model ids: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok — 'senso analytics filters' lists the ones with data |  |
| `--location <list>` | Comma-separated location filter, case-sensitive (e.g. US, US/California) |  |
| `--prompt-type <type>` | Funnel stage: awareness \| consideration \| evaluation \| decision |  |
| `--tag <tag>` | Restrict to prompts carrying this tag |  |

### senso analytics mentions

Visibility time series: mention counts, share of voice (your mentions ÷ mentions of every brand), average rank and sentiment, bucketed by day or week.

```
senso analytics mentions [options]
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data) |  |
| `--to <date>` | Window end, YYYY-MM-DD, inclusive (max window: 365 days) |  |
| `--models <list>` | Comma-separated model ids: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok — 'senso analytics filters' lists the ones with data |  |
| `--location <list>` | Comma-separated location filter, case-sensitive (e.g. US, US/California) |  |
| `--prompt-type <type>` | Funnel stage: awareness \| consideration \| evaluation \| decision |  |
| `--tag <tag>` | Restrict to prompts carrying this tag |  |
| `--group-by <bucket>` | Time bucket: day \| week (default: day). Weeks are ISO weeks starting Monday, so the first and last may be partial |  |

### senso analytics citations

Citation overview: both denominators (D = cited answers, S = citation instances), every tier numerator, the tier rates (÷D) and tier shares (÷S), and the series underneath.

```
senso analytics citations [options]
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data) |  |
| `--to <date>` | Window end, YYYY-MM-DD, inclusive (max window: 365 days) |  |
| `--models <list>` | Comma-separated model ids: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok — 'senso analytics filters' lists the ones with data |  |
| `--location <list>` | Comma-separated location filter, case-sensitive (e.g. US, US/California) |  |
| `--prompt-type <type>` | Funnel stage: awareness \| consideration \| evaluation \| decision |  |
| `--tag <tag>` | Restrict to prompts carrying this tag |  |
| `--group-by <bucket>` | Time bucket: day \| week (default: day). Weeks are ISO weeks starting Monday, so the first and last may be partial |  |

### senso analytics domains

Every domain the models cited, ranked. Citation Coverage is this domain's cited answers ÷ D; Citation Share is its citation instances ÷ S. Tiers: primary (Owned) | tracked | secondary (External).

```
senso analytics domains [options]
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data) |  |
| `--to <date>` | Window end, YYYY-MM-DD, inclusive (max window: 365 days) |  |
| `--models <list>` | Comma-separated model ids: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok — 'senso analytics filters' lists the ones with data |  |
| `--location <list>` | Comma-separated location filter, case-sensitive (e.g. US, US/California) |  |
| `--prompt-type <type>` | Funnel stage: awareness \| consideration \| evaluation \| decision |  |
| `--tier <tier>` | Filter by tier: primary \| tracked \| secondary |  |
| `--domain-contains <text>` | Substring filter on the domain |  |
| `--sort <field>` | Sort by: citations \| coverage (default: citations) |  |
| `--limit <n>` | Maximum rows to return (default: 50, max: 100) |  |
| `--offset <n>` | Rows to skip (for pagination) |  |

### senso analytics pages

URL-grain citation table plus the prompts driving each page's citations. Same Coverage (÷D) and Share (÷S) denominators as 'analytics domains'.

```
senso analytics pages [options]
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data) |  |
| `--to <date>` | Window end, YYYY-MM-DD, inclusive (max window: 365 days) |  |
| `--models <list>` | Comma-separated model ids: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok — 'senso analytics filters' lists the ones with data |  |
| `--location <list>` | Comma-separated location filter, case-sensitive (e.g. US, US/California) |  |
| `--prompt-type <type>` | Funnel stage: awareness \| consideration \| evaluation \| decision |  |
| `--tier <tier>` | Filter by tier: primary \| tracked \| secondary |  |
| `--domain <domain>` | Restrict to one exact domain (exact match, not a substring) |  |
| `--domain-contains <text>` | Substring filter on the domain; combines with --domain |  |
| `--url-contains <text>` | Substring filter on the URL |  |
| `--sort <field>` | Sort by: citations \| coverage (default: citations) |  |
| `--limit <n>` | Maximum rows to return (default: 50, max: 100) |  |
| `--offset <n>` | Rows to skip (for pagination) |  |

### senso analytics prompts

Per-prompt performance over the window — sort ascending by mention_rate to find the prompts where you are invisible. Drill into one with 'senso analytics prompt <promptId>'.

```
senso analytics prompts [options]
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data) |  |
| `--to <date>` | Window end, YYYY-MM-DD, inclusive (max window: 365 days) |  |
| `--models <list>` | Comma-separated model ids: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok — 'senso analytics filters' lists the ones with data |  |
| `--location <list>` | Comma-separated location filter, case-sensitive (e.g. US, US/California) |  |
| `--prompt-type <type>` | Funnel stage: awareness \| consideration \| evaluation \| decision |  |
| `--tag <tag>` | Restrict to prompts carrying this tag |  |
| `--search <query>` | Filter prompts by question text |  |
| `--sort <field>` | Sort by: mention_rate \| share_of_voice \| citations \| answered \| text (default: mention_rate) |  |
| `--order <dir>` | Sort direction: asc \| desc (default: desc) |  |
| `--limit <n>` | Maximum rows to return (default: 50, max: 100) |  |
| `--offset <n>` | Rows to skip (for pagination) |  |

### senso analytics prompt

One prompt end to end: its metric history over the window plus the latest full answer from every model × location.

```
senso analytics prompt [options] <promptId>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data) |  |
| `--to <date>` | Window end, YYYY-MM-DD, inclusive (max window: 365 days) |  |
| `--models <list>` | Comma-separated model ids: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok — 'senso analytics filters' lists the ones with data |  |
| `--location <list>` | Comma-separated location filter, case-sensitive |  |
| `--no-include-answers` | Omit the latest answer bodies (included by default) |  |

### senso analytics answers

The newest stored answer per prompt × model × location, with its citations and competitor mentions. This is a snapshot, not a window: --from/--to filter on when each answer was collected, so narrowing them hides combinations instead of returning older answers. Historical answer text is not retained.

```
senso analytics answers [options]
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Answers collected on or after this date, YYYY-MM-DD (hides rows, never reveals older answers) |  |
| `--to <date>` | Answers collected on or before this date, YYYY-MM-DD (hides rows, never reveals older answers) |  |
| `--models <list>` | Comma-separated model ids: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok — 'senso analytics filters' lists the ones with data |  |
| `--location <list>` | Comma-separated location filter, case-sensitive |  |
| `--prompt-type <type>` | Funnel stage: awareness \| consideration \| evaluation \| decision |  |
| `--tag <tag>` | Restrict to prompts carrying this tag |  |
| `--mentioned <bool>` | Only answers that did (true) or did not (false) name your brand |  |
| `--cited <bool>` | Only answers that did (true) or did not (false) cite anything |  |
| `--citation-tier <tier>` | Only answers citing this tier: primary \| tracked \| secondary |  |
| `--limit <n>` | Maximum rows to return (default: 25, max: 100) |  |
| `--offset <n>` | Rows to skip (for pagination) |  |

### senso analytics glossary

Canonical definition, denominator and gotcha for every metric these endpoints emit. Read this before quoting a number — a Citation Rate divides by cited answers (D), a Citation Share divides by citation instances (S), and they are not interchangeable.

```
senso analytics glossary [options]
```

### senso analytics filters

The models, locations, prompt types, tags and tracked competitors that actually have data for this org, plus the span of rollup days available — so you never guess a model spelling or query an empty window. This is the discovery command every --models flag in the group points at.

```
senso analytics filters [options]
```

## senso history-imports

Read-only view of the run-history import jobs that back-fill this organization's prompts with the history already collected for its industry. Nothing here starts or cancels a job — the only thing that starts one is `senso industries import-prompts`. A `completed` import may still have copied NOTHING, so read prompts_count and historic_runs_imported rather than the status on its own, and remember that `failed` is not terminal: failed jobs are retried and can return to running. Both commands require the GEO product. Workflow: industries import-prompts → history-imports get <import_id> (until completed with runs > 0) → senso analytics.

```
senso history-imports [options] [command]
```

### senso history-imports list

List this organization's 50 most recently started history-import jobs, newest first.

```
senso history-imports list [options]
```

### senso history-imports get

Get one run-history import job. This is the command to poll after `senso industries import-prompts` — and status alone is not the answer: a completed job may have copied nothing, and a failed one may still be retried.

```
senso history-imports get [options] <importId>
```

## senso industries

Browse the public industry catalog and the competitive intelligence Senso collects for it — brand leaderboards, domain citations and the prompts each industry runs. Works with the organization key stored by `senso login`; `senso partner` is the same data under a partner key. Three id spaces meet here: industry_id (from `industries list`), an INDUSTRY prompt id (the `id` of `industries prompts`, which is not a geo_question_id), and brand_id (from `industries brands`). Every <industry> takes a UUID or a name (e.g. "Airlines (Canada)"), and a name takes the first search match. Every command except `list` requires the GEO product. Workflow: list → org set-industry (once) → prompts → import-prompts → history-imports get → brands.

```
senso industries [options] [command]
```

### senso industries list

List the public industry catalog — every industry any organization may browse and choose as its own, with the counts that say whether it has anything worth importing.

```
senso industries list [options]
```

| Option | Description | Default |
|---|---|---|
| `--search <q>` | Case-insensitive substring match against name and slug |  |
| `--limit <n>` | Page size, 1-100 (default 50) |  |
| `--offset <n>` | Industries to skip (default 0) |  |
| `--sort <order>` | Sort order: name_asc \| name_desc \| created_asc \| created_desc (default name_asc) |  |
| `--live` | Only industries that can actually run: at least one opted-in model AND at least one active prompt |  |

### senso industries prompts

List the prompts an industry runs — the questions Senso asks the AI models on the industry's behalf. Their ids are what `industries import-prompts` and `senso generate industry-draft` accept.

```
senso industries prompts [options] <industry>
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Page size, 1-100 (default 50) |  |
| `--offset <n>` | Prompts to skip (default 0) |  |

### senso industries brands

Brand leaderboard for an industry — every brand the AI answers named over the window, ranked by mentions. The figures are raw COUNTS: divide by the `totals` block to get shares. Ranks are global, so --offset 100 still shows ranks 101 and up.

```
senso industries brands [options] <industry>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD and inclusive (default: 30 days ago). NOT an RFC 3339 instant — `senso evals` takes those |  |
| `--to <date>` | End of the window, YYYY-MM-DD and inclusive (default: today, UTC). The span may not exceed 90 days |  |
| `--models <list>` | Comma-separated model ids to keep: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok. Omit for every model. `senso analytics filters --output json \| jq -r '.data.models[].id'` lists the ids that have data. |  |
| `--location <code>` | 2-letter country code, e.g. US. Omit for every location the industry runs in |  |
| `--limit <n>` | Page size, 1-100 (default 100) |  |
| `--offset <n>` | Brands to skip (default 0) |  |
| `--no-canonicalize` | Do not merge spelling variants — one row per spelling. Turns off --rollup, which needs canonicalization |  |
| `--rollup <mode>` | Set to `parent` to fold sub-brands into their parent company (Gemini into Google). Ignored with --no-canonicalize |  |
| `--entity-type <list>` | Comma-separated types to keep: brand, regulator, publisher, government, generic_term, product_model, forum_social. Applied before paging, so total reflects it |  |

### senso industries brand

Everything about one brand in an industry, with its spelling variants merged before any metric is computed. The match is FUZZY: read resolved.matched_on and resolved.match_confidence before trusting the numbers. A brand that was never named comes back as mentioned=false and exits 0 — an answer, not an error.

```
senso industries brand [options] <industry> <brandName>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD and inclusive (default: 30 days ago). NOT an RFC 3339 instant — `senso evals` takes those |  |
| `--to <date>` | End of the window, YYYY-MM-DD and inclusive (default: today, UTC). The span may not exceed 90 days |  |
| `--models <list>` | Comma-separated model ids to keep: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok. Omit for every model. `senso analytics filters --output json \| jq -r '.data.models[].id'` lists the ids that have data. |  |
| `--location <code>` | 2-letter country code, e.g. US. Omit for every location the industry runs in |  |

### senso industries brand-by-id

The repeatable form of `industries brand`: the same payload addressed by the stable brand_id, with no fuzzy match and no registry write.

```
senso industries brand-by-id [options] <industry> <brandId>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD and inclusive (default: 30 days ago). NOT an RFC 3339 instant — `senso evals` takes those |  |
| `--to <date>` | End of the window, YYYY-MM-DD and inclusive (default: today, UTC). The span may not exceed 90 days |  |
| `--models <list>` | Comma-separated model ids to keep: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok. Omit for every model. `senso analytics filters --output json \| jq -r '.data.models[].id'` lists the ids that have data. |  |
| `--location <code>` | 2-letter country code, e.g. US. Omit for every location the industry runs in |  |

### senso industries domain

How often one domain — or one URL — was cited in an industry's AI answers over the window, and which brands were named alongside it. A domain that was never cited comes back as cited=false and exits 0: an answer, not an error.

```
senso industries domain [options] <industry> <domain>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD and inclusive (default: 30 days ago). NOT an RFC 3339 instant — `senso evals` takes those |  |
| `--to <date>` | End of the window, YYYY-MM-DD and inclusive (default: today, UTC). The span may not exceed 90 days |  |
| `--models <list>` | Comma-separated model ids to keep: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok. Omit for every model. `senso analytics filters --output json \| jq -r '.data.models[].id'` lists the ids that have data. |  |
| `--location <code>` | 2-letter country code, e.g. US. Omit for every location the industry runs in |  |
| `--url <url>` | Look up this full URL INSTEAD of <domain>. It replaces the argument entirely; <domain> is still required because the API path needs a segment, but its value is discarded |  |

### senso industries import-prompts

Copy prompts from YOUR OWN industry into your organization and start importing the run history already collected for them. THIS ACTIVATES THE ORGANIZATION: scheduled runs start, for these prompts and for any prompt already saved but not yet running, and an organization with no models, schedule or locations of its own has defaults written for it. There is no dry run. Only your own industry is accepted — any other is a 403. Prompts whose text you already hold are skipped, so re-running is safe.

```
senso industries import-prompts [options] <industry>
```

| Option | Description | Default |
|---|---|---|
| `--prompt-ids <ids>` | Comma-separated INDUSTRY prompt ids, 1-100, no duplicates — the `id` values of `senso industries prompts <industry>`, not geo_question_ids |  |

## senso partner

Partner-network commands. REQUIRES A PARTNER API KEY: every command here reads a /partner/* endpoint, and the organization key stored by `senso login` gets HTTP 403 “Partner credentials required” from the partner auth middleware — the key is valid and its scope is wrong, so running `senso login` again will not help. Pass a partner key per command with `--api-key <partner-key>` or SENSO_API_KEY; the CLI never stores one. Under an organization key instead: `partner industries list` → `senso industries list`, `partner industries brand` → `senso industries brand`, `partner industries domain` → `senso industries domain`, and the brand leaderboard is `senso industries brands`, which has no partner equivalent here. `partner industries summary`, `partner industries prompt-metrics` and `partner glossary` have no organization-key equivalent. For metrics about your own organization, use `senso analytics`.

```
senso partner [options] [command]
```

### senso partner industries

Industry-level competitive intelligence for a partner — share-of-voice, domain citations and per-prompt metrics. Requires a partner API key. `list` returns the industries this partner OWNS plus the public ones it SUBSCRIBES to; the reads are gated only on the industry existing, so an industry_id obtained elsewhere also works even though `list` does not show it. The <industry> argument takes a UUID or a name (e.g. "Automotive"), and a name takes the first search match. There is no brand-leaderboard command here: that is `senso industries brands`, under an organization key.

```
senso partner industries [options] [command]
```

### senso partner industries list

List the industries this partner key can act on: the industries the partner owns, plus the public industries it subscribes to.

```
senso partner industries list [options]
```

| Option | Description | Default |
|---|---|---|
| `--search <q>` | Case-insensitive filter by industry name |  |
| `--limit <n>` | Page size, 1-100. The API defaults to 10 and silently ignores a value it cannot use, so pass this whenever you want more than 10 |  |
| `--offset <n>` | Industries to skip (default 0) |  |

### senso partner industries summary

One-call overview of an industry: how many answers were analyzed, the single most-mentioned brand, and the citation split between official brand domains and everything else.

```
senso partner industries summary [options] <industry>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD and inclusive (default: 30 days ago). NOT an RFC 3339 instant — `senso evals` takes those |  |
| `--to <date>` | End of the window, YYYY-MM-DD and inclusive (default: today, UTC). The span may not exceed 90 days |  |
| `--models <list>` | Comma-separated model ids to keep: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok. Omit for every model. `senso analytics filters --output json \| jq -r '.data.models[].id'` lists the ids that have data. |  |
| `--location <code>` | 2-letter country code, e.g. US. Omit for every location the industry runs in |  |

### senso partner industries brand

Everything about one brand within an industry, with its spelling variants merged before any metric is computed. The match is FUZZY: read resolved.matched_on and resolved.match_confidence before trusting the numbers. A brand that was never named comes back as mentioned=false and exits 0 — an answer, not an error.

```
senso partner industries brand [options] <industry> <brandName>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD and inclusive (default: 30 days ago). NOT an RFC 3339 instant — `senso evals` takes those |  |
| `--to <date>` | End of the window, YYYY-MM-DD and inclusive (default: today, UTC). The span may not exceed 90 days |  |
| `--models <list>` | Comma-separated model ids to keep: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok. Omit for every model. `senso analytics filters --output json \| jq -r '.data.models[].id'` lists the ids that have data. |  |
| `--location <code>` | 2-letter country code, e.g. US. Omit for every location the industry runs in |  |

### senso partner industries domain

How often one domain — or one URL — was cited in an industry's AI answers over the window, and which brands were named alongside it. A domain that was never cited comes back as cited=false and exits 0.

```
senso partner industries domain [options] <industry> <domain>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD and inclusive (default: 30 days ago). NOT an RFC 3339 instant — `senso evals` takes those |  |
| `--to <date>` | End of the window, YYYY-MM-DD and inclusive (default: today, UTC). The span may not exceed 90 days |  |
| `--models <list>` | Comma-separated model ids to keep: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok. Omit for every model. `senso analytics filters --output json \| jq -r '.data.models[].id'` lists the ids that have data. |  |
| `--location <code>` | 2-letter country code, e.g. US. Omit for every location the industry runs in |  |
| `--url <url>` | Look up this full URL INSTEAD of <domain>. It replaces the argument entirely; <domain> is still required because the API path needs a segment, but its value is discarded |  |

### senso partner industries prompt-metrics

Per-prompt metrics across a whole industry, with no single-organization overlay: for each tracked prompt, how every model answered it and the brands most named in those answers.

```
senso partner industries prompt-metrics [options] <industry>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD and inclusive (default: 30 days ago). NOT an RFC 3339 instant — `senso evals` takes those |  |
| `--to <date>` | End of the window, YYYY-MM-DD and inclusive (default: today, UTC). The span may not exceed 90 days |  |
| `--models <list>` | Comma-separated model ids to keep: gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok. Omit for every model. `senso analytics filters --output json \| jq -r '.data.models[].id'` lists the ids that have data. |  |
| `--location <code>` | 2-letter country code, e.g. US. Omit for every location the industry runs in |  |
| `--limit <n>` | Page size, 1-100 (the API defaults to 100) |  |
| `--offset <n>` | Prompts to skip (default 0) |  |

### senso partner glossary

The canonical, citable definition of every competitive-intelligence metric these endpoints return — what it measures, what it divides by, and the way it is most often misread. Static content: it does not depend on your data.

```
senso partner glossary [options]
```

## senso update

Update this CLI to the newest @senso-ai/cli published on npm. Local: asks the npm registry, then runs `npm install -g`. Nothing is sent to the Senso API.

```
senso update [options]
```

## senso uninstall

Remove everything this CLI put on the machine: the Senso agent skills, the stored API key, then the npm package itself — in that order, so a failure leaves you the CLI to retry with. Local: nothing is sent to the Senso API. Asks for confirmation on a terminal; without one, --yes is required.

```
senso uninstall [options]
```

| Option | Description | Default |
|---|---|---|
| `-y, --yes` | Confirm without a prompt. REQUIRED when there is no terminal (CI, an agent): without it the command exits 2 rather than waiting on a keypress that never comes |  |
| `--dry-run` | Print the plan as a payload and remove nothing. Needs no --yes |  |
| `--keep-skills` | Leave the installed agent skills alone (step 1 is skipped) |  |
| `--keep-config` | Leave the stored API key and organization info alone (step 2 is skipped) |  |

