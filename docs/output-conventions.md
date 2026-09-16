# Output conventions

The consumer of this CLI is an AI agent, not a person. An agent sees stdout,
stderr and an exit code, and reads `--help` to learn a command. Anything the CLI
does not say, it invents. Every rule below exists to remove one thing an agent
would otherwise have to guess.

This is the contract. `docs/architecture.md` explains how the pieces fit;
this file is what a command must do.

## Streams

stdout carries the payload. Everything else is stderr. No exceptions. Only
`lib/output.ts`, `utils/logger.ts` and `utils/branding.ts` may touch a stream,
and `tests/policy/output-contract.test.ts` fails if that list grows.

## `--output json`: one envelope, every time

```json
{
  "ok": true,
  "command": "kb my-files",
  "data": { "nodes": [], "total": 120, "limit": 50, "offset": 0 },
  "page": {
    "offset": 0,
    "limit": 50,
    "returned": 50,
    "total": 120,
    "has_more": true,
    "next": "senso kb my-files --status complete --offset 50"
  },
  "next": [
    { "why": "Read one node, including its ingestion state", "command": "senso kb get <id>" }
  ],
  "warnings": ["2 files were skipped as duplicates"]
}
```

- `data` is the API payload, unmodified. Never rename its keys.
- `page`, `next` and `warnings` appear only when they apply.
- `page` is derived automatically when the payload carries `total`/`limit`/`offset`
  or `has_more`; `page.next` is rebuilt from the caller's own flags, so it is
  runnable as written.
- `next` is where guidance goes. Under `--output json` stderr is silent, so a
  hint written only to stderr reaches nobody — and every published Senso skill
  passes `--output json`.

A failure writes to stderr and leaves stdout empty:

```json
{
  "ok": false,
  "command": "kb get",
  "error": {
    "code": "not_found",
    "message": "KB node 3f2a… not found in organization acme.",
    "status": 404,
    "field": "<id>",
    "received": "3f2a…",
    "allowed": ["pending", "processing", "complete", "failed"],
    "hint": "List them with `senso kb my-files`.",
    "details": { "existing_content_id": "…" },
    "request": { "method": "GET", "path": "/org/kb/nodes/3f2a…" }
  }
}
```

`error.code` is stable and part of the public interface; messages may be
reworded. `field`, `received` and `allowed` are what let an agent fix its own
command line without parsing a sentence.

## Plain output

- **One object** — `key  value` lines, primary id first. Nested objects are
  indented sub-blocks and arrays of objects are numbered sub-blocks. Never an
  inline JSON string: `content.processing_status` is the point of `kb get`, and
  it used to be buried inside a stringified blob.
- **A list** — numbered blocks with the id on the first line, then
  `Showing 1–50 of 120.` and the next-page command on stderr.
- **An empty list** — `No documents found.` on stdout, and on stderr why it
  might be empty (a default filter, a hidden status) with the command that
  widens it. Pass `empty` and `emptyHint` to `emit`.
- **A mutation** — `✓ Deleted KB node <id>.` on stderr, the record on stdout,
  then the next command. Nothing is truncated in `plain`.
- **Async work** — every status transition on stderr, and the exact poll command
  whenever the CLI returns before the work is finished.

## Errors

- Name the resource and the id. Pass a `resource` to `apiRequest` and the 404
  writes itself: `{ type: "KB node", id, idField: "kb_node_id", list: "senso kb my-files" }`.
- Pass the API's own message through for 400, 409 and 422; the machine-readable
  remainder of the body lands in `error.details`.
- Exactly one `hint` per error, and it is a runnable command whenever one exists.
- 403 says which of the four things is missing: a permission, a product, a KB
  node grant, or a partner key. `lib/errors.ts` picks the branch.

## Validate before the request

A typo must cost exit 2, not a round trip and an opaque server error.

| What                            | Helper                                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| An id argument or flag          | `parseId`, `parseOptionalId`, `parseIdList` (`lib/id-arg.ts`)      |
| A closed set                    | `parseEnumFlag`, `requireEnumFlag`, `parseEnumList`                |
| An integer, with its real range | `parseIntFlag` — reject, never clamp                               |
| `YYYY-MM-DD` / RFC 3339         | `parseDateFlag`, `parseInstantFlag`, `assertRange`                 |
| A `--data` body                 | `parseJsonFlag(value, { required, optional, anyOf, rejectEmpty })` |

`parseJsonFlag` names unknown keys, because the API ignores them silently — a
typo'd field would otherwise look like a write that succeeded and changed
nothing. `rejectEmpty` is for the endpoints that read `{}` as "clear it all".

## Help text

Every leaf command carries the same sections, through `describeCommand` in
`lib/help.ts`:

```ts
describeCommand(
  kb
    .command("get <id>")
    .description("Read one knowledge base node …")
    .argument("<id>", "kb_node_id, from `senso kb my-files` …"),
  {
    returns: [
      "kb_node_id — the id every other kb command takes",
      "content.processing_status — pending | processing | complete | failed …",
    ],
    exitCodes: { ...idExits, 4: "no KB node with this id in your organization" },
    examples: [
      { comment: "Poll until ingestion finishes", command: "senso kb get <id> --output json" },
    ],
    seeAlso: ["senso kb my-files", "senso kb get-content <id>"],
  },
);
```

`returns` must enumerate every status or enum field's values. An agent that
reads `"processing_status": "pending"` and cannot see the set it belongs to has
no way to know whether to poll or to give up.

## The two id spaces

`kb_node_id` addresses the knowledge base tree; `content_id` addresses a stored
document. They are both UUIDs and they are not interchangeable — `/org/content/{id}`
rejects knowledge base content by design. Every command that takes an id says
which one it takes, and where it comes from.
