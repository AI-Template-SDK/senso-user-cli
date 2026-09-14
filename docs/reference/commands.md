# Command reference

**This file is generated.** Run `make reference` after changing a command; a policy test fails if it is stale.

Generated from the command tree of `@senso-ai/cli`. Every command accepts the [global options](#global-options).

## Contents

- [`senso login`](#senso-login) — Authenticate with Senso.
- [`senso logout`](#senso-logout) — Remove stored API key and organization info from local config.
- [`senso whoami`](#senso-whoami) — Show which organization you are authenticated as, including org ID, slug, tier, and API key prefix.
- [`senso org`](#senso-org) — View and update organization profile and settings.
- [`senso users`](#senso-users) — Manage users within the organization.
- [`senso api-keys`](#senso-api-keys) — Manage org-scoped API keys.
- [`senso search`](#senso-search) — Search the knowledge base with natural language queries.
- [`senso ingest`](#senso-ingest) — Ingest files into the knowledge base.
- [`senso website-import`](#senso-website-import) — Import your organization's website into the knowledge base.
- [`senso content`](#senso-content) — Manage content items in the knowledge base.
- [`senso ctas`](#senso-ctas) — Manage call-to-action (CTA) templates — the card attached to a published content-engine page — and choose which one each content item carries.
- [`senso evals`](#senso-evals) — Judge text against your organization's ground truth.
- [`senso generate`](#senso-generate) — AI content generation.
- [`senso engine`](#senso-engine) — Publish or draft content through the content engine.
- [`senso destinations`](#senso-destinations) — Manage publish destinations.
- [`senso publish-records`](#senso-publish-records) — Inspect and retry publish records.
- [`senso brand-kit`](#senso-brand-kit) — Manage the organization's brand kit guidelines that inform AI content generation about your brand voice, tone, and style.
- [`senso content-types`](#senso-content-types) — Manage content type configurations.
- [`senso prompts`](#senso-prompts) — Manage prompts (GEO questions).
- [`senso run-config`](#senso-run-config) — Configure which AI models are used for question runs and on which days they run.
- [`senso skills`](#senso-skills) — Install and manage Senso agent skills.
- [`senso members`](#senso-members) — View the organization member directory.
- [`senso credits`](#senso-credits) — View your organization's credit balance.
- [`senso questions`](#senso-questions) — Manage org-scoped geo questions.
- [`senso kb`](#senso-kb) — Manage the knowledge base.
- [`senso permissions`](#senso-permissions) — View available role permissions for the organization.
- [`senso tags`](#senso-tags) — Manage the organization's tag library.
- [`senso product-lines`](#senso-product-lines) — Manage product lines — flexible org-scoped product/service definitions.
- [`senso roles`](#senso-roles) — Inspect the roles defined for your organization.
- [`senso competitors`](#senso-competitors) — Manage the curated list of competitor brands your organization tracks.
- [`senso tracked-sources`](#senso-tracked-sources) — Manage citation-classification rules that tier each cited URL as Owned (primary), Tracked, or External (secondary).
- [`senso generated-content`](#senso-generated-content) — Browse AI-generated content (GEO).
- [`senso analytics`](#senso-analytics) — GEO analytics for your organization — brand visibility, share of voice, and citations across the AI models you monitor.
- [`senso history-imports`](#senso-history-imports) — Track the run-history import jobs started by `senso industries import-prompts`.
- [`senso industries`](#senso-industries) — Browse the public industry catalog and the competitive intelligence Senso collects for it — brand leaderboards, domain citations and the prompts each industry runs.
- [`senso partner`](#senso-partner) — Partner-network commands.
- [`senso update`](#senso-update) — Update CLI to the latest version

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

Authenticate with Senso. Paste your API key and it will be validated against your organization, then stored locally.

```
senso login [options]
```

## senso logout

Remove stored API key and organization info from local config.

```
senso logout [options]
```

## senso whoami

Show which organization you are authenticated as, including org ID, slug, tier, and API key prefix.

```
senso whoami [options]
```

## senso org

View and update organization profile and settings. Includes name, slug, logo, websites, locations, and tier information.

```
senso org [options] [command]
```

### senso org get

Get full organization details including name, slug, tier, websites, locations, configured AI models, publishers, and schedule.

```
senso org get [options]
```

### senso org update

Update organization details. Only the fields you pass are changed; omitting a field leaves it alone. But 'websites' and 'locations' REPLACE their whole list when passed — sending one website deletes the rest. To add to either list, run 'org get' first and send back every entry you want to keep.

```
senso org update [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "Acme", "slug": "acme", "logo_url": "https://acme.com/logo.png", "websites": [{"url": "https://acme.com"}], "locations": [{"country_code": "US", "region_name": "California"}] }. Every field is optional. "websites" and "locations" REPLACE the existing list rather than adding to it — include every entry you want to keep, or pass [] to clear the list. A website entry takes only "url"; sending the "org_website_id" from 'org get' is rejected. Send "logo_url": "" to clear the logo. |  |

### senso org set-industry

Set the industry your organization belongs to, chosen from the public catalog (`senso industries list`). This can be done ONCE: afterwards the call is rejected and changing it is not self-serve. It is what `senso industries import-prompts` and `senso generate industry-draft` work from, and where an org with no models or locations of its own inherits them on activation. Nothing else happens — no prompts are created and no runs start.

```
senso org set-industry [options] <industryId>
```

### senso org set-runs

Toggle the org-wide runs master switch. Pause every scheduled prompt run and content-generation run, or re-enable them.

```
senso org set-runs [options]
```

| Option | Description | Default |
|---|---|---|
| `--enabled <bool>` | Set to true or false |  |

## senso users

Manage users within the organization. Add, update roles, remove users, or set the active organization for a user.

```
senso users [options] [command]
```

### senso users list

List all users in the organization. Returns user IDs, roles, and membership status.

```
senso users list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Maximum number of users to return |  |
| `--offset <n>` | Number of users to skip (for pagination) |  |

### senso users add

Add an existing platform user to the organization. Requires user_id and role_id.

```
senso users add [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "user_id": "uuid", "role_id": "uuid", "is_current": false } |  |

### senso users get

Get a user's details including their role and membership status in the organization.

```
senso users get [options] <userId>
```

### senso users update

Update a user's role in the organization. Requires role_id in the JSON body.

```
senso users update [options] <userId>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "role_id": "uuid", "is_current": true } |  |

### senso users remove

Remove a user from the organization. This does not delete the platform user account.

```
senso users remove [options] <userId>
```

### senso users set-current

Set this organization as the current (active) organization for a user.

```
senso users set-current [options] <userId>
```

### senso users invite

Invite a brand-new user by email. Creates the user (in Clerk and Senso) and adds them to the organization with the given role. Use `roles list` to find a role_id. If the email already belongs to a Senso user, use `users invite-existing` instead.

```
senso users invite [options]
```

| Option | Description | Default |
|---|---|---|
| `--email <email>` | User's email address |  |
| `--given-name <name>` | First name |  |
| `--family-name <name>` | Last name |  |
| `--role-id <uuid>` | Role to assign — resolve with `senso roles list` |  |
| `--is-current` | Make this org the new user's current org |  |

### senso users invite-existing

Add an existing Senso user to the organization by email. Returns 404 if no user with that email exists — use `users invite` for brand-new users.

```
senso users invite-existing [options]
```

| Option | Description | Default |
|---|---|---|
| `--email <email>` | Email of an existing Senso user |  |
| `--role-id <uuid>` | Role to assign — resolve with `senso roles list` |  |
| `--is-current` | Make this org the user's current org |  |

## senso api-keys

Manage org-scoped API keys. Create, rotate, revoke, or list API keys used to authenticate with the Senso API.

```
senso api-keys [options] [command]
```

### senso api-keys list

List all API keys for the organization. Shows name, expiry, revocation status, and last usage.

```
senso api-keys list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Maximum number of keys to return |  |
| `--offset <n>` | Number of keys to skip (for pagination) |  |

### senso api-keys create

Create a new API key. The key value is returned only once — store it securely.

```
senso api-keys create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "my-key", "expires_at": "2025-12-31T00:00:00Z" } |  |

### senso api-keys get

Get details for a specific API key including name, expiry, and last used timestamp.

```
senso api-keys get [options] <keyId>
```

### senso api-keys update

Update an API key's name or expiry date.

```
senso api-keys update [options] <keyId>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "new-name", "expires_at": "2026-06-01T00:00:00Z" } |  |

### senso api-keys delete

Permanently delete an API key. This cannot be undone.

```
senso api-keys delete [options] <keyId>
```

### senso api-keys revoke

Revoke an API key. The key remains visible but can no longer be used for authentication.

```
senso api-keys revoke [options] <keyId>
```

### senso api-keys kb-permissions-get

Get the knowledge base node permission grants configured for an API key.

```
senso api-keys kb-permissions-get [options] <keyId>
```

### senso api-keys kb-permissions-set

Set KB node permission grants for an API key. Replaces any existing grants. Each grant requires a node_id (UUID) and role (viewer|editor|owner|admin).

```
senso api-keys kb-permissions-set [options] <keyId>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "grants": [{ "node_id": "<uuid>", "role": "viewer" }] } |  |

### senso api-keys kb-permissions-delete

Remove all KB node permission grants from an API key, restoring full org-level access.

```
senso api-keys kb-permissions-delete [options] <keyId>
```

## senso search

Search the knowledge base with natural language queries. Returns AI-generated answers synthesized from matching content chunks, or raw chunks/content IDs.

```
senso search [options] [command] <query>
```

| Option | Description | Default |
|---|---|---|
| `--max-results <n>` | Maximum number of results (max: 20) | `5` |
| `--content-ids <ids...>` | Restrict search to specific content item IDs (space-separated UUIDs) |  |
| `--require-scoped-ids` | Only return results from the specified --content-ids (omit to allow fallback to all content) |  |

### senso search context

Search the knowledge base — returns matching content chunks only, without AI answer generation. Use this to feed verified chunks into your own LLM pipeline instead of using Senso's generated answer.

```
senso search context [options] <query>
```

| Option | Description | Default |
|---|---|---|
| `--max-results <n>` | Maximum results (max: 20) | `5` |
| `--content-ids <ids...>` | Restrict search to specific content item IDs (space-separated UUIDs) |  |
| `--require-scoped-ids` | Only return results from the specified --content-ids |  |

### senso search content

Search the knowledge base — returns deduplicated matches with no chunks: each carries the KB node ID to read it with 'kb get <id>', and the content ID to scope a later search with --content-ids.

```
senso search content [options] <query>
```

| Option | Description | Default |
|---|---|---|
| `--max-results <n>` | Maximum results (max: 20) | `5` |
| `--content-ids <ids...>` | Restrict search to specific content item IDs (space-separated UUIDs) |  |
| `--require-scoped-ids` | Only return results from the specified --content-ids |  |

### senso search full

Alias for the default search — returns AI answer plus matching chunks. Equivalent to 'senso search <query>'.

```
senso search full [options] <query>
```

| Option | Description | Default |
|---|---|---|
| `--max-results <n>` | Maximum results (max: 20) | `5` |
| `--content-ids <ids...>` | Restrict search to specific content item IDs (space-separated UUIDs) |  |
| `--require-scoped-ids` | Only return results from the specified --content-ids |  |

### senso search stream

Streaming search — returns AI answer tokens in real-time via SSE, followed by source chunks. Use this for a responsive, live search experience.

```
senso search stream [options] <query>
```

| Option | Description | Default |
|---|---|---|
| `--max-results <n>` | Maximum results (max: 20) | `5` |
| `--content-ids <ids...>` | Restrict search to specific content item IDs (space-separated UUIDs) |  |
| `--require-scoped-ids` | Only return results from the specified --content-ids |  |

## senso ingest

Ingest files into the knowledge base. Upload documents (PDF, TXT, DOCX, etc.) to be parsed, chunked, and embedded for semantic search.

```
senso ingest [options] [command]
```

### senso ingest upload

Upload files to the knowledge base. Accepts local file paths (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker. Poll 'senso kb get <kb-node-id>' until content.processing_status is 'complete' before searching the uploaded content.

```
senso ingest upload [options] <files...>
```

| Option | Description | Default |
|---|---|---|
| `--folder-id <id>` | Destination folder ID (skip interactive prompt) |  |

### senso ingest reprocess

Re-ingest an existing document with a new file version. Provide the KB node ID (kb_node_id) and the path to the replacement file.

```
senso ingest reprocess [options] <nodeId> <file>
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

Manage content items in the knowledge base. List, inspect, delete, unpublish, and manage the verification workflow and ownership of content.

```
senso content [options] [command]
```

### senso content list

List top-level files and folders in the knowledge base. Use 'kb my-files' for the same result with richer KB node output.

```
senso content list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Items per page | `10` |
| `--offset <n>` | Pagination offset | `0` |

### senso content get

Get a content item by ID. Returns the full content detail including versions, metadata, and publish status.

```
senso content get [options] <id>
```

### senso content delete

Delete a content item from the knowledge base and any external publish destinations. This cannot be undone.

```
senso content delete [options] <id>
```

### senso content unpublish

Unpublish a content item. Without --publish-record-ids, removes the content from every destination it's live on and sets its status back to draft. With --publish-record-ids, only the specified publish records are retracted — use this to unpublish from a subset of destinations while leaving the rest live. The content status only flips back to draft once no publish records remain live.

```
senso content unpublish [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--publish-record-ids <ids...>` | Restrict unpublish to specific publish_record UUIDs. Use 'content get <id>' to find publish record IDs for a content item. |  |

### senso content verification

List content items in the verification workflow. Filter by editorial status (draft, review, rejected, published) to manage the review pipeline.

```
senso content verification [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Maximum items to return |  |
| `--offset <n>` | Number of items to skip (for pagination) |  |
| `--search <query>` | Filter by title |  |
| `--status <status>` | Filter by status: all, draft, review, rejected, published |  |
| `--substatus <substatus>` | Narrow further (only valid with --status published): pending_draft |  |

### senso content verification-counts

Get counts of content by editorial status (draft, published, rejected, pending published-draft) plus per-destination published-domain summaries. A lightweight alternative to paging through 'content verification'.

```
senso content verification-counts [options]
```

### senso content verification-velocity

Get publish-to-citation velocity for all published content: how many live pages have ever been cited, the average days from publish to first citation, and the same broken down per publisher. Requires the GEO product.

```
senso content verification-velocity [options]
```

### senso content provenance

Audit the provenance of one published URL: how its knowledge base sources were ingested, the retrieved chunks and model context, the accepted generation attempt, the editing history, and every publish record. Each stage reports what stored evidence proves and what is missing rather than guessing. --url must match a live publish record's URL exactly — 'publish-records list' is where those URLs come from. Requires the GEO product.

```
senso content provenance [options]
```

| Option | Description | Default |
|---|---|---|
| `--url <url>` | The live published URL to audit, matched exactly |  |

### senso content citation-details

Get citation detail for one published content item: a pooled summary, per-destination metrics, and a daily trend, over an optional date window and model/location filter. Content IDs come from 'content list' or 'content verification'. Requires the GEO product.

```
senso content citation-details [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--start-date <YYYY-MM-DD>` | Inclusive start of the window |  |
| `--end-date <YYYY-MM-DD>` | Inclusive end of the window; not before --start-date |  |
| `--models <list>` | Comma-separated models to filter by (e.g. chatgpt,perplexity). Omit for all. |  |
| `--locations <list>` | Comma-separated locations to filter by. Omit for all. |  |

### senso content citation-prompts

List the prompt/model rows whose question runs cite one of a published content item's live URLs, with the mention-rate and share-of-voice lift against runs that cite none of them. Use it to see which prompts a published page is actually winning. Content IDs come from 'content list'. Requires the GEO product.

```
senso content citation-prompts [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--start-date <YYYY-MM-DD>` | Inclusive start of the window |  |
| `--end-date <YYYY-MM-DD>` | Inclusive end of the window; not before --start-date |  |
| `--models <list>` | Comma-separated models to filter by (e.g. chatgpt,perplexity). Omit for all. |  |
| `--locations <list>` | Comma-separated locations to filter by. Omit for all. |  |
| `--destinations <list>` | Comma-separated publisher slugs to restrict to. Unknown slugs are ignored. |  |

### senso content record-edits

Record Builder edit-telemetry events for a content item in bulk, and return how many were inserted versus skipped as duplicates. An event repeating a client_event_id already seen by the organization is skipped. Events are processed in order, so an invalid one fails the request with the earlier events already recorded. Requires the GEO product.

```
senso content record-edits [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "events": [{ "event_type": "ai_patch_accepted", "edit_source": "ai", "client_event_id": "<uuid>" }] } |  |

### senso content versions

List the version history for a content item, newest first. The current version is flagged with is_current.

```
senso content versions [options] <id>
```

### senso content reject

Reject a content version in the verification workflow. Optionally provide a reason for the rejection.

```
senso content reject [options] <versionId>
```

| Option | Description | Default |
|---|---|---|
| `--reason <text>` | Reason for rejection |  |

### senso content restore

Restore a rejected content version back to draft status for further editing.

```
senso content restore [options] <versionId>
```

### senso content owners

List the owners assigned to a content item. Owners are responsible for reviewing and approving content.

```
senso content owners [options] <id>
```

### senso content set-owners

Replace all owners of a content item with a new set of user IDs.

```
senso content set-owners [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--user-ids <ids...>` | User IDs to set as owners |  |

### senso content remove-owner

Remove a single owner from a content item.

```
senso content remove-owner [options] <id> <userId>
```

### senso content tags

Manage tags attached to a content item (both KB-ingested and generated). Content is auto-tagged on creation (KB uploads get tagged once ingestion finishes, raw content is tagged on create) — use these commands to override, add, or remove tags afterwards. Tag names are resolved against the org's tag library; unknown names are created automatically.

```
senso content tags [options] [command]
```

### senso content tags list

List tags attached to a content item.

```
senso content tags list [options] <id>
```

### senso content tags set

Replace the content item's full tag collection. Provide --names (comma-separated) and/or --ids (comma-separated UUIDs). Unknown names are created.

```
senso content tags set [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--names <list>` | Comma-separated tag names (created if missing) |  |
| `--ids <list>` | Comma-separated existing tag UUIDs |  |

### senso content tags add

Attach a single tag by --name (created if missing) or --id.

```
senso content tags add [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name (created if missing) |  |
| `--id <tagId>` | Existing tag UUID |  |

### senso content tags remove

Detach a single tag by --name or --id. Idempotent.

```
senso content tags remove [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name to detach |  |
| `--id <tagId>` | Existing tag UUID to detach |  |

## senso ctas

Manage call-to-action (CTA) templates — the card attached to a published content-engine page — and choose which one each content item carries. One template can be the organization default; content items either inherit it, pin a specific template, or publish with no CTA. Requires the GEO product.

```
senso ctas [options] [command]
```

### senso ctas list

List every CTA template in the organization, the default first and the rest oldest first. This is where a cta_id comes from for 'ctas update', 'ctas delete', 'ctas set-default' and 'ctas set-for-content'. The full payload also carries default_cta, the template currently set as the organization default.

```
senso ctas list [options]
```

### senso ctas create

Create a CTA template and return it, including its new cta_id. 'title', 'button_label' and 'target_url' are required; 'image_url' is typically one returned by 'ctas upload-url'. Pass "is_default": true to make it the organization default in the same call, replacing any previous default.

```
senso ctas create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "title": "Start an application", "description": "Book a short consultation.", "button_label": "Apply now", "target_url": "https://example.com/apply", "eyebrow": "Get started", "image_url": "https://...", "agent_text": "...", "is_default": false } |  |

### senso ctas update

Replace a CTA template's fields (PUT) and return it. The body is the full template — any optional field you omit is cleared, so read the current values with 'ctas list' first. "is_default": true promotes it to the organization default; false or omitted leaves the default flag as it is. Live pages carrying this template are updated to match, and the response reports how many.

```
senso ctas update [options] <ctaId>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "title": "Start an application", "button_label": "Apply today", "target_url": "https://example.com/apply" } |  |

### senso ctas delete

Delete a CTA template. The organization default cannot be deleted — run 'ctas clear-default' or 'ctas set-default <ctaId>' first, or this exits 1 on a 409. Content items pinned to the deleted template fall back to the default; pages already live keep it until they are next published. Take the cta_id from 'ctas list'.

```
senso ctas delete [options] <ctaId>
```

### senso ctas set-default

Make a CTA template the organization default, replacing any previous default, and return the template. Content items that inherit the default show it from the next publish; live pages inheriting it are updated, and the response reports how many carry the template. Take the cta_id from 'ctas list'.

```
senso ctas set-default [options] <ctaId>
```

### senso ctas clear-default

Clear the organization default so that no template is the default. Live content items inheriting the default switch to no CTA and their pages drop the card; items that are not live keep 'default', which resolves to nothing until a default is set again. Succeeds even when no default was set.

```
senso ctas clear-default [options]
```

### senso ctas for-content

Show which CTA a content item carries when it is published: 'default' (the organization default), 'template' (a pinned cta_id), or 'none'. The payload also carries the template the selection resolves to. Only content-engine content has a selection — anything else exits 4. Content IDs come from 'content list' or 'generated-content list'.

```
senso ctas for-content [options] <contentId>
```

### senso ctas set-for-content

Set which CTA a content item carries when it is published, and return the resulting selection. --selection default inherits the organization default, template pins the one named by --cta-id, and none publishes without a CTA. This is a full replacement. If the item is already live, its page is updated to match. Content IDs come from 'content list'; cta_ids from 'ctas list'.

```
senso ctas set-for-content [options] <contentId>
```

| Option | Description | Default |
|---|---|---|
| `--selection <type>` | What to carry: default \| template \| none |  |
| `--cta-id <ctaId>` | The template to pin. Required with --selection template only. |  |

### senso ctas upload-url

Get a short-lived pre-signed URL for a CTA image. Upload the bytes yourself with an HTTP PUT to 'upload_url', sending exactly the returned 'upload_headers', then pass the returned 'image_url' as a template's image_url in 'ctas create' or 'ctas update'. Exits 1 with a 503 when image storage is not configured for the deployment.

```
senso ctas upload-url [options]
```

| Option | Description | Default |
|---|---|---|
| `--filename <name>` | The file's name. Its extension, when it has one, must match --content-type. |  |
| `--content-type <type>` | The image media type: image/png \| image/jpeg \| image/webp \| image/gif |  |
| `--size <bytes>` | The file size in bytes, at most 10485760 (10 MiB) |  |

## senso evals

Judge text against your organization's ground truth. `kb_accuracy` verifies the factual claims a text makes about your brand against your knowledge base; `brand_alignment` grades it against your brand kit's writing rules. Every run records the claims it checked, the verdict and the evidence, so a score can be audited rather than trusted. Judge model spend is recorded on each run but is not billed against your credit balance.

```
senso evals [options] [command]
```

### senso evals evaluators

List the evaluators available to this organization, with the version each one is currently on. Use `latest_version` here to pin `--evaluator-version` on a trigger.

```
senso evals evaluators [options]
```

### senso evals text

Judge text you supply. Pass the text with --text, or --text-file to read it from a file. Returns straight away with a run handle to read later with `senso evals get`; add --wait to poll until the run finishes and print the finished run instead. A run that ends `failed` under --wait exits 1, so a caller that waited and got exit 0 can trust the score it was handed.

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
| `--text <text>` | The text to judge |  |
| `--text-file <path>` | Read the text to judge from a file |  |
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
| `--run-id <id>` | Only claims from this eval run |  |

### senso evals content

Judge a saved content item — a knowledge-base document or a generated article — by its content id. Its latest saved version is what gets judged, and only items whose latest version is raw text can be: an uploaded file or a crawled page stores a pointer rather than text of its own and is a 422. Add --wait to poll until the run finishes.

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

## senso generate

AI content generation. Configure settings, generate content samples from prompts, or trigger full content engine runs.

```
senso generate [options] [command]
```

### senso generate settings

Get content generation settings. Shows whether generation and auto-publish are enabled, the content schedule, and configured publishers.

```
senso generate settings [options]
```

### senso generate update-settings

Update content generation settings. Control auto-publish, generation toggle, and schedule (days of week 0-6).

```
senso generate update-settings [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON settings: { "enable_content_generation": bool, "content_auto_publish": bool, "content_schedule": [0-6], "selected_content_type_id": "<uuid>" } |  |

### senso generate sample

Generate an ad hoc content sample for a specific prompt and content type. Submits an async job, waits for completion by default, then returns the generated markdown, SEO title, and publish results. Use 'prompts list' to find a prompt ID, and 'content-types list' to find a content-type ID.

```
senso generate sample [options]
```

| Option | Description | Default |
|---|---|---|
| `--prompt-id <id>` | Prompt (geo question) ID to generate content for |  |
| `--content-type-id <id>` | Content type ID that defines the output format (use 'content-types list' to find) |  |
| `--destination <dest>` | Publisher slug to publish to immediately after generation. Omit to save as draft only. |  |
| `--no-wait` | Return the accepted sample job immediately instead of polling for the generated content. |  |

### senso generate run

Trigger a content generation run. Processes all prompts (or a specific subset) through the content engine. Runs asynchronously — use 'generate runs-list' to monitor progress.

```
senso generate run [options]
```

| Option | Description | Default |
|---|---|---|
| `--prompt-ids <ids...>` | Optional list of prompt IDs to process (omit to run all) |  |
| `--content-type-id <id>` | Override the org's default content type for this run |  |
| `--publisher-ids <ids...>` | Restrict publishing to specific publisher IDs |  |

### senso generate job-context

Get the full content generation job context — all prompts with queue status (create vs update), content state, and a summary of queue counts.

```
senso generate job-context [options]
```

### senso generate runs-list

List content generation runs for the org. Use --status to filter by run status, --active-only to show only in-progress runs.

```
senso generate runs-list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Items per page | `20` |
| `--offset <n>` | Pagination offset | `0` |
| `--status <status>` | Filter by run status |  |
| `--active-only` | Only return active (in-progress) runs |  |
| `--start-date <date>` | Filter runs on or after this date (YYYY-MM-DD) |  |
| `--end-date <date>` | Filter runs on or before this date (YYYY-MM-DD) |  |

### senso generate runs-get

Get details for a specific content generation run.

```
senso generate runs-get [options] <runId>
```

### senso generate runs-items

List individual prompt items within a content generation run and their per-item status.

```
senso generate runs-items [options] <runId>
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Items per page | `100` |
| `--offset <n>` | Pagination offset | `0` |
| `--status <status>` | Filter by item status: pending, running, succeeded, failed, skipped, stopped |  |

### senso generate runs-logs

List log entries for a content generation run.

```
senso generate runs-logs [options] <runId>
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Items per page | `100` |
| `--offset <n>` | Pagination offset | `0` |

### senso generate industry-draft

Draft a complete document from one of your industry's prompts in a single call. The prompt is resolved against your organization's industry, grounded in your knowledge base, and written in the requested content type with your brand kit and product lines applied. The result is NOT stored as content — it comes back as GitHub Flavored Markdown with footnote citations for you to review or store separately. Typically takes 10-30 seconds and consumes credits like an ad-hoc generation. Requires the GEO product.

```
senso generate industry-draft [options]
```

| Option | Description | Default |
|---|---|---|
| `--industry-prompt-id <id>` | An industry prompt id from `senso industries prompts` — NOT one of your own prompt ids |  |
| `--content-type-id <id>` | A content type id from `senso content-types list`, giving the document its format |  |
| `--product-line-ids <ids>` | Comma-separated product line ids (default: all, up to 100) |  |
| `--audience <text>` | Who the document is for (max 500 chars) |  |
| `--style-tone <text>` | Voice and tone guidance (max 500 chars) |  |
| `--extra-instructions <text>` | Further instructions for the writer (max 4000 chars) |  |

## senso engine

Publish or draft content through the content engine. Used to push AI-generated content to external destinations (citeables by default) or save it as a draft for review.

```
senso engine [options] [command]
```

### senso engine publish

Publish content to external destinations via the content engine. Requires geo_question_id, raw_markdown, and seo_title. By default publishes to every destination currently selected for generation (citeables is the default for most orgs — see 'senso destinations list'). Pass --publisher-ids to restrict publishing to a specific subset, or include 'publisher_ids' inside --data. To record content as already published externally rather than pushing it to destinations, set mark_as_published (and optionally manual_published_at) in --data.

```
senso engine publish [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "geo_question_id": "uuid", "raw_markdown": "...", "seo_title": "...", "summary": "...", "publisher_ids": ["<uuid>", ...], "mark_as_published": false, "manual_published_at": "2026-06-11T00:00:00Z" } |  |
| `--publisher-ids <ids...>` | Restrict publishing to specific publisher IDs. Overrides any publisher_ids present in --data. Omit to publish to all configured destinations (citeables by default). |  |

### senso engine draft

Save content as a draft for review before publishing. Requires geo_question_id, raw_markdown, and seo_title. Drafts do not hit any destination until you run 'senso engine publish' on them.

```
senso engine draft [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "geo_question_id": "uuid", "raw_markdown": "...", "seo_title": "...", "summary": "..." } |  |

## senso destinations

Manage publish destinations. Destinations are where generated content gets published — shared domains (citeables, codeables, cucopilot) plus any custom citeables domains registered for your org. Most orgs publish to 'citeables' by default; additional destinations are opt-in.

```
senso destinations [options] [command]
```

### senso destinations list

List all destinations available to the organization. Includes shared destinations (citeables, codeables, cucopilot) and any custom domains you've added, with per-destination live article counts and last publish timestamps. 'selected_for_generation: true' means a destination is active in your generation pipeline.

```
senso destinations list [options]
```

### senso destinations add

Register a custom publish destination (a citeables-system domain owned by your org). The domain is registered synchronously with the citeables service and linked to the org. Today only citeables-type destinations (slugs: citeables, codeables, cucopilot) are supported — pass --type if you need to target one of the non-default systems; new destination types may be added in future releases.

```
senso destinations add [options]
```

| Option | Description | Default |
|---|---|---|
| `--domain <domain>` | Custom domain to register (e.g. "content.example.com") |  |
| `--name <name>` | Display name for the destination (e.g. "Example Citeables") |  |
| `--type <type>` | Destination type. One of: citeables, codeables, cucopilot. Defaults to citeables. | `citeables` |

### senso destinations remove

Remove a destination from the org. --action controls what happens to live content: 'leave' keeps the articles live at the destination (org stops publishing to it but published records remain), 'unpublish' removes live articles from the destination and returns content to draft, 'delete' unpublishes AND hard-deletes the local content records. Shared destinations (citeables/codeables/cucopilot) can be removed from the org without affecting the underlying domain. --keep-domain preserves the custom domain registration on the citeables side (useful for SEO) when removing a custom destination.

```
senso destinations remove [options] <publisherId>
```

| Option | Description | Default |
|---|---|---|
| `--action <action>` | One of: leave, unpublish, delete. See command description. |  |
| `--also-remove-destination` | Also delete the publisher row (not just the org link). Only valid for custom destinations you own. |  |
| `--keep-domain` | Keep the custom domain registered on citeables after removing (custom destinations only). |  |

## senso publish-records

Inspect and retry publish records. A publish_record is the unit that tracks one content item's publication to one destination — published/live, pending, failed, unpublished, etc. When a publish fails for a single destination, retry it here without redoing the whole publish.

```
senso publish-records [options] [command]
```

### senso publish-records retry

Retry a failed publish record. Re-runs the publish for that specific content+destination pair and flips the record's state based on the new attempt. Only works on records currently in the 'failed' state.

```
senso publish-records retry [options] <publishRecordId>
```

## senso brand-kit

Manage the organization's brand kit guidelines that inform AI content generation about your brand voice, tone, and style. The guidelines object accepts a defined set of keys: brand_name, brand_domain, brand_description, voice_and_tone, author_persona, global_writing_rules (global_writing_rules is an array of strings, the rest are strings). Unknown keys, wrong types and nulls are rejected before the request is sent.

```
senso brand-kit [options] [command]
```

### senso brand-kit get

Get the current brand kit guidelines. An organization that has never saved one gets an empty guidelines object rather than an error.

```
senso brand-kit get [options]
```

### senso brand-kit set

Replace the entire brand kit (PUT). All existing fields are overwritten — run 'brand-kit get' first to preserve fields you are not changing. For a safe partial update, use 'brand-kit patch'. This is also what creates the brand kit the first time.

```
senso brand-kit set [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "guidelines": { "brand_name": "Acme", "brand_domain": "https://acme.com", "brand_description": "...", "voice_and_tone": "...", "author_persona": "...", "global_writing_rules": ["..."] } }. Every field is optional, but anything you omit is REMOVED — pass '{"guidelines":{}}' to clear the brand kit entirely. |  |

### senso brand-kit patch

Partially update the brand kit (PATCH). Only the fields you provide are changed — existing fields are preserved. Preferred over 'set' for targeted updates. Note that global_writing_rules is replaced wholesale, not appended to, and no field can be removed this way — use 'set' for that.

```
senso brand-kit patch [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "guidelines": { "voice_and_tone": "Warm and approachable" } }. At least one field is required; accepted fields are brand_name, brand_domain, brand_description, voice_and_tone, author_persona, global_writing_rules. |  |

## senso content-types

Manage content type configurations. Content types define the output format and structure for AI-generated content (e.g. blog post, FAQ, landing page).

```
senso content-types [options] [command]
```

### senso content-types list

List all content types configured for the organization.

```
senso content-types list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Maximum number of content types to return (default: 50) |  |
| `--offset <n>` | Number of items to skip (for pagination) |  |

### senso content-types create

Create a new content type. Requires a name and a config defining the output structure. config accepts a defined set of keys: template, template_spec, cta_text, cta_destination, writing_rules (array). Unknown keys are rejected.

```
senso content-types create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "Blog Post", "config": { "template": "...", "cta_text": "...", "cta_destination": "...", "writing_rules": [] } } |  |

### senso content-types get

Get a content type by ID, including its full configuration.

```
senso content-types get [options] <id>
```

### senso content-types update

Replace a content type's name and config (PUT). Both fields are required — run 'get <id>' first to preserve existing values. For single-field updates, use 'content-types patch <id>'.

```
senso content-types update [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "Updated Name", "config": { "template": "...", "cta_text": "...", "cta_destination": "...", "writing_rules": [] } } |  |

### senso content-types patch

Partially update a content type (PATCH). Only the fields you provide are changed — existing fields are preserved. Preferred over 'update' for targeted changes like updating just the template.

```
senso content-types patch [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "config": { "template": "Updated template instruction" } } |  |

### senso content-types delete

Delete a content type. This cannot be undone.

```
senso content-types delete [options] <id>
```

## senso prompts

Manage prompts (GEO questions). Each prompt is a question that drives both AI content generation (use with 'generate sample --prompt-id') and brand visibility monitoring — tracking how AI models mention your brand, products, and competitors.

```
senso prompts [options] [command]
```

### senso prompts list

List all prompts in the organization. Use --search to filter by question text, --sort to order results.

```
senso prompts list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Maximum prompts to return (max: 100) |  |
| `--offset <n>` | Number of prompts to skip (for pagination) |  |
| `--search <query>` | Filter prompts by question text |  |
| `--sort <order>` | Sort order: created_desc, created_asc, text_asc, text_desc, type_asc, type_desc |  |

### senso prompts create

Create a new prompt. Type must be one of: decision, consideration, awareness, evaluation.

```
senso prompts create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "question_text": "What are the best...", "type": "decision" } |  |

### senso prompts get

Get a prompt with its full run history. Includes all question runs with mentions, claims, citations, and competitor data.

```
senso prompts get [options] <promptId>
```

### senso prompts delete

Delete a prompt and all its associated run history. This cannot be undone.

```
senso prompts delete [options] <promptId>
```

### senso prompts tags

Manage tags attached to a prompt. Prompts are auto-tagged on creation — use these commands to override, add, or remove tags afterwards. Tag names are resolved against the org's tag library; unknown names are created automatically.

```
senso prompts tags [options] [command]
```

### senso prompts tags list

List tags attached to a prompt.

```
senso prompts tags list [options] <promptId>
```

### senso prompts tags set

Replace the prompt's full tag collection. Provide --names (comma-separated) and/or --ids (comma-separated UUIDs). Unknown names are created.

```
senso prompts tags set [options] <promptId>
```

| Option | Description | Default |
|---|---|---|
| `--names <list>` | Comma-separated tag names (created if missing) |  |
| `--ids <list>` | Comma-separated existing tag UUIDs |  |

### senso prompts tags add

Attach a single tag by --name (created if missing) or --id.

```
senso prompts tags add [options] <promptId>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name (created if missing) |  |
| `--id <tagId>` | Existing tag UUID |  |

### senso prompts tags remove

Detach a single tag by --name or --id. Idempotent.

```
senso prompts tags remove [options] <promptId>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name to detach |  |
| `--id <tagId>` | Existing tag UUID to detach |  |

## senso run-config

Configure which AI models are used for question runs and on which days they run. Models include chatgpt, gemini, etc.

```
senso run-config [options] [command]
```

### senso run-config models

Get the AI models currently configured for question runs (e.g. chatgpt, gemini).

```
senso run-config models [options]
```

### senso run-config set-models

Replace the configured AI models for question runs. At least one model name is required.

```
senso run-config set-models [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "models": ["chatgpt", "gemini"] } |  |

### senso run-config model-options

List the model names 'run-config set-models' accepts, each with a display label. The options are global rather than per-org — read them before writing, so an unsupported name does not cost a round trip.

```
senso run-config model-options [options]
```

### senso run-config scheduler-models

Get the models the scheduler runs for the organization, as provider/model pairs with their execution mode. This is a separate set from 'run-config models' — though writing run models also replaces it.

```
senso run-config scheduler-models [options]
```

### senso run-config set-scheduler-models

Replace the organization's scheduler model opt-in. Each entry is a 'provider/model' identifier such as anthropic/claude. The supported set is configurable, so do not assume it: an unsupported entry exits 1 and the error lists every accepted value.

```
senso run-config set-scheduler-models [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "models": ["anthropic/claude", "openai/gpt"] } |  |

### senso run-config schedule

Get the days of the week when question runs are triggered (0=Sunday, 1=Monday, ..., 6=Saturday).

```
senso run-config schedule [options]
```

### senso run-config set-schedule

Set which days of the week question runs are triggered. Values must be 0-6 (Sunday-Saturday).

```
senso run-config set-schedule [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "schedule": [1, 3, 5] } |  |

## senso skills

Install and manage Senso agent skills. Skills teach AI coding agents (Claude Code, Cursor, Codex, etc.) how to use Senso automatically.

```
senso skills [options] [command]
```

### senso skills install

Install Senso agent skills. Use --all for every official skill, or pass individual short names (search, ingest, content-gen, brand-setup, kb-organize, review-publish, onboarding).

```
senso skills install [options] [names...]
```

| Option | Description | Default |
|---|---|---|
| `--all` | Install every official Senso skill |  |
| `--agent <name>` | Target a specific agent: claude, cursor, codex, copilot, gemini, cline |  |
| `--global` | Install globally instead of project-level |  |

### senso skills list

List installed Senso skills.

```
senso skills list [options]
```

| Option | Description | Default |
|---|---|---|
| `--global` | List globally installed skills |  |

### senso skills list-available

Show every official Senso skill available for install.

```
senso skills list-available [options]
```

### senso skills remove

Remove an installed Senso skill. Use the short name (e.g., search, ingest, content-gen).

```
senso skills remove [options] <name>
```

| Option | Description | Default |
|---|---|---|
| `--global` | Remove from global install |  |

## senso members

View the organization member directory. Lists all users who belong to the organization with their names and emails.

```
senso members [options] [command]
```

### senso members list

List all organization members. Use --search to filter by name or email, --sort to order results.

```
senso members list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Maximum members to return (max: 1000) |  |
| `--offset <n>` | Number of members to skip (for pagination) |  |
| `--search <query>` | Filter by name or email |  |
| `--sort <order>` | Sort order: name_asc, name_desc, email_asc, email_desc, created_asc, created_desc |  |

## senso credits

View your organization's credit balance. Credits are consumed by AI content generation and search operations.

```
senso credits [options] [command]
```

### senso credits balance

Get the current credit balance for the organization. Returns available credits and any spend limit configured.

```
senso credits balance [options]
```

## senso questions

Manage org-scoped geo questions. These are lightweight CRUD questions distinct from prompts (which include full run history).

```
senso questions [options] [command]
```

### senso questions list

List geo questions for the org.

```
senso questions list [options]
```

| Option | Description | Default |
|---|---|---|
| `--type <type>` | Filter by question type: organization \| network | `organization` |

### senso questions create

Create a new geo question. Type must be one of: decision, consideration, awareness, evaluation.

```
senso questions create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "question_text": "...", "type": "decision", "tag_ids": [] } |  |

### senso questions patch

Partially update a question. Supports updating tag associations and/or the funnel stage (type). At least one of tag_ids or type must be provided.

```
senso questions patch [options] <questionId>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "tag_ids": ["<uuid>", ...], "type": "decision\|consideration\|awareness\|evaluation" } — pass tag_ids: null to clear all tags |  |

### senso questions delete

Delete a geo question.

```
senso questions delete [options] <questionId>
```

## senso kb

Manage the knowledge base. Browse nodes, upload files, create folders, create raw content, and manage the KB tree.

```
senso kb [options] [command]
```

### senso kb root

Get the root KB node for the org.

```
senso kb root [options]
```

### senso kb stats

Get how many documents and folders the knowledge base holds, as total_files and total_folders (the root folder is not counted). A cheap way to check the size of the KB without paging through 'kb my-files'.

```
senso kb stats [options]
```

### senso kb my-files

List top-level files and folders in the knowledge base.

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
| `--tag-ids <ids>` | Comma-separated tag IDs; only nodes carrying at least one of them |  |

### senso kb find

Search KB nodes by name.

```
senso kb find [options]
```

| Option | Description | Default |
|---|---|---|
| `--query <q>` | Name search query |  |
| `--limit <n>` | Items per page, 1-50 (the API caps higher values at 50) | `20` |
| `--offset <n>` | Pagination offset | `0` |
| `--type <type>` | Only nodes of this type: folder \| content |  |
| `--status <status>` | Only documents in this ingestion state: pending \| processing \| complete \| failed. Ignored with --type folder |  |
| `--role <role>` | Only nodes where the caller holds this role: editor \| viewer. Ignored for org-admin keys, which already reach everything |  |
| `--sort-by <field>` | Sort by: name \| updated_at \| created_at \| type \| status \| role |  |
| `--sort-order <dir>` | Sort direction: asc \| desc |  |
| `--tag-ids <ids>` | Comma-separated tag IDs; only nodes carrying at least one of them |  |

### senso kb sync-status

Report whether queued move and delete operations are still propagating across the org's knowledge base. This is not an ingestion signal — to check whether a newly added document is queryable, run 'kb get <id>' and read content.processing_status.

```
senso kb sync-status [options]
```

### senso kb get

Get a KB node by ID.

```
senso kb get [options] <id>
```

### senso kb children

List children of a KB folder node.

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
| `--tag-ids <ids>` | Comma-separated tag IDs; only nodes carrying at least one of them |  |

### senso kb ancestors

Get the ancestor chain (breadcrumb) for a KB node.

```
senso kb ancestors [options] <id>
```

### senso kb get-content

Get the content detail for a KB content node.

```
senso kb get-content [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--rev <n>` | Retrieve a specific stored version of this content, by version number |  |

### senso kb download-url

Get a presigned S3 download URL for a KB file node.

```
senso kb download-url [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--rev <n>` | Download a specific stored version of this file, by version number |  |

### senso kb create-folder

Create a new folder in the knowledge base.

```
senso kb create-folder [options]
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Folder name |  |
| `--parent-id <id>` | Parent folder node ID (omit to create at root) |  |

### senso kb rename

Rename a KB node.

```
senso kb rename [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | New name |  |

### senso kb move

Move a KB node to a different parent folder.

```
senso kb move [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--parent-id <parentId>` | Target parent folder node ID |  |

### senso kb delete

Delete a KB node.

```
senso kb delete [options] <id>
```

### senso kb bulk-delete

Delete up to 100 KB nodes in one call. Folders take their whole subtree with them. The batch is all-or-nothing: if any node is missing, not permitted, a root, or still ingesting, nothing is deleted. Node IDs come from 'kb my-files', 'kb children' or 'kb find'. This cannot be undone.

```
senso kb bulk-delete [options] <nodeIds...>
```

### senso kb create-raw

Create a raw (text/markdown) content item in the knowledge base. Senso auto-tags the document in the background once ingestion finishes; use 'kb tags set' to override those tags afterwards.

```
senso kb create-raw [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "text": "# Hello", "title": "My doc", "summary": "...", "kb_folder_node_id": "<uuid>" }. Only "text" is required. Tags cannot be set on creation — the API ignores "tag_ids" here without reporting it. |  |

### senso kb update-raw

Fully replace the text content of a raw KB node (creates a new version). Re-ingestion re-runs auto-tagging, which may add tags of its own after this call.

```
senso kb update-raw [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "title": "Title", "text": "# Updated content", "summary": "...", "tag_ids": ["<uuid>"] }. "title" and "text" are both required. "tag_ids" REPLACES the whole tag set — omit it to keep the current tags, pass [] to clear them. Every ID must already exist in the org, or the entire update is rejected. |  |

### senso kb patch-raw

Partially update the text content of a raw KB node. Re-ingestion re-runs auto-tagging, which may add tags of its own after this call.

```
senso kb patch-raw [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "title": "New title", "text": "Updated text", "summary": "...", "tag_ids": ["<uuid>"] }. Supply at least one of title/summary/text — "tag_ids" on its own is rejected. "tag_ids" REPLACES the whole tag set — omit it to keep the current tags, pass [] to clear them. |  |

### senso kb upload

Upload files to the knowledge base (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker. Poll 'senso kb get <kb-node-id>' until content.processing_status is 'complete' before searching the uploaded content.

```
senso kb upload [options] <files...>
```

| Option | Description | Default |
|---|---|---|
| `--folder-id <id>` | Parent folder node ID to place files in (omit for root) |  |

### senso kb update-file

Replace the file on an existing KB file node with a new version.

```
senso kb update-file [options] <id> <file>
```

### senso kb tags

Manage tags attached to a KB node. KB content is auto-tagged on creation (raw content on create, uploaded files once ingestion finishes) — use these commands to override, add, or remove tags afterwards. Tags can only be applied to content nodes, not folders. Names are resolved against the org's tag library; unknown names are created.

```
senso kb tags [options] [command]
```

### senso kb tags list

List tags attached to a KB node.

```
senso kb tags list [options] <id>
```

### senso kb tags set

Replace the KB node's full tag collection. Provide --names (comma-separated) and/or --ids. Unknown names are created.

```
senso kb tags set [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--names <list>` | Comma-separated tag names (created if missing) |  |
| `--ids <list>` | Comma-separated existing tag UUIDs |  |

### senso kb tags add

Attach a single tag by --name (created if missing) or --id.

```
senso kb tags add [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name (created if missing) |  |
| `--id <tagId>` | Existing tag UUID |  |

### senso kb tags remove

Detach a single tag by --name or --id. Idempotent.

```
senso kb tags remove [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name to detach |  |
| `--id <tagId>` | Existing tag UUID to detach |  |

### senso kb permissions

Manage who can see and edit a knowledge base node. A grant gives one user or group viewer or editor access to a node; owner is assigned by the platform and cannot be granted here. Node IDs come from 'kb my-files', 'kb children' or 'kb find'.

```
senso kb permissions [options] [command]
```

### senso kb permissions list

List the access grants on a KB node — who holds what role, with the grantee's name and (for users) email. Group grants you cannot see are omitted. This is where the permission ID for 'kb permissions update' and 'kb permissions remove' comes from.

```
senso kb permissions list [options] <id>
```

### senso kb permissions add

Grant a user or group viewer or editor access to a KB node, and return the new grant with its ID. Use 'kb permissions update' to change the role of a grant that already exists. User IDs come from 'users list'; group IDs from 'permissions groups'.

```
senso kb permissions add [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--grantee-type <type>` | Who the grant is for: user \| group |  |
| `--grantee-id <id>` | The user ID or group ID to grant access to |  |
| `--role <role>` | Access level to grant: viewer \| editor |  |

### senso kb permissions update

Change an existing grant's role to viewer or editor. You cannot change your own grant. The permission ID comes from 'kb permissions list <id>'.

```
senso kb permissions update [options] <id> <permissionId>
```

| Option | Description | Default |
|---|---|---|
| `--role <role>` | The new role: viewer \| editor |  |

### senso kb permissions remove

Revoke an access grant on a KB node. You cannot revoke your own grant. The permission ID comes from 'kb permissions list <id>'.

```
senso kb permissions remove [options] <id> <permissionId>
```

## senso permissions

View available role permissions for the organization.

```
senso permissions [options] [command]
```

### senso permissions list

List all available permission keys with their names, descriptions, and categories. Useful for building role management UIs.

```
senso permissions list [options]
```

## senso tags

Manage the organization's tag library. Tags are labels attached to prompts, KB nodes, and content items to group them for filtering or metric rollups. Senso auto-tags prompts, KB content, and search queries on creation, so the tag library grows automatically — most workflows skip these commands and rely on attach-by-name on the resource commands, which also creates tags on demand.

```
senso tags [options] [command]
```

### senso tags list

List all tags for the organization. Pass --counts to include per-tag usage counts.

```
senso tags list [options]
```

| Option | Description | Default |
|---|---|---|
| `--counts` | Include prompt/content usage counts |  |

### senso tags create

Create a new tag. Tag names are unique per org (case-insensitive).

```
senso tags create [options]
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Tag name |  |

### senso tags get

Get a tag by ID, including usage counts.

```
senso tags get [options] <id>
```

### senso tags update

Rename a tag. Existing attachments on prompts, content, and KB nodes are preserved.

```
senso tags update [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | New tag name |  |

### senso tags delete

Delete a tag and detach it from every prompt, content item, and KB node it was applied to. This cannot be undone.

```
senso tags delete [options] <id>
```

## senso product-lines

Manage product lines — flexible org-scoped product/service definitions. Each product line has a name and an arbitrary JSON 'details' blob carried by downstream generation and evaluation pipelines.

```
senso product-lines [options] [command]
```

### senso product-lines list

List all product lines for the organization.

```
senso product-lines list [options]
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Maximum items to return (default: 50) |  |
| `--offset <n>` | Number of items to skip (for pagination) |  |

### senso product-lines create

Create a new product line. 'details' is an open-ended JSON object — put whatever structured metadata (SKUs, URLs, positioning, pricing tiers) your workflows need.

```
senso product-lines create [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "Pro Plan", "details": { ... } } |  |

### senso product-lines get

Get a product line by ID.

```
senso product-lines get [options] <id>
```

### senso product-lines update

Replace a product line's name and details (PUT). Both fields are required — run 'get <id>' first to preserve existing values. For single-field updates, use 'product-lines patch <id>'.

```
senso product-lines update [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "name": "Updated Name", "details": { ... } } |  |

### senso product-lines patch

Partially update a product line (PATCH). Only the fields you provide are changed — existing fields are preserved.

```
senso product-lines patch [options] <id>
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "details": { "price": 99 } } |  |

### senso product-lines delete

Delete a product line. This cannot be undone.

```
senso product-lines delete [options] <id>
```

## senso roles

Inspect the roles defined for your organization. Each organization has its own per-org role_ids — resolve a role name to its UUID here before passing role_id to `users invite`, `users add`, or `users update`.

```
senso roles [options] [command]
```

### senso roles list

List every role for the current organization, including the built-in admin/collaborator/viewer roles and any custom roles.

```
senso roles list [options]
```

## senso competitors

Manage the curated list of competitor brands your organization tracks. Tracked competitors feed downstream share-of-voice analytics and inform content-generation prompts.

```
senso competitors [options] [command]
```

### senso competitors list

List every tracked competitor for the current organization.

```
senso competitors list [options]
```

### senso competitors add

Add a single tracked competitor.

```
senso competitors add [options]
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Competitor brand name |  |
| `--url <url>` | Competitor website URL |  |

### senso competitors batch-add

Add up to 50 tracked competitors in one call. Designed for accepting AI-generated suggestions returned by `competitors suggest`.

```
senso competitors batch-add [options]
```

| Option | Description | Default |
|---|---|---|
| `--data <json>` | JSON: { "items": [{ "name": "...", "url": "...", "source": "manual\|suggested_run_text\|suggested_web_search", "rationale": "...", "confidence": 0.85 }, ...] } |  |

### senso competitors suggest

Get AI-generated competitor suggestions seeded from your org's website and recent prompt-run results. Pipe accepted suggestions into `competitors batch-add`.

```
senso competitors suggest [options]
```

### senso competitors update

Update a tracked competitor's name or URL.

```
senso competitors update [options] <competitorId>
```

| Option | Description | Default |
|---|---|---|
| `--name <name>` | Competitor brand name |  |
| `--url <url>` | Competitor website URL |  |

### senso competitors delete

Remove a tracked competitor.

```
senso competitors delete [options] <competitorId>
```

## senso tracked-sources

Manage citation-classification rules that tier each cited URL as Owned (primary), Tracked, or External (secondary). Tracked sources drive share-of-voice and citation analytics. Rules created from published content are read-only.

```
senso tracked-sources [options] [command]
```

### senso tracked-sources list

List every tracked source rule for the current organization.

```
senso tracked-sources list [options]
```

### senso tracked-sources add

Add a tracked source rule. New rules are always created active.

```
senso tracked-sources add [options]
```

| Option | Description | Default |
|---|---|---|
| `--pattern <pattern>` | Value to match cited URLs against, interpreted per --match-type |  |
| `--match-type <type>` | Match strategy: domain \| host \| path_prefix \| exact_url |  |
| `--tier <tier>` | Classification tier: primary (Owned) \| tracked \| secondary (External) |  |
| `--category <category>` | Optional sub-category (only meaningful for the 'tracked' tier): affiliated_domain \| published_content \| social \| press |  |
| `--label <label>` | Optional human-readable label |  |
| `--priority <n>` | Optional ordering priority (integer) |  |

### senso tracked-sources update

Replace a tracked source rule (PUT). Pattern, match type, and tier are required. Published rules are read-only.

```
senso tracked-sources update [options] <sourceId>
```

| Option | Description | Default |
|---|---|---|
| `--pattern <pattern>` | Value to match cited URLs against, interpreted per --match-type |  |
| `--match-type <type>` | Match strategy: domain \| host \| path_prefix \| exact_url |  |
| `--tier <tier>` | Classification tier: primary (Owned) \| tracked \| secondary (External) |  |
| `--category <category>` | Optional sub-category (only meaningful for the 'tracked' tier): affiliated_domain \| published_content \| social \| press |  |
| `--label <label>` | Optional human-readable label |  |
| `--priority <n>` | Optional ordering priority (integer) |  |
| `--active` | Mark the rule active |  |
| `--no-active` | Mark the rule inactive |  |

### senso tracked-sources delete

Remove a tracked source rule.

```
senso tracked-sources delete [options] <sourceId>
```

## senso generated-content

Browse AI-generated content (GEO). List published or draft generated items, or fetch a single item with its rendered body. Requires the GEO product and read:content permission.

```
senso generated-content [options] [command]
```

### senso generated-content list

List generated content. Use --status to switch between published and draft items.

```
senso generated-content list [options]
```

| Option | Description | Default |
|---|---|---|
| `--status <status>` | Which items to list: published \| drafts | `published` |
| `--limit <n>` | Items per page (max 100) | `10` |
| `--offset <n>` | Pagination offset | `0` |
| `--search <query>` | Filter by title |  |

### senso generated-content get

Get a single generated content item including its question text and rendered body.

```
senso generated-content get [options] <id>
```

## senso analytics

GEO analytics for your organization — brand visibility, share of voice, and citations across the AI models you monitor. Every payload ships raw counts alongside the rates, and a rate is null (shown as “—”) when its denominator is zero, never a silent 0%. Run 'senso analytics glossary' for the canonical definition and denominator of every metric.

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
| `--to <date>` | Window end, YYYY-MM-DD (max window: 365 days) |  |
| `--models <list>` | Comma-separated model filter — see 'senso analytics filters' |  |
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
| `--to <date>` | Window end, YYYY-MM-DD (max window: 365 days) |  |
| `--models <list>` | Comma-separated model filter — see 'senso analytics filters' |  |
| `--location <list>` | Comma-separated location filter, case-sensitive (e.g. US, US/California) |  |
| `--prompt-type <type>` | Funnel stage: awareness \| consideration \| evaluation \| decision |  |
| `--tag <tag>` | Restrict to prompts carrying this tag |  |
| `--group-by <bucket>` | Time bucket: day \| week (default: day) |  |

### senso analytics citations

Citation overview: both denominators (D = cited answers, S = citation instances), every tier numerator, the tier rates (÷D) and tier shares (÷S), and the series underneath.

```
senso analytics citations [options]
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data) |  |
| `--to <date>` | Window end, YYYY-MM-DD (max window: 365 days) |  |
| `--models <list>` | Comma-separated model filter — see 'senso analytics filters' |  |
| `--location <list>` | Comma-separated location filter, case-sensitive (e.g. US, US/California) |  |
| `--prompt-type <type>` | Funnel stage: awareness \| consideration \| evaluation \| decision |  |
| `--tag <tag>` | Restrict to prompts carrying this tag |  |
| `--group-by <bucket>` | Time bucket: day \| week (default: day) |  |

### senso analytics domains

Every domain the models cited, ranked. Citation Coverage is this domain's cited answers ÷ D; Citation Share is its citation instances ÷ S. Tiers: primary (Owned) | tracked | secondary (External).

```
senso analytics domains [options]
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data) |  |
| `--to <date>` | Window end, YYYY-MM-DD (max window: 365 days) |  |
| `--models <list>` | Comma-separated model filter — see 'senso analytics filters' |  |
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
| `--to <date>` | Window end, YYYY-MM-DD (max window: 365 days) |  |
| `--models <list>` | Comma-separated model filter — see 'senso analytics filters' |  |
| `--location <list>` | Comma-separated location filter, case-sensitive (e.g. US, US/California) |  |
| `--prompt-type <type>` | Funnel stage: awareness \| consideration \| evaluation \| decision |  |
| `--tier <tier>` | Filter by tier: primary \| tracked \| secondary |  |
| `--domain <domain>` | Restrict to one exact domain |  |
| `--domain-contains <text>` | Substring filter on the domain |  |
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
| `--to <date>` | Window end, YYYY-MM-DD (max window: 365 days) |  |
| `--models <list>` | Comma-separated model filter — see 'senso analytics filters' |  |
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
| `--from <date>` | Window start, YYYY-MM-DD |  |
| `--to <date>` | Window end, YYYY-MM-DD |  |
| `--models <list>` | Comma-separated model filter |  |
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
| `--models <list>` | Comma-separated model filter |  |
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

The models, locations, prompt types, tags and tracked competitors that actually have data for this org, plus the span of rollup days available — so you never guess a model spelling or query an empty window.

```
senso analytics filters [options]
```

## senso history-imports

Track the run-history import jobs started by `senso industries import-prompts`. A `completed` import may still have copied nothing — read `prompts_count` and `historic_runs_imported` rather than the status on its own.

```
senso history-imports [options] [command]
```

### senso history-imports list

List this organization's 50 most recently started history-import jobs, newest first.

```
senso history-imports list [options]
```

### senso history-imports get

Get one history-import job, as returned in `history_import.import_id` by `senso industries import-prompts`.

```
senso history-imports get [options] <importId>
```

## senso industries

Browse the public industry catalog and the competitive intelligence Senso collects for it — brand leaderboards, domain citations and the prompts each industry runs. Works with the organization key stored by `senso login`. The <industry> argument accepts a UUID or a name (e.g. "Airlines (Canada)"). Reads accept any industry in the catalog; only `import-prompts` is restricted to your own.

```
senso industries [options] [command]
```

### senso industries list

List the public industry catalog — the industries any organization can browse, with the prompt, model and location counts that show how much coverage each one has.

```
senso industries list [options]
```

| Option | Description | Default |
|---|---|---|
| `--search <q>` | Case-insensitive substring match against name or slug |  |
| `--limit <n>` | Page size, 1-100 (default 50) |  |
| `--offset <n>` | Number of industries to skip (default 0) |  |
| `--sort <order>` | Sort order: name_asc, name_desc, created_asc, created_desc (default name_asc) |  |
| `--live` | Only industries actively running — at least one model enabled and one active prompt |  |

### senso industries prompts

List the prompts an industry runs. These are the industry's own prompts, not your organization's (`senso prompts list`) — their ids are what `industries import-prompts` and `senso generate industry-draft` accept.

```
senso industries prompts [options] <industry>
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Page size, 1-100 (default 50) |  |
| `--offset <n>` | Number of prompts to skip (default 0) |  |

### senso industries brands

Brand leaderboard for an industry — who the AI answers named over the window, ranked by mentions, with average position, sentiment, most-cited domain and trends. Figures are counts, not rates: divide by the `totals` block to get shares. Ranks are global, so a later page still shows real ranks.

```
senso industries brands [options] <industry>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD (default: 30 days ago) |  |
| `--to <date>` | End of the window, YYYY-MM-DD (default: today) |  |
| `--models <list>` | Comma-separated model filter |  |
| `--location <code>` | 2-letter location code (e.g. US) |  |
| `--limit <n>` | Page size, 1-100 (default 100) |  |
| `--offset <n>` | Number of brands to skip (default 0) |  |
| `--no-canonicalize` | Do not merge spelling variants — raw per-spelling rows |  |
| `--rollup <mode>` | Set to `parent` to fold sub-brands into their parent company |  |
| `--entity-type <list>` | Comma-separated types to keep: brand, regulator, publisher, government, generic_term, product_model, forum_social |  |

### senso industries brand

Everything about one brand in an industry, merged across its spelling variants. Matching is fuzzy, so a brand that was never named comes back as `mentioned: false` rather than a 404. For repeat calls, take the `brand_id` from the result and use `brand-by-id`, which skips the fuzzy match.

```
senso industries brand [options] <industry> <brandName>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD (default: 30 days ago) |  |
| `--to <date>` | End of the window, YYYY-MM-DD (default: today) |  |
| `--models <list>` | Comma-separated model filter |  |
| `--location <code>` | 2-letter location code (e.g. US) |  |

### senso industries brand-by-id

Look up a brand in an industry by its stable `brand_id`, as returned by `industries brands` or `industries brand`. Same payload as `brand`, without the fuzzy name match.

```
senso industries brand-by-id [options] <industry> <brandId>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD (default: 30 days ago) |  |
| `--to <date>` | End of the window, YYYY-MM-DD (default: today) |  |
| `--models <list>` | Comma-separated model filter |  |
| `--location <code>` | 2-letter location code (e.g. US) |  |

### senso industries domain

How often a domain was cited in an industry's answers over the window. A domain that was never cited comes back as `cited: false` rather than a 404. Pass `--url` to look up a full URL instead; the <domain> argument is still required, because the API needs it in the path.

```
senso industries domain [options] <industry> <domain>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start of the window, YYYY-MM-DD (default: 30 days ago) |  |
| `--to <date>` | End of the window, YYYY-MM-DD (default: today) |  |
| `--models <list>` | Comma-separated model filter |  |
| `--location <code>` | 2-letter location code (e.g. US) |  |
| `--url <url>` | Look up this full URL instead of the bare domain |  |

### senso industries import-prompts

Copy prompts from your organization's own industry into your organization, and start importing the run history already collected for them so their analytics open with data rather than an empty chart. Only your own industry is accepted — any other is a 403. Prompts you already hold are skipped, so re-running is safe. This ACTIVATES the organization and starts its scheduled runs, including for prompts already saved but not yet running. Follow the returned history_import.import_id with `senso history-imports get`. Requires the GEO product.

```
senso industries import-prompts [options] <industry>
```

| Option | Description | Default |
|---|---|---|
| `--prompt-ids <ids>` | Comma-separated industry prompt ids, 1-100, no duplicates (from `senso industries prompts`) |  |

## senso partner

Partner-network commands. REQUIRES A PARTNER API KEY: every command here reads a /partner/* endpoint, which rejects the organization key stored by `senso login`. For the same industry data under your own key, use `senso industries`; for metrics about your own organization, use `senso analytics`.

```
senso partner [options] [command]
```

### senso partner industries

Industry-level competitive intelligence across a partner network — brand share-of-voice, domain citations, and per-prompt metrics. The <industry> argument accepts either a UUID or a name (e.g. "Automotive"). Requires a partner API key.

```
senso partner industries [options] [command]
```

### senso partner industries list

List industries visible to the partner. Use --search to filter by name.

```
senso partner industries list [options]
```

| Option | Description | Default |
|---|---|---|
| `--search <q>` | Filter industries by name |  |

### senso partner industries summary

One-call, slide-ready overview of an industry: brand counts, share-of-voice, and citation totals over a time window.

```
senso partner industries summary [options] <industry>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start date (YYYY-MM-DD) |  |
| `--to <date>` | End date (YYYY-MM-DD) |  |
| `--location <code>` | 2-letter location code (e.g. US) |  |
| `--models <list>` | Comma-separated model filter |  |

### senso partner industries brand

Everything about one brand within an industry, merged across surface-form spellings. Returns mentioned=false when the brand is never named.

```
senso partner industries brand [options] <industry> <brandName>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start date (YYYY-MM-DD) |  |
| `--to <date>` | End date (YYYY-MM-DD) |  |
| `--location <code>` | 2-letter location code (e.g. US) |  |
| `--models <list>` | Comma-separated model filter |  |

### senso partner industries domain

Direct domain/URL citation lookup within an industry. Returns cited=false when the domain is never cited.

```
senso partner industries domain [options] <industry> <domainOrUrl>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start date (YYYY-MM-DD) |  |
| `--to <date>` | End date (YYYY-MM-DD) |  |
| `--location <code>` | 2-letter location code (e.g. US) |  |
| `--models <list>` | Comma-separated model filter |  |

### senso partner industries prompt-metrics

Pure-industry per-prompt metrics (no single-org overlay) — how each tracked prompt performs across the industry.

```
senso partner industries prompt-metrics [options] <industry>
```

| Option | Description | Default |
|---|---|---|
| `--from <date>` | Start date (YYYY-MM-DD) |  |
| `--to <date>` | End date (YYYY-MM-DD) |  |
| `--location <code>` | 2-letter location code (e.g. US) |  |
| `--models <list>` | Comma-separated model filter |  |
| `--limit <n>` | Maximum prompts to return |  |
| `--offset <n>` | Number of prompts to skip (for pagination) |  |

### senso partner glossary

Canonical metric glossary — the citable definition of every competitive-intelligence metric returned by these endpoints.

```
senso partner glossary [options]
```

## senso update

Update CLI to the latest version

```
senso update [options]
```

