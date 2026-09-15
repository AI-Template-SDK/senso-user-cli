import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import {
  ApiError,
  apiRequest,
  handleUploadError,
  isBatchRejection,
  uploadStatusToReason,
  type UploadResponse,
  type UploadResultItem,
} from "../lib/api-client.js";
import { parseEnumFlag, parseIntFlag, requireEnumFlag } from "../lib/enum-arg.js";
import { CliError, EXIT, toCliError, usageError } from "../lib/errors.js";
import { assertFilesExist, assertFilesNotEmpty } from "../lib/file-args.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId, parseIdList, parseOptionalId, type IdSpec } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import {
  emit,
  emitConfirmation,
  type EmitOptions,
  type NextStep,
  type OutputContext,
} from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import { asText } from "../lib/text.js";
import * as log from "../utils/logger.js";

/** The roles a grant can confer. `owner` is reserved and rejected by the API. */
const GRANTABLE_ROLES = ["viewer", "editor"] as const;

/** What an access grant can be for. */
const GRANTEE_TYPES = ["user", "group"] as const;

/** The fields worth seeing when a KB endpoint returns `{ nodes: [...] }`. */
const NODE_COLUMNS = ["kb_node_id", "name", "type", "status"];

/** Node types a KB list endpoint can be narrowed to. */
const NODE_TYPES = ["folder", "content"] as const;

/** Ingestion states a document node can be in. Folders have none. */
const INGESTION_STATUSES = ["pending", "processing", "complete", "failed"] as const;

/** Roles a caller can hold on a node, for the `--role` filter. */
const NODE_ROLES = ["editor", "viewer"] as const;

/** Fields the KB list endpoints can sort by. */
const NODE_SORT_FIELDS = ["name", "updated_at", "created_at", "type", "status", "role"] as const;

const SORT_ORDERS = ["asc", "desc"] as const;

/**
 * The knowledge base tree's id space.
 *
 * Every `<id>` in this group is one of these, and the whole group's commonest
 * failure is being handed the other one — a content_id, which is what
 * `kb create-raw` returns as its top-level `id`. Passing this to `parseId`
 * rejects a malformed id before the request, and passing it to `apiRequest` as
 * the `resource` makes the 404 say which id space was wanted.
 */
const KB_NODE = { type: "KB node", idField: "kb_node_id", list: "senso kb my-files" } as const;

/** The tag library's id space: what `--ids`, `--id` and `--tag-ids` take. */
const TAG = { type: "Tag", idField: "id", list: "senso tags list" } as const;

function nodeSpec(label: string): IdSpec {
  return { label, ...KB_NODE };
}

function nodeResource(id: string) {
  return { ...KB_NODE, id };
}

/**
 * The ingestion states, spelled out wherever a payload carries one.
 *
 * An agent that reads `"processing_status": "pending"` and cannot see the set
 * it belongs to has no way to know whether to poll or to give up, so every
 * command whose payload includes this field repeats the whole set.
 */
const STATUS_RETURNS = [
  "content.processing_status — the ingestion state, one of:",
  "  pending     accepted; ingestion has not started. Poll `senso kb get <id>`.",
  "  processing  parsing, chunking and embedding are running. Keep polling.",
  "  complete    searchable — `senso search` will find it.",
  "  failed      ingestion failed; content.error_code says why. Fix the source and re-upload.",
];

/** What to do next about a document, given the state its ingestion is in. */
function pollSteps(nodeId: string | undefined, status: string | undefined): NextStep[] {
  if (nodeId === undefined) return [];
  if (status === "complete") {
    return [{ why: "The document is searchable", command: `senso search --query "<terms>"` }];
  }
  if (status === "failed") {
    return [
      { why: "Read the failure", command: `senso kb get-content ${nodeId}` },
      { why: "Replace the file", command: `senso kb update-file ${nodeId} <file>` },
    ];
  }
  return [
    {
      why: "Poll until content.processing_status is complete",
      command: `senso kb get ${nodeId}`,
    },
  ];
}

/**
 * Re-raise an API refusal with a hint the API itself cannot give.
 *
 * The 400s and 409s in this group name the problem accurately — "node is not a
 * folder", "still ingesting" — and never the command that answers it. The error
 * layer has only a status and a sentence to work from, so matching the API's own
 * wording here is the one place that knows both halves.
 */
function refine(err: unknown, rules: { match: RegExp; hint: string }[]): CliError {
  const mapped = toCliError(err);
  const rule = rules.find((r) => r.match.test(mapped.message));
  if (!rule) return mapped;
  return new CliError(mapped.message, mapped.exitCode, {
    code: mapped.code,
    status: mapped.status,
    field: mapped.field,
    received: mapped.received,
    details: mapped.details,
    request: mapped.request,
    hint: rule.hint,
    cause: err instanceof ApiError ? err : mapped.cause,
  });
}

/** A node, as much of it as the rendering below needs. */
interface KBNode {
  kb_node_id?: string;
  name?: string;
  type?: string;
  content?: { processing_status?: string; error_code?: string };
}

/**
 * Table columns for a node listing, and only for `table`.
 *
 * `plain` must keep the whole node: its `content` block renders as an indented
 * sub-block, which is where processing_status lives and why the default
 * rendering is worth having. A table cell is one line, so the status is
 * flattened into a column of its own — here, and nowhere else. Passing `rows`
 * instead would apply the flattening to `plain` too and throw away everything
 * else on the node.
 */
function nodeTable(ctx: OutputContext, data: unknown, key: "nodes" | "ancestors"): EmitOptions {
  if (ctx.format !== "table") return {};
  const nodes = (data as Record<string, KBNode[] | undefined>)[key] ?? [];
  return {
    table: {
      rows: nodes.map((n) => ({
        kb_node_id: n.kb_node_id,
        name: n.name,
        type: n.type,
        status: n.content?.processing_status ?? "",
      })),
      columns: NODE_COLUMNS,
    },
  };
}

/**
 * The filter, sort and paging flags every KB list endpoint accepts.
 *
 * `my-files`, `find` and `children` take one shared parameter set in the API,
 * and only three of its eight members were wired up. The missing ones were not
 * cosmetic: without `--status` there was no way to list the documents whose
 * ingestion failed, and without `--sort-by` no way to order a page at all.
 *
 * Registered from one place so the three commands cannot drift apart again.
 */
function addListOptions(cmd: Command, defaultLimit: string): Command {
  return cmd
    .option("--limit <n>", "Items per page, 1-50 (the API caps higher values at 50)", defaultLimit)
    .option("--offset <n>", "Pagination offset", "0")
    .option("--type <type>", `Only nodes of this type: ${NODE_TYPES.join(" | ")}`)
    .option(
      "--status <status>",
      `Only documents in this ingestion state: ${INGESTION_STATUSES.join(" | ")}. Ignored with --type folder`,
    )
    .option(
      "--role <role>",
      `Only nodes where the caller holds this role: ${NODE_ROLES.join(" | ")}. Ignored for org-admin keys, which already reach everything`,
    )
    .option("--sort-by <field>", `Sort by: ${NODE_SORT_FIELDS.join(" | ")}`)
    .option("--sort-order <dir>", `Sort direction: ${SORT_ORDERS.join(" | ")}`)
    .option(
      "--tag-ids <ids>",
      "Comma-separated tag UUIDs from `senso tags list`; only nodes carrying at least one of them",
    );
}

/** A comma-separated flag as a list, with blanks dropped. */
function csv(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Every id in a comma-separated tag flag, checked before the request.
 *
 * The API answers a malformed entry with a 400 that names neither the value nor
 * the flag, and it was the one list flag this group forwarded unchecked — so a
 * typo cost a round trip and exit 1 where every sibling flag exits 2.
 */
function parseTagIds(flag: string, value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = csv(value);
  if (ids.length === 0) {
    throw usageError(`${flag} is empty.`, {
      field: flag,
      received: value,
      hint: "Pass one or more tag UUIDs, comma separated. Tag ids are the `id` field of `senso tags list`.",
    });
  }
  return parseIdList(ids, { label: flag, ...TAG });
}

/**
 * Validates the shared list flags and maps them onto query parameters.
 *
 * The closed sets are checked here rather than at the API. `--status archived`
 * and `--sort-by whenever` are both 400s from the server, so catching them
 * locally exits 2 with the valid values named instead of spending a round trip
 * to be told the same thing less clearly.
 *
 * `--limit` is deliberately not range-checked at the top end: the API documents
 * values above 50 as capped rather than rejected, so forwarding 500 is correct
 * and yields a 50-item page. Only a non-integer or a value below 1 is a mistake
 * worth stopping for — and those the API silently reads as "50", which is the
 * failure mode this catches. A value over 50 is reported as a warning, because
 * the page that comes back is not the page that was asked for.
 */
function listParams(cmdOpts: Record<string, string>): Record<string, string | number | undefined> {
  return {
    limit: parseIntFlag("--limit", cmdOpts.limit, { min: 1 }),
    offset: parseIntFlag("--offset", cmdOpts.offset, { min: 0 }),
    type: parseEnumFlag("--type", cmdOpts.type, NODE_TYPES),
    status: parseEnumFlag("--status", cmdOpts.status, INGESTION_STATUSES),
    role: parseEnumFlag("--role", cmdOpts.role, NODE_ROLES),
    sort_by: parseEnumFlag("--sort-by", cmdOpts.sortBy, NODE_SORT_FIELDS),
    sort_order: parseEnumFlag("--sort-order", cmdOpts.sortOrder, SORT_ORDERS),
    tag_ids: parseTagIds("--tag-ids", cmdOpts.tagIds)?.join(","),
  };
}

/** The API caps a page at this, silently. Asking for more is worth saying. */
const MAX_PAGE = 50;

function listWarnings(cmdOpts: Record<string, string>): string[] {
  const limit = Number(cmdOpts.limit);
  return Number.isInteger(limit) && limit > MAX_PAGE
    ? [`--limit ${cmdOpts.limit} was capped at ${MAX_PAGE} by the API; page with --offset instead.`]
    : [];
}

/** The filters in force, for the hint under an empty list. */
function activeFilters(cmdOpts: Record<string, string>): string {
  const set = (["type", "status", "role", "tagIds"] as const).filter(
    (k) => cmdOpts[k] !== undefined,
  );
  return set.length === 0
    ? ""
    : ` Active filters: ${set.map((k) => (k === "tagIds" ? "--tag-ids" : `--${k}`)).join(", ")}; drop them to widen the search.`;
}

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".json": "application/json",
  ".xml": "application/xml",
};

/**
 * The content types the ingestion service accepts, mirrored from
 * `allowedContentTypes` in senso-api's internal/services/ingestion_service.go.
 *
 * The CLI's own extension table confidently produces two types that are not in
 * it — application/json and application/xml — and anything it cannot type at all
 * becomes application/octet-stream, which is also refused. Every one of those is
 * a guaranteed rejection, so it is a usage error before the bytes are hashed
 * rather than a per-file `invalid` after a round trip.
 */
const UPLOADABLE_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "text/plain",
  "text/html",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/tiff",
]);

const ACCEPTED_EXTENSIONS = ".pdf, .doc, .docx, .txt, .html, .csv, .xls, .xlsx, .ppt, .pptx, .png, .jpg, .gif, .bmp, .tiff";

function getMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function isMarkdown(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename.trim());
}

/**
 * Refuses, before any hashing or uploading, a file the API will certainly reject.
 *
 * Markdown is the case that matters: the ingestion service rejects it by
 * filename and answers with `markdown_requires_raw_ingestion`, whose text names
 * an HTTP endpoint rather than a command. An agent asked to "add these notes to
 * the KB" reaches for `kb upload notes.md` every time.
 */
function assertUploadable(files: readonly string[]): void {
  const markdown = files.filter((f) => isMarkdown(basename(f)));
  if (markdown.length > 0) {
    throw usageError(
      `Markdown is not accepted here: ${markdown.map((f) => basename(f)).join(", ")}.`,
      {
        field: "<files...>",
        received: markdown.join(", "),
        hint: `Ingest markdown as a text document instead: senso kb create-raw --data '{"title":"...","text":"..."}'`,
      },
    );
  }

  const unsupported = files.filter((f) => !UPLOADABLE_TYPES.has(getMimeType(basename(f))));
  if (unsupported.length > 0) {
    throw usageError(
      `Unsupported file type: ${unsupported.map((f) => `${basename(f)} (${getMimeType(basename(f))})`).join(", ")}.`,
      {
        field: "<files...>",
        received: unsupported.join(", "),
        hint: `The knowledge base accepts ${ACCEPTED_EXTENSIONS}. Text that is not one of these goes in with senso kb create-raw.`,
      },
    );
  }
}

async function getFileMetadata(filePath: string) {
  const absPath = resolve(filePath);
  const buffer = await readFile(absPath);
  const stats = await stat(absPath);
  const hash = createHash("md5").update(buffer).digest("hex");
  return {
    meta: {
      filename: basename(absPath),
      file_size_bytes: stats.size,
      content_type: getMimeType(basename(absPath)),
      content_hash_md5: hash,
    },
    buffer,
  };
}

async function uploadToS3(url: string, buffer: Buffer, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(buffer),
  });
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status} ${res.statusText}`);
}

/**
 * Why one file in a batch was not stored.
 *
 * `uploadStatusToReason` in lib/api-client.ts knows the four statuses the
 * shared upload contract declares. The API returns a fifth that it does not,
 * and whose own text names an endpoint rather than a command, so it is
 * translated here instead of being shown raw.
 */
function skipReason(status: string, error?: string): string {
  if (status === "markdown_requires_raw_ingestion") {
    return "Markdown is ingested as a text document. Use `senso kb create-raw`.";
  }
  return uploadStatusToReason(status, error);
}

export function registerKBCommands(program: Command): void {
  const kb = program
    .command("kb")
    .description(
      "The organization's knowledge base: a tree of folders and documents that Senso search and generation read from. Every command here takes a kb_node_id unless it says otherwise; the content_id that appears in payloads addresses the stored document and is what `senso content` takes. Documents are ingested asynchronously — a node exists before its content is searchable, so poll `kb get <id>` until content.processing_status is complete. Workflow: my-files → upload or create-raw → get (poll) → tags set → senso search.",
    );

  describeCommand(
    kb
      .command("root")
      .description("Get the organization's root folder node.")
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest<{ kb_node_id?: string }>({
            path: "/org/kb/root",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, {
            next:
              data.kb_node_id === undefined
                ? []
                : [
                    {
                      why: "List the top level",
                      command: `senso kb children ${data.kb_node_id}`,
                    },
                  ],
          });
        }),
      ),
    {
      returns: [
        "kb_node_id — the top of the tree. Pass it to `senso kb children`, or as --parent-id / --folder-id to create at the top level.",
        'type — always "folder".',
        "parent_id — always null; this is the top of the tree.",
        "name — the organization's display name for the root.",
      ],
      exitCodes: {
        ...apiExits,
        1: "the API refused, including a 500 when the organization has no root node",
      },
      notes: [
        "Unlike `kb my-files`, this read is not filtered by your KB grants — every caller in the organization sees the root.",
        "The root cannot be renamed, moved or deleted, and `kb stats` does not count it as a folder.",
      ],
      examples: [
        { command: "senso kb root" },
        {
          comment: "The id every top-level create takes",
          command: "senso kb root --output json | jq -r .data.kb_node_id",
        },
      ],
      seeAlso: ["senso kb my-files", "senso kb children", "senso kb stats"],
    },
  );

  describeCommand(
    kb
      .command("stats")
      .description("Count the documents and folders in the knowledge base.")
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest({
            path: "/org/kb/stats",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data);
        }),
      ),
    {
      returns: [
        "total_files — documents in the whole tree, in EVERY ingestion state: a knowledge base whose documents all failed still reports a healthy total.",
        "total_folders — folders in the whole tree, excluding the root.",
      ],
      exitCodes: apiExits,
      notes: [
        "Both counts are organization-wide and are NOT filtered by your KB grants, while `kb my-files` is — so these totals can exceed what you can list.",
      ],
      examples: [
        { command: "senso kb stats" },
        {
          comment: "Find the documents these totals are hiding",
          command: "senso kb my-files --status failed",
        },
      ],
      seeAlso: ["senso kb my-files", "senso kb find"],
    },
  );

  describeCommand(
    addListOptions(
      kb
        .command("my-files")
        .description("List the top level of the knowledge base — files and folders under the root."),
      "50",
    ).action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest<{ nodes?: KBNode[] }>({
          path: "/org/kb/my-files",
          params: listParams(cmdOpts),
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        const first = (data.nodes ?? [])[0];
        emit(ctx, data, {
          ...nodeTable(ctx, data, "nodes"),
          empty: "files",
          emptyHint: `The knowledge base may be empty, or your key may hold no grant on what is in it.${activeFilters(cmdOpts)} Add a document with: senso kb upload <file>`,
          warnings: listWarnings(cmdOpts),
          next:
            first?.kb_node_id === undefined
              ? []
              : [
                  { why: "Read one node in full", command: `senso kb get ${first.kb_node_id}` },
                  {
                    why: "Descend into a folder",
                    command: `senso kb children ${first.kb_node_id}`,
                  },
                ],
        });
      }),
    ),
    {
      returns: [
        "nodes[].kb_node_id — the id every other kb command takes.",
        "nodes[].type — folder or content.",
        "nodes[].content_id — present on content nodes. The OTHER id space: `senso content` takes it, no kb command does.",
        ...STATUS_RETURNS,
        "nodes[].effective_role — editor | viewer | owner: what your key may do with this node.",
        "total / limit / offset — the page window; page with --offset.",
      ],
      exitCodes: {
        ...apiExits,
        2: "a filter value is not one of the allowed values, or --tag-ids is not a list of UUIDs",
      },
      notes: [
        "Top level only. Use `senso kb children <id>` to descend, and `senso kb find` to search the whole tree by name.",
        "Results are filtered to what your key can see; `kb stats` is not, so its totals can be larger.",
      ],
      examples: [
        { command: "senso kb my-files" },
        {
          comment: "The documents whose ingestion failed",
          command: "senso kb my-files --status failed --output json | jq -r '.data.nodes[].name'",
        },
        { comment: "Folders only", command: "senso kb my-files --type folder" },
      ],
      seeAlso: ["senso kb children", "senso kb find", "senso kb get", "senso kb stats"],
    },
  );

  describeCommand(
    addListOptions(
      kb
        .command("find")
        .description("Search the knowledge base for nodes whose NAME matches a query.")
        .requiredOption("--query <q>", "Substring to match against node names"),
      "20",
    ).action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const query = (cmdOpts.query ?? "").trim();
        if (query === "") {
          // The API answers an empty `q` with an unfiltered page and exit 0,
          // which reads as "no such document" when it means "no query".
          throw usageError("--query is empty.", {
            field: "--query",
            received: cmdOpts.query,
            hint: "Pass the text to match against node names, e.g. --query refund.",
          });
        }
        const data = await apiRequest<{ nodes?: KBNode[] }>({
          path: "/org/kb/find",
          params: { q: query, ...listParams(cmdOpts) },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        const first = (data.nodes ?? [])[0];
        emit(ctx, data, {
          ...nodeTable(ctx, data, "nodes"),
          empty: `nodes matching "${query}"`,
          emptyHint: `This matches node NAMES only.${activeFilters(cmdOpts)} To search inside documents: senso search --query "${query}"`,
          warnings: listWarnings(cmdOpts),
          next:
            first?.kb_node_id === undefined
              ? []
              : [{ why: "Read one match in full", command: `senso kb get ${first.kb_node_id}` }],
        });
      }),
    ),
    {
      returns: [
        "nodes[].kb_node_id — the id every other kb command takes.",
        "nodes[].type — folder or content; this searches both.",
        ...STATUS_RETURNS,
        "total / limit / offset — the page window.",
      ],
      exitCodes: {
        ...apiExits,
        2: "--query is empty, a filter value is not allowed, or --tag-ids is not a list of UUIDs",
      },
      notes: [
        "This searches NAMES, not document text. `senso search` is the command that searches what is inside a document.",
        "Searches the whole tree, not just the top level, and returns folders as well as documents.",
        "--limit defaults to 20 here, and to 50 on `kb my-files` and `kb children`.",
      ],
      examples: [
        { command: "senso kb find --query refund" },
        {
          comment: "Ids of every complete document matching a name",
          command:
            "senso kb find --query policy --type content --status complete --output json | jq -r '.data.nodes[].kb_node_id'",
        },
      ],
      seeAlso: ["senso search", "senso kb my-files", "senso kb children"],
    },
  );

  describeCommand(
    kb
      .command("sync-status")
      .description("Report whether queued move and delete operations are still propagating.")
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest<{ syncing?: boolean }>({
            path: "/org/kb/sync-status",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, {
            warnings:
              data.syncing === true
                ? [
                    "A recent move or delete is still propagating to the vector index. Search results may be stale; re-run in a few seconds.",
                  ]
                : [],
          });
        }),
      ),
    {
      returns: [
        "syncing — true | false:",
        "  true   a recent move or delete has not finished propagating. Search may still reference the old tree; retry in a few seconds.",
        "  false  nothing outstanding — the tree and the vector index agree.",
      ],
      exitCodes: apiExits,
      notes: [
        "This is NOT an ingestion signal. To check whether a document you just added is queryable, run `senso kb get <id>` and read content.processing_status.",
      ],
      examples: [
        { command: "senso kb sync-status" },
        {
          comment: "Wait for the index to settle before searching",
          command:
            'until [ "$(senso kb sync-status --output json | jq -r .data.syncing)" = false ]; do sleep 2; done',
        },
      ],
      seeAlso: ["senso kb get", "senso kb move", "senso kb delete"],
    },
  );

  describeCommand(
    kb
      .command("get")
      .description("Read one knowledge base node, with its ingestion state and tags.")
      .argument(
        "<id>",
        "kb_node_id, from `senso kb my-files`, `kb children`, `kb find`, `kb root`, or an upload result. NOT a content_id, and not the top-level `id` of `kb create-raw`",
      )
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const data = await apiRequest<KBNode>({
            path: `/org/kb/nodes/${id}`,
            resource: nodeResource(id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, {
            next:
              data.type === "folder"
                ? [{ why: "List what is inside", command: `senso kb children ${id}` }]
                : pollSteps(id, data.content?.processing_status),
          });
        }),
      ),
    {
      returns: [
        "kb_node_id — the id every other kb command takes.",
        "type — folder or content.",
        "content_id — the stored document behind a content node. `senso content` takes it; no kb command does.",
        ...STATUS_RETURNS,
        "content.error_code — set only when processing_status is failed.",
        "content.version_num — the current stored version; pass it to `kb get-content --rev`.",
        "effective_role — owner | editor | viewer: what your key may do here. A viewer cannot rename, move, delete or re-upload.",
        "tags[] — the tags on this node, each with its own `id` and name.",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID",
        4: "no node with this id, or your key cannot see it — the API does not distinguish the two",
      },
      examples: [
        { command: "senso kb get 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39" },
        {
          comment: "Poll until ingestion finishes",
          command:
            "senso kb get 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --output json | jq -r .data.content.processing_status",
        },
      ],
      seeAlso: ["senso kb get-content", "senso kb children", "senso kb ancestors", "senso kb tags list"],
    },
  );

  describeCommand(
    addListOptions(
      kb
        .command("children")
        .description("List the direct children of a folder — one level deep.")
        .argument("<id>", "kb_node_id of a FOLDER, from `senso kb root`, `kb my-files` or `kb find`"),
      "50",
    ).action(
      runAction(program, async (ctx, rawId: string, cmdOpts: Record<string, string>) => {
        const id = parseId(rawId, nodeSpec("<id>"));
        let data: { nodes?: KBNode[] };
        try {
          data = await apiRequest<{ nodes?: KBNode[] }>({
            path: `/org/kb/nodes/${id}/children`,
            params: listParams(cmdOpts),
            resource: nodeResource(id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
        } catch (err) {
          throw refine(err, [
            {
              match: /not a folder/i,
              hint: `This id is a document, not a folder. Read it with: senso kb get-content ${id}`,
            },
          ]);
        }
        const first = (data.nodes ?? [])[0];
        emit(ctx, data, {
          ...nodeTable(ctx, data, "nodes"),
          empty: "children",
          emptyHint: `The folder is empty, or your key holds no grant on what is in it.${activeFilters(cmdOpts)} Add a document with: senso kb upload <file> --folder-id ${id}`,
          warnings: listWarnings(cmdOpts),
          next:
            first?.kb_node_id === undefined
              ? []
              : [{ why: "Read one child in full", command: `senso kb get ${first.kb_node_id}` }],
        });
      }),
    ),
    {
      returns: [
        "nodes[].kb_node_id — pass a folder child back to this command to descend.",
        "nodes[].type — folder or content.",
        ...STATUS_RETURNS,
        "total / limit / offset — the page window.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused, including 400 when <id> is a document rather than a folder",
        2: "<id> is not a UUID, or a filter value is not allowed",
        4: "no node with this id, or your key cannot see it",
      },
      notes: [
        "One level deep. There is no recursive walk here — call this again with each folder child's kb_node_id.",
        "Passing a document's id is a 400, not an empty list.",
      ],
      examples: [
        { command: "senso kb children 8c1d4e6a-7b30-4f52-9a11-2d5c6e8f0a44" },
        {
          comment: "Subfolders only",
          command:
            "senso kb children 8c1d4e6a-7b30-4f52-9a11-2d5c6e8f0a44 --type folder --output json | jq -r '.data.nodes[].kb_node_id'",
        },
      ],
      seeAlso: ["senso kb root", "senso kb my-files", "senso kb ancestors", "senso kb find"],
    },
  );

  describeCommand(
    kb
      .command("ancestors")
      .description("Get the breadcrumb path to a node, ordered root first.")
      .argument("<id>", "kb_node_id of any node, folder or document")
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const data = await apiRequest<{ ancestors?: KBNode[] }>({
            path: `/org/kb/nodes/${id}/ancestors`,
            resource: nodeResource(id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          // The breadcrumb reads root-first, so the row order is the path
          // itself — which is invisible in a list of blocks, hence the path
          // line. Diagnostics, so stderr: the payload is the rows.
          const path = (data.ancestors ?? []).map((n) => n.name ?? "?").join(" / ");
          if (!ctx.quiet && path !== "") log.info(`Path: ${path}`);
          emit(ctx, data, {
            ...nodeTable(ctx, data, "ancestors"),
            empty: "ancestors",
            emptyHint: "This node sits directly under the organization root.",
          });
        }),
      ),
    {
      returns: [
        "ancestors[] — root first, nearest parent last. Each entry is a folder node with kb_node_id, name and type.",
        "These entries carry no content block and no effective_role, unlike `kb get`.",
        "An empty list means the node sits directly under the organization root.",
      ],
      exitCodes: { ...idExits, 2: "<id> is not a UUID", 4: "no node with this id, or your key cannot see it" },
      examples: [
        { command: "senso kb ancestors 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39" },
        {
          comment: "The path as one line",
          command:
            "senso kb ancestors 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --output json | jq -r '.data.ancestors[].name' | paste -sd/",
        },
      ],
      seeAlso: ["senso kb children", "senso kb get", "senso kb move"],
    },
  );

  describeCommand(
    kb
      .command("get-content")
      .description("Read the stored document behind a content node, including its text.")
      .argument("<id>", "kb_node_id of a CONTENT node — not a folder, and not a content_id")
      // `--rev`, not the obvious `--version`: the root command owns `-v,
      // --version` for the CLI's own version and Commander answers it wherever it
      // appears, so a `--version` here was intercepted before the action ever ran.
      // The API query parameter is still `version`; only the flag is renamed.
      .option(
        "--rev <n>",
        "Read a specific stored version, by version number (an integer >= 1). The current one is content.version_num from `senso kb get`",
      )
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: { rev?: string }) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const rev = parseIntFlag("--rev", cmdOpts.rev, { min: 1 });
          let data: { text?: string; processing_status?: string };
          try {
            data = await apiRequest<{ text?: string; processing_status?: string }>({
              path: `/org/kb/nodes/${id}/content`,
              params: { version: rev },
              resource: nodeResource(id),
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            throw refine(err, [
              {
                match: /no associated content/i,
                hint: `This id is a folder. List what is inside it with: senso kb children ${id}`,
              },
            ]);
          }
          emit(ctx, data, {
            next:
              data.text === undefined || data.text === ""
                ? [
                    {
                      why: "This document has no stored text — fetch the file instead",
                      command: `senso kb download-url ${id}`,
                    },
                  ]
                : [],
          });
        }),
      ),
    {
      returns: [
        "id — the content_id. This is the OTHER id space: `senso content` takes it, no kb command does. Keep using the kb_node_id you passed in.",
        "text — the full document text. Present for raw, markdown and web content; EMPTY for uploaded binaries (PDF, DOCX, XLSX, images) — use `senso kb download-url` for those.",
        "processing_status — pending | processing | complete | failed. Only complete documents are searchable.",
        "editorial_status — the document's review state, which is unrelated to ingestion.",
        "error_code — set only when processing_status is failed.",
        "version_num — the version this payload is; pass it back as --rev.",
        "content_type — the MIME type of the stored document.",
        "org_tags[] — the tags on this content, from the organization's tag library.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused, including 400 when <id> is a folder",
        2: "<id> is not a UUID, or --rev is not an integer >= 1",
        4: "no node with this id, your key cannot see it, or --rev names a version that does not exist",
      },
      examples: [
        { command: "senso kb get-content 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39" },
        {
          comment: "Just the text",
          command:
            "senso kb get-content 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --output json | jq -r .data.text",
        },
        {
          comment: "An earlier version",
          command: "senso kb get-content 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --rev 2",
        },
      ],
      seeAlso: ["senso kb get", "senso kb download-url", "senso kb update-raw", "senso kb patch-raw"],
    },
  );

  describeCommand(
    kb
      .command("download-url")
      .description("Get a presigned S3 URL for the file stored behind a node.")
      .argument("<id>", "kb_node_id of an uploaded file node — not a content_id")
      // `--rev` for the same reason as `kb get-content` above: the root's `-v,
      // --version` shadows a `--version` on any subcommand. The wire parameter is
      // unchanged.
      .option(
        "--rev <n>",
        "Download a specific stored version, by version number (an integer >= 1)",
      )
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: { rev?: string }) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const rev = parseIntFlag("--rev", cmdOpts.rev, { min: 1 });
          try {
            const data = await apiRequest({
              path: `/org/kb/nodes/${id}/download-url`,
              params: { version: rev },
              resource: nodeResource(id),
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
            emit(ctx, data);
          } catch (err) {
            throw refine(err, [
              {
                match: /not a downloadable file/i,
                hint: `This is a text document with no stored file. Read it with: senso kb get-content ${id}`,
              },
              {
                match: /no associated content/i,
                hint: `This id is a folder. List what is inside it with: senso kb children ${id}`,
              },
            ]);
          }
        }),
      ),
    {
      returns: [
        "url — opens inline: a browser renders the PDF or image rather than saving it.",
        "download_url — the same object signed with Content-Disposition: attachment, so any client saves it. Use this one in a script.",
        "filename — the stored filename.",
        "content_type — the MIME type.",
        "file_size_bytes — the size of the stored object.",
        "expiry_utc_ms — when both URLs stop working, in epoch milliseconds. The API signs for one hour; do not cache them beyond that.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused, including 400 when the node is a folder or a text document",
        2: "<id> is not a UUID, or --rev is not an integer >= 1",
        4: "no node with this id, your key cannot see it, or --rev names a version that does not exist",
      },
      notes: [
        "The URL carries its own authorization. Fetch it with plain curl — do not send your Senso API key with it.",
        "This works only for nodes created by `kb upload` or `kb update-file`. A raw text document has no stored file.",
      ],
      examples: [
        { command: "senso kb download-url 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39" },
        {
          comment: "Save the file",
          command:
            'curl -sSL "$(senso kb download-url 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --output json | jq -r .data.download_url)" -o document.pdf',
        },
      ],
      seeAlso: ["senso kb get-content", "senso kb get", "senso kb update-file"],
    },
  );

  describeCommand(
    kb
      .command("create-folder")
      .description("Create a folder in the knowledge base.")
      .requiredOption("--name <name>", "Folder name, 1-255 characters")
      .option(
        "--parent-id <id>",
        "kb_node_id of the folder to create it in; omit to create under the organization root",
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { name: string; parentId?: string }) => {
          const name = cmdOpts.name.trim();
          if (name === "") {
            throw usageError("--name is blank.", {
              field: "--name",
              received: cmdOpts.name,
              hint: "Folder names are 1-255 characters and are trimmed.",
            });
          }
          const parentId = parseOptionalId(cmdOpts.parentId, {
            label: "--parent-id",
            type: "Parent folder",
            idField: "parent_id",
            list: "senso kb find --type folder",
          });
          const body: Record<string, unknown> = { name };
          if (parentId !== undefined) body.parent_id = parentId;
          const data = await apiRequest<{ kb_node_id?: string }>({
            method: "POST",
            path: "/org/kb/folders",
            body,
            resource:
              parentId === undefined
                ? undefined
                : {
                    type: "Parent folder",
                    id: parentId,
                    idField: "parent_id",
                    list: "senso kb find --type folder",
                  },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`Folder "${name}" created.`);
          emit(ctx, data, {
            next:
              data.kb_node_id === undefined
                ? []
                : [
                    {
                      why: "Put a document in it",
                      command: `senso kb upload <file> --folder-id ${data.kb_node_id}`,
                    },
                  ],
          });
        }),
      ),
    {
      returns: [
        "kb_node_id — the new folder. The same id is --parent-id here, --folder-id on `kb upload`, and kb_folder_node_id inside `kb create-raw --data`.",
        'type — always "folder".',
        "parent_id — where it was created; null means the organization root.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused, including 400 when --parent-id is not a folder",
        2: "--name is blank, or --parent-id is not a UUID",
        3: "you can see the parent folder but may not create in it",
        4: "the parent folder does not exist, or your key has no access to it",
      },
      notes: [
        "Folder names are NOT unique and this call is NOT idempotent: running it twice makes two folders with the same name. Check with `senso kb find --query <name> --type folder` before retrying.",
      ],
      examples: [
        { command: "senso kb create-folder --name Policies" },
        {
          command:
            "senso kb create-folder --name Refunds --parent-id b204e7f1-5c6a-4d38-a9e2-71f0c3b85d6a",
        },
        {
          comment: "Capture the id for an upload",
          command: "senso kb create-folder --name Refunds --output json | jq -r .data.kb_node_id",
        },
      ],
      seeAlso: ["senso kb root", "senso kb children", "senso kb upload", "senso kb move"],
    },
  );

  describeCommand(
    kb
      .command("rename")
      .description("Rename a node in the tree. The document's stored title is unchanged.")
      .argument("<id>", "kb_node_id of the node to rename")
      .requiredOption("--name <name>", "The new name, 1-255 characters")
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: { name: string }) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const name = cmdOpts.name.trim();
          if (name === "") {
            throw usageError("--name is blank.", {
              field: "--name",
              received: cmdOpts.name,
              hint: "Node names are 1-255 characters and are trimmed.",
            });
          }
          const data = await apiRequest({
            method: "PATCH",
            path: `/org/kb/nodes/${id}/rename`,
            body: { name },
            resource: nodeResource(id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`Node ${id} renamed to "${name}".`);
          emit(ctx, data, {
            next: [{ why: "Re-read the node, with its ingestion state", command: `senso kb get ${id}` }],
          });
        }),
      ),
    {
      returns: [
        "kb_node_id, name, type, parent_id and tags — the renamed node.",
        "This payload has NO content block, unlike `kb get`: re-read with `senso kb get <id>` if you need processing_status.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused, including 400 when <id> is the organization root",
        2: "<id> is not a UUID, or --name is blank",
        3: "you can see the node but hold only viewer on it",
        4: "no node with this id, or your key cannot see it",
      },
      notes: [
        'This changes the TREE LABEL only. A document\'s stored title — what search shows — is unchanged; change that with `senso kb patch-raw <id> --data \'{"title":"..."}\'`.',
        "Names are not unique: renaming to a name a sibling already has succeeds. The organization root cannot be renamed.",
      ],
      examples: [
        {
          command:
            'senso kb rename 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --name "Refund Policy 2025.pdf"',
        },
      ],
      seeAlso: ["senso kb patch-raw", "senso kb move", "senso kb get"],
    },
  );

  describeCommand(
    kb
      .command("move")
      .description("Move a node to a different folder. A folder moves with its whole subtree.")
      .argument("<id>", "kb_node_id of the node to move")
      .requiredOption("--parent-id <parentId>", "kb_node_id of the DESTINATION folder")
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: { parentId: string }) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const parentId = parseId(cmdOpts.parentId, {
            label: "--parent-id",
            type: "Destination folder",
            idField: "new_parent_id",
            list: "senso kb find --type folder",
          });
          if (parentId === id) {
            throw usageError("--parent-id is the node being moved.", {
              field: "--parent-id",
              received: cmdOpts.parentId,
              hint: "Pass the kb_node_id of the folder to move it INTO.",
            });
          }
          const data = await apiRequest({
            method: "PATCH",
            path: `/org/kb/nodes/${id}/move`,
            body: { new_parent_id: parentId },
            // One 404 covers both ids by design — the API will not say which —
            // so the error names both rather than implying it knows.
            resource: {
              type: "KB node or destination folder",
              id: `${id} / ${parentId}`,
              idField: "kb_node_id",
              list: "senso kb my-files",
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`Node ${id} moved.`);
          emit(ctx, data, {
            next: [
              { why: "Check the new path", command: `senso kb ancestors ${id}` },
              {
                why: "Reindexing is asynchronous — wait for syncing to be false before searching",
                command: "senso kb sync-status",
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "kb_node_id, name, type, parent_id (the new parent) and tags.",
        "No content block — re-read with `senso kb get <id>` if you need processing_status.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 400 cannot move the root, invalid parent folder, or a folder into its own subtree",
        2: "an id is not a UUID, or --parent-id equals <id>",
        3: "you can see the node but hold only viewer on it",
        4: "the node OR the destination does not exist, or your key cannot see one of them — the API does not say which",
      },
      notes: [
        "A folder moves with its ENTIRE subtree.",
        "Search reindexing happens after this returns. Run `senso kb sync-status` and wait for syncing=false before relying on search results.",
        "--parent-id here is the DESTINATION; on `kb create-folder` the same flag names the folder to create IN.",
      ],
      examples: [
        {
          command:
            "senso kb move 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --parent-id b204e7f1-5c6a-4d38-a9e2-71f0c3b85d6a",
        },
        {
          comment: "Move back to the top level",
          command:
            "senso kb move 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --parent-id $(senso kb root --output json | jq -r .data.kb_node_id)",
        },
      ],
      seeAlso: ["senso kb ancestors", "senso kb sync-status", "senso kb create-folder", "senso kb rename"],
    },
  );

  describeCommand(
    kb
      .command("delete")
      .description("Delete one node. A FOLDER IS DELETED WITH ITS ENTIRE SUBTREE.")
      .argument("<id>", "kb_node_id of the node to delete")
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          try {
            await apiRequest({
              method: "DELETE",
              path: `/org/kb/nodes/${id}`,
              resource: nodeResource(id),
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            throw refine(err, [
              {
                match: /ingest/i,
                hint: `Ingestion is still running on this document. Poll it with: senso kb get ${id}`,
              },
            ]);
          }
          emitConfirmation(ctx, `Node ${id} deleted.`, {
            action: "deleted",
            resource: "kb_node",
            id,
          });
        }),
      ),
    {
      returns: [
        "Nothing: the API answers 204. Under --output json the CLI reports",
        '{"action": "deleted", "resource": "kb_node", "id": "<id>"}.',
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 400 cannot delete the root, or 409 the document is still ingesting",
        2: "<id> is not a UUID",
        3: "you can see the node but may not delete it",
        4: "no node with this id, or your key cannot see it",
      },
      notes: [
        "A folder takes its whole subtree with it — every folder and document inside. This cannot be undone.",
        "A document that is still ingesting cannot be deleted; the call is refused until processing_status leaves pending/processing.",
        "The organization root cannot be deleted.",
      ],
      examples: [
        {
          comment: "See what would go first",
          command: "senso kb children 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39",
        },
        { command: "senso kb delete 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39" },
      ],
      seeAlso: ["senso kb bulk-delete", "senso kb children", "senso kb get"],
    },
  );

  describeCommand(
    kb
      .command("bulk-delete")
      .description("Delete up to 100 nodes in one all-or-nothing call.")
      .argument("<nodeIds...>", "1 to 100 kb_node_ids, space separated")
      .action(
        runAction(program, async (ctx, rawIds: string[]) => {
          // The API caps the batch at 100 and rejects the whole request past it.
          // Saying so here costs nothing and names the number the caller passed.
          if (rawIds.length > 100) {
            throw new CliError("Maximum 100 nodes per bulk delete.", EXIT.USAGE, {
              code: "usage",
              hint: `You passed ${String(rawIds.length)}. Split them across several calls.`,
            });
          }
          const ids = parseIdList(rawIds, nodeSpec("<nodeIds...>"));
          // De-duplicated so the reported count is the count that was deleted:
          // "Deleted 100 node(s)" over a list with repeats was simply wrong.
          const unique = [...new Set(ids)];
          const duplicates = ids.length - unique.length;
          try {
            await apiRequest({
              method: "POST",
              path: "/org/kb/nodes/bulk-delete",
              body: { node_ids: unique },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            throw refine(err, [
              {
                match: /not found/i,
                hint: "The API does not say which id. Re-run them one at a time, or check with: senso kb get <id>",
              },
              {
                match: /ingest/i,
                hint: "One document in this selection is still ingesting. The API does not say which; check with: senso kb get <id>",
              },
            ]);
          }
          emitConfirmation(
            ctx,
            `Deleted ${String(unique.length)} node(s).`,
            { action: "deleted", resource: "kb_node", id: unique },
            {
              warnings:
                duplicates > 0
                  ? [`${String(duplicates)} duplicate id(s) were dropped before the request.`]
                  : [],
            },
          );
        }),
      ),
    {
      returns: [
        "Nothing: the API answers 204. Under --output json the CLI reports",
        '{"action": "deleted", "resource": "kb_node", "id": [...]} — the ids it actually sent.',
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 400 one of them is the organization root, or 409 one of them is still ingesting",
        2: "more than 100 ids, or an id is not a UUID",
        3: "you can see them all but may not delete one or more",
        4: "one or more ids do not exist, or are not visible to your key",
      },
      notes: [
        "A folder is deleted with its ENTIRE subtree. This cannot be undone.",
        "All-or-nothing: if any node is missing, not permitted, the root, or still ingesting, NOTHING is deleted — and the API does not say which node caused it, so re-run the ids one at a time to find it.",
        "Duplicate ids are dropped locally and reported as a warning.",
      ],
      examples: [
        {
          command:
            "senso kb bulk-delete 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 b204e7f1-5c6a-4d38-a9e2-71f0c3b85d6a",
        },
        {
          comment: "Every draft, up to the cap",
          command:
            "senso kb find --query draft --type content --output json | jq -r '.data.nodes[].kb_node_id' | head -100 | xargs senso kb bulk-delete",
        },
      ],
      seeAlso: ["senso kb delete", "senso kb find", "senso kb children"],
    },
  );

  describeCommand(
    kb
      .command("create-raw")
      .description("Create a text or markdown document in the knowledge base.")
      .requiredOption(
        "--data <json>",
        'JSON: { "text": "# Hello", "title": "My doc", "summary": "...", "kb_folder_node_id": "<uuid>" }. Only "text" is required; "tag_ids" is accepted and ignored by the API',
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string }) => {
          const body = parseJsonFlag<{
            text?: unknown;
            title?: unknown;
            kb_folder_node_id?: unknown;
            tag_ids?: unknown;
          }>(cmdOpts.data, {
            required: ["text"],
            optional: ["title", "summary", "kb_folder_node_id", "tag_ids"],
          });
          if (typeof body.text !== "string" || body.text.trim() === "") {
            throw usageError("--data has an empty `text`.", {
              field: "--data",
              received: cmdOpts.data,
              hint: "`text` is the document body and must be a non-empty string.",
            });
          }
          if (body.kb_folder_node_id !== undefined) {
            parseId(asText(body.kb_folder_node_id), {
              label: "--data kb_folder_node_id",
              type: "Folder",
              idField: "kb_folder_node_id",
              list: "senso kb find --type folder",
            });
          }
          const data = await apiRequest<{ id?: string; kb_node_id?: string }>({
            method: "POST",
            path: "/org/kb/raw",
            body,
            resource:
              body.kb_folder_node_id === undefined
                ? undefined
                : {
                    type: "Folder",
                    id: asText(body.kb_folder_node_id),
                    idField: "kb_folder_node_id",
                    list: "senso kb find --type folder",
                  },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          }).catch((err: unknown) => {
            throw refine(err, [
              {
                match: /duplicate content/i,
                hint: "A document with byte-identical text already exists. Find it with: senso kb find --query <title>",
              },
            ]);
          });
          if (!ctx.quiet) log.success("Raw content node created.");
          emit(ctx, data, {
            warnings:
              body.tag_ids === undefined
                ? []
                : [
                    "tag_ids is accepted and ignored on create. Set tags once ingestion finishes with `senso kb tags set`.",
                  ],
            next: pollSteps(data.kb_node_id, "pending"),
          });
        }),
      ),
    {
      returns: [
        "kb_node_id — USE THIS with every other kb command (get, tags, move, delete).",
        "id — the CONTENT id, not the node id. `senso content` takes it; no kb command does. Piping `.data.id` into `senso kb get` is a 404.",
        "processing_status — pending or processing here: the API answers 202 and ingests in the background, so the document is NOT searchable yet.",
        "version_num — starts at 1.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 402 out of credits or spending limit reached, 409 a document with byte-identical text already exists, 400 kb_folder_node_id is not a folder",
        2: "--data is not a JSON object, `text` is missing or empty, or a key is not recognized",
        3: "you can see the target folder but may not create in it",
        4: "kb_folder_node_id does not exist, or your key cannot see it",
      },
      notes: [
        'Omitting `title` gets you a document named "Untitled Content", which you will not find by name.',
        "Senso auto-tags the document once ingestion finishes. Override afterwards with `senso kb tags set`; tags cannot be set here.",
        "This is the command markdown goes through — `kb upload` rejects .md and .markdown.",
      ],
      examples: [
        {
          command:
            'senso kb create-raw --data \'{"title":"Refund Policy","text":"# Refund Policy\\n\\nRefunds within 30 days."}\'',
        },
        {
          comment: "Create, then poll the node (not the content id)",
          command:
            'NODE=$(senso kb create-raw --data \'{"title":"T","text":"..."}\' --output json | jq -r .data.kb_node_id) && senso kb get "$NODE"',
        },
      ],
      seeAlso: ["senso kb update-raw", "senso kb patch-raw", "senso kb get", "senso kb tags set"],
    },
  );

  describeCommand(
    kb
      .command("update-raw")
      .description("Replace a raw document's title, summary and text, creating a new version.")
      .argument("<id>", "kb_node_id of a RAW content node")
      .requiredOption(
        "--data <json>",
        'JSON: { "title": "Title", "text": "# Updated content", "summary": "...", "tag_ids": ["<uuid>"] }. "title" and "text" are both required. Omitting "summary" CLEARS it. "tag_ids" REPLACES the whole tag set — omit it to keep the current tags, pass [] to clear them',
      )
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: { data: string }) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const body = parseJsonFlag<{ title?: unknown; text?: unknown; tag_ids?: unknown }>(
            cmdOpts.data,
            { required: ["title", "text"], optional: ["summary", "tag_ids"] },
          );
          assertNonEmptyString(body.title, "title", cmdOpts.data);
          assertNonEmptyString(body.text, "text", cmdOpts.data);
          assertTagIdArray(body.tag_ids, cmdOpts.data);
          const data = await apiRequest<{ kb_node_id?: string }>({
            method: "PUT",
            path: `/org/kb/nodes/${id}/raw`,
            body,
            resource: nodeResource(id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          }).catch((err: unknown) => {
            throw refine(err, [
              {
                match: /not of type raw/i,
                hint: `This node holds an uploaded file. Replace it with: senso kb update-file ${id} <file>`,
              },
              {
                match: /duplicate content/i,
                hint: "Another document already has byte-identical text. Find it with: senso kb find --query <title>",
              },
              {
                match: /failed to set tags/i,
                hint: "The text was replaced but the tags were not. Re-read with `senso kb tags list` and set them again.",
              },
            ]);
          });
          if (!ctx.quiet) log.success(`Node ${id} content replaced.`);
          emit(ctx, data, { next: pollSteps(id, "processing") });
        }),
      ),
    {
      returns: [
        "kb_node_id — the node you updated. Keep using this one.",
        "id — the CONTENT id. No kb command takes it.",
        "version_num — incremented by this call.",
        "processing_status — back to pending/processing: ingestion restarts and the document is briefly NOT searchable.",
        "org_tags[] — the tag set after the update.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 400 the node is not a raw document, 402 out of credits, 409 the new text duplicates existing content",
        2: "<id> is not a UUID, or --data is missing title/text, has an unrecognized key, or a tag_ids entry is not a UUID",
        3: "you can see the node but hold only viewer on it",
        4: "no node with this id, your key cannot see it, or <id> is a folder",
      },
      notes: [
        "Full replacement: omitting `summary` sends \"\" and CLEARS it. Use `senso kb patch-raw` to leave a field alone.",
        "Raw (text/markdown) documents only. For an uploaded file use `senso kb update-file`.",
        "Re-ingestion re-runs auto-tagging, which may add tags after this call.",
        "The tag write happens after the content write commits, so a failure reported at that point means the text WAS replaced.",
      ],
      examples: [
        {
          command:
            'senso kb update-raw 7d10b3c5-8e42-4a6f-b913-2c58d0e7a4f6 --data \'{"title":"Refund Policy","text":"# Refund Policy\\n\\nRefunds within 14 days."}\'',
        },
        {
          comment: "Clear every tag while replacing the text",
          command:
            'senso kb update-raw 7d10b3c5-8e42-4a6f-b913-2c58d0e7a4f6 --data \'{"title":"T","text":"...","tag_ids":[]}\'',
        },
      ],
      seeAlso: ["senso kb patch-raw", "senso kb update-file", "senso kb get", "senso kb tags set"],
    },
  );

  describeCommand(
    kb
      .command("patch-raw")
      .description("Change some of a raw document's fields and leave the rest alone.")
      .argument("<id>", "kb_node_id of a RAW content node")
      .requiredOption(
        "--data <json>",
        'JSON: { "title": "New title", "text": "Updated text", "summary": "...", "tag_ids": ["<uuid>"] }. At least one of title/summary/text — "tag_ids" on its own is rejected. "tag_ids" REPLACES the whole tag set',
      )
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: { data: string }) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const body = parseJsonFlag<{ title?: unknown; text?: unknown; tag_ids?: unknown }>(
            cmdOpts.data,
            { anyOf: ["title", "summary", "text"], optional: ["tag_ids"] },
          );
          if (body.title !== undefined) assertNonEmptyString(body.title, "title", cmdOpts.data);
          if (body.text !== undefined) assertNonEmptyString(body.text, "text", cmdOpts.data);
          assertTagIdArray(body.tag_ids, cmdOpts.data);
          const data = await apiRequest<{ kb_node_id?: string }>({
            method: "PATCH",
            path: `/org/kb/nodes/${id}/raw`,
            body,
            resource: nodeResource(id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          }).catch((err: unknown) => {
            throw refine(err, [
              {
                match: /not of type raw/i,
                hint: `This node holds an uploaded file. Replace it with: senso kb update-file ${id} <file>`,
              },
              {
                match: /duplicate content/i,
                hint: "Another document already has byte-identical text. Find it with: senso kb find --query <title>",
              },
              {
                match: /failed to set tags/i,
                hint: "The text was patched but the tags were not. Re-read with `senso kb tags list` and set them again.",
              },
            ]);
          });
          if (!ctx.quiet) log.success(`Node ${id} content patched.`);
          emit(ctx, data, { next: pollSteps(id, "processing") });
        }),
      ),
    {
      returns: [
        "kb_node_id — the node you patched. Keep using this one.",
        "id — the CONTENT id. No kb command takes it.",
        "version_num — incremented by this call.",
        "processing_status — back to pending/processing: ingestion restarts and the document is briefly NOT searchable.",
        "org_tags[] — the tag set after the patch.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 400 the node is not a raw document, 402 out of credits, 409 the new text duplicates existing content",
        2: "<id> is not a UUID, --data names none of title/summary/text, or a tag_ids entry is not a UUID",
        3: "you can see the node but hold only viewer on it",
        4: "no node with this id, your key cannot see it, or <id> is a folder",
      },
      notes: [
        "Keys you omit are left UNCHANGED. That is the difference from `senso kb update-raw`, which replaces the whole document and clears what you omit.",
        "`tag_ids` on its own is rejected by the API — for a tags-only edit use `senso kb tags set`.",
        "Raw (text/markdown) documents only. For an uploaded file use `senso kb update-file`.",
      ],
      examples: [
        {
          command:
            'senso kb patch-raw 7d10b3c5-8e42-4a6f-b913-2c58d0e7a4f6 --data \'{"title":"Refund Policy 2025"}\'',
        },
        {
          command:
            'senso kb patch-raw 7d10b3c5-8e42-4a6f-b913-2c58d0e7a4f6 --data \'{"text":"# Refund Policy\\n\\nRefunds within 14 days."}\'',
        },
      ],
      seeAlso: ["senso kb update-raw", "senso kb tags set", "senso kb get"],
    },
  );

  describeCommand(
    kb
      .command("upload")
      .description("Upload up to 10 local files to the knowledge base.")
      .argument("<files...>", "1 to 10 local paths; each must exist and be non-empty")
      .option(
        "--folder-id <id>",
        "kb_node_id of the folder to upload into; omit for the organization root",
      )
      .action(
        runAction(program, async (ctx, files: string[], cmdOpts: { folderId?: string }) => {
          if (files.length > 10) {
            throw new CliError("Maximum 10 files per upload request.", EXIT.USAGE, {
              code: "usage",
              hint: `You passed ${String(files.length)}. Split them across several uploads.`,
            });
          }
          const folderId = parseOptionalId(cmdOpts.folderId, {
            label: "--folder-id",
            type: "Folder",
            idField: "kb_folder_node_id",
            list: "senso kb find --type folder",
          });

          // The same two pre-checks `ingest upload` makes, from the same place:
          // a bad path or an unparseable empty file is the caller's mistake, so it
          // costs a usage error naming the file rather than an ENOENT at exit 1 or
          // an upload the ingestion worker will silently fail to process. The type
          // check joins them because a file the API is certain to refuse should
          // not cost a round trip either.
          await assertFilesExist(files);
          assertUploadable(files);

          const fileData = await Promise.all(files.map(getFileMetadata));
          assertFilesNotEmpty(fileData.map((f) => f.meta));

          const body: Record<string, unknown> = { files: fileData.map((f) => f.meta) };
          if (folderId !== undefined) body.kb_folder_node_id = folderId;

          let response: UploadResponse;
          try {
            response = await apiRequest<UploadResponse>({
              method: "POST",
              path: "/org/kb/upload",
              body,
              resource:
                folderId === undefined
                  ? undefined
                  : {
                      type: "Folder",
                      id: folderId,
                      idField: "kb_folder_node_id",
                      list: "senso kb find --type folder",
                    },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            // Narrowed to the batch-rejection shape, as in `ingest upload`: only
            // that body carries the per-file reasons handleUploadError unpacks.
            // Everything else is rethrown untouched so runAction gives it its real
            // exit code (401 → 3, 404 → 4, unreachable → 5) instead of flattening
            // every upload failure to 1, which is what a script branches on.
            if (isBatchRejection(err)) {
              handleUploadError(err);
              throw new CliError("Upload failed.", EXIT.ERROR, { cause: err });
            }
            throw err;
          }

          // `?? []` despite `results` being declared required: apiRequest casts,
          // it does not validate, so a response omitting the field would throw
          // "not iterable" here rather than report an empty upload.
          const items = response.results ?? [];
          const uploaded: UploadResultItem[] = [];
          const failed: { filename: string; reason: string }[] = [];

          for (const item of items) {
            if (item.status === "upload_pending" && item.upload_url) {
              const match = fileData.find((f) => f.meta.filename === item.filename);
              if (!match) {
                failed.push({ filename: item.filename, reason: "Could not match to a local file." });
                continue;
              }
              try {
                await uploadToS3(item.upload_url, match.buffer, match.meta.content_type);
                uploaded.push(item);
              } catch (uploadErr) {
                failed.push({
                  filename: item.filename,
                  reason: `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
                });
              }
            } else {
              failed.push({
                filename: item.filename,
                reason: skipReason(item.status, item.error),
              });
            }
          }

          // A batch where every file was rejected or every S3 PUT failed used to
          // exit 0: nothing was stored, but a script branching on the exit code saw
          // success and the only signal was English on stderr.
          if (uploaded.length === 0 && items.length > 0) {
            throw new CliError(
              `No files were uploaded (${String(items.length)} attempted).`,
              EXIT.ERROR,
              {
                details: { failed },
                hint: failed[0]
                  ? `First reason: ${failed[0].filename} — ${failed[0].reason}`
                  : "Re-run with --output json for the machine-readable detail.",
              },
            );
          }

          if (!ctx.quiet) {
            log.info(
              `${String(uploaded.length)}/${String(items.length)} file(s) uploaded. Background processing will parse, chunk and embed them.`,
            );
          }

          // The rows, not the raw payload, in plain and table: the payload's
          // upload_url is a signed URL that has already been used, and the four
          // fields a caller needs next were previously printed nowhere at all in
          // plain mode — including the kb_node_id this command's own help tells
          // the caller to poll with.
          emit(ctx, response, {
            rows: items.map((item) => ({
              filename: item.filename,
              status: item.status,
              kb_node_id: item.kb_node_id ?? "",
              content_id: item.content_id ?? "",
              error: item.error ?? "",
            })),
            columns: ["filename", "status", "kb_node_id", "content_id", "error"],
            warnings: failed.map((f) => `${f.filename} was not stored — ${f.reason}`),
            next: uploaded.flatMap((item) => pollSteps(item.kb_node_id, "pending")),
          });
        }),
      ),
    {
      returns: [
        "summary — total / success / skipped for the batch.",
        "results[].kb_node_id — present only on accepted files. THIS is what you poll with `senso kb get`; it is not a content_id.",
        "results[].status — one of:",
        "  upload_pending                   accepted; the bytes were sent to S3 and a worker will pick them up",
        "  duplicate                        the same bytes appeared twice in THIS command",
        "  conflict                         the same bytes are already being ingested here; existing_content_id names them",
        "  invalid                          rejected: unsupported type, over 100MB, or a Word ~$ lock file",
        "  markdown_requires_raw_ingestion  a .md/.markdown file — use `senso kb create-raw`",
        "results[].content_id — the stored document, for `senso content` and `senso ingest`.",
      ],
      exitCodes: {
        ...idExits,
        0: "at least one file was accepted; anything skipped is reported in warnings",
        1: "every file was rejected, or the API refused the batch (402 out of credits)",
        2: "more than 10 files, a path that does not exist, an empty file, or a type the API will reject",
        3: "you can see --folder-id but may not create in it",
        4: "--folder-id does not exist, or your key cannot see it",
      },
      notes: [
        `Accepted: ${ACCEPTED_EXTENSIONS}, up to 100MB per file.`,
        "Rejected before any request: .md and .markdown (use `senso kb create-raw`), .json, .xml, and any extension this CLI cannot type.",
        "A file is NOT searchable until its node's content.processing_status is complete.",
      ],
      examples: [
        { command: "senso kb upload ./refund-policy.pdf" },
        {
          command:
            "senso kb upload ./a.pdf ./b.docx --folder-id b204e7f1-5c6a-4d38-a9e2-71f0c3b85d6a",
        },
        {
          comment: "Upload, then poll the node it created",
          command:
            "NODE=$(senso kb upload ./a.pdf --output json | jq -r '.data.results[0].kb_node_id') && senso kb get \"$NODE\"",
        },
      ],
      seeAlso: ["senso kb create-raw", "senso kb update-file", "senso kb get", "senso ingest upload"],
    },
  );

  describeCommand(
    kb
      .command("update-file")
      .description("Replace the file behind an existing node with a new version.")
      .argument("<id>", "kb_node_id of an uploaded FILE node")
      .argument("<file>", "local path to the replacement file")
      .action(
        runAction(program, async (ctx, rawId: string, file: string) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          // `kb upload` made these checks and this command did not, so the same
          // mistake — a typo'd path, a zero-byte file, a markdown file — was a
          // usage error naming the file in one command and a raw ENOENT at exit
          // 1, or an opaque 500, in the other.
          await assertFilesExist([file]);
          assertUploadable([file]);
          const { meta, buffer } = await getFileMetadata(file);
          assertFilesNotEmpty([meta]);

          const item = await apiRequest<UploadResultItem & { upload_url?: string }>({
            method: "PUT",
            path: `/org/kb/nodes/${id}/file`,
            body: { file: meta },
            resource: nodeResource(id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          }).catch((err: unknown) => {
            throw refine(err, [
              {
                match: /already being processed|has been ingested/i,
                hint: `The same bytes are already ingested or in flight. Check the node with: senso kb get ${id}`,
              },
              {
                match: /not a content node|has no associated content/i,
                hint: `This id is a folder or a text document. Text is replaced with: senso kb update-raw ${id} --data '{"title":"...","text":"..."}'`,
              },
            ]);
          });

          if (item.status !== "upload_pending" || !item.upload_url) {
            // Nothing was stored, so this is a failure however the API worded
            // it — reporting it as a warning and exiting 0, as this used to,
            // told a script the new version had been accepted.
            throw new CliError(
              `The new version was not accepted (${item.status}).${item.error ? ` ${item.error}` : ""}`,
              EXIT.ERROR,
              {
                details: { status: item.status, error: item.error },
                hint: `Check the node's current state with: senso kb get ${id}`,
              },
            );
          }

          await uploadToS3(item.upload_url, buffer, meta.content_type);
          if (!ctx.quiet) {
            log.success(`Uploaded ${meta.filename} for node ${id}. Re-processing started.`);
          }

          // The signed URL is dropped rather than echoed: it has been consumed
          // by the PUT above, and a credential-bearing URL in an agent's log is
          // worth nothing and costs something.
          const { upload_url: _consumed, ...payload } = item;
          emit(ctx, payload, { next: pollSteps(id, "pending") });
        }),
      ),
    {
      returns: [
        "kb_node_id — the node you updated; unchanged.",
        "content_id — the document behind it; unchanged.",
        "ingestion_run_id — the run that will process the new version, readable with `senso ingest runs`.",
        'status — always "upload_pending" on success: the bytes are in S3 and a worker will pick them up.',
        "The consumed presigned upload_url is not echoed.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 400 <id> is not a file node, 402 out of credits, 409 the same bytes are already ingesting, 500 unsupported type or over 100MB",
        2: "<id> is not a UUID, or <file> does not exist, is empty, is markdown, or is a type the API will reject",
        3: "you can see the node but hold only viewer on it",
        4: "no node with this id, or your key cannot see it",
      },
      notes: [
        "The node keeps its id, tags and permissions; only the stored file and its version number change.",
        "Works only on nodes created by `kb upload`. For a text or markdown document use `kb update-raw` or `kb patch-raw`.",
        "Re-processing is asynchronous — poll `senso kb get <id>` until content.processing_status is complete.",
      ],
      examples: [
        {
          command: "senso kb update-file 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 ./refund-policy-v2.pdf",
        },
      ],
      seeAlso: ["senso kb upload", "senso kb update-raw", "senso kb get", "senso ingest runs"],
    },
  );

  const tags = kb
    .command("tags")
    .description(
      "Tags on a knowledge base document. <id> is a kb_node_id; the ids in --ids/--id are tag ids, the `id` field of `senso tags list`; a --name that the organization's tag library does not have is CREATED there. Only CONTENT nodes can be tagged — a folder is rejected. Senso auto-tags content after ingestion, so tags set while processing_status is pending or processing may be added to afterwards. Workflow: tags list → tags set or tags add → tags list.",
    );

  describeCommand(
    tags
      .command("list")
      .description("List the tags on a knowledge base node.")
      .argument("<id>", "kb_node_id, from `senso kb my-files`, `kb find` or `kb get`")
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const data = await apiRequest({
            path: `/org/kb/nodes/${id}/tags`,
            resource: nodeResource(id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, {
            // `id`, not `tag_id`: dto.TagResponse's json key is `id`, and the
            // old spelling rendered a blank first column on every row.
            columns: ["id", "name", "curated"],
            empty: "tags",
            emptyHint: `Auto-tagging runs after ingestion — check content.processing_status with: senso kb get ${id}`,
          });
        }),
      ),
    {
      returns: [
        "id — the tag's UUID. This is what `kb tags remove --id` and `kb tags set --ids` take.",
        "name — the tag name, which is what --name / --names take.",
        "curated — true | false:",
        "  true   part of the organization's working vocabulary",
        "  false  machine-minted from a search query, awaiting adoption",
      ],
      exitCodes: { ...idExits, 2: "<id> is not a UUID", 4: "no node with this id, or your key cannot see it" },
      notes: [
        "A folder is accepted here and returns an empty list — folders are not tagged. `kb tags set` on the same folder is an error.",
      ],
      examples: [
        { command: "senso kb tags list 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39" },
        {
          command:
            "senso kb tags list 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --output json | jq -r '.data[].name'",
        },
      ],
      seeAlso: ["senso kb tags set", "senso kb tags add", "senso tags list"],
    },
  );

  describeCommand(
    tags
      .command("set")
      .description("Replace a document's entire tag set.")
      .argument("<id>", "kb_node_id of a CONTENT node")
      .option("--names <list>", "Comma-separated tag names (created in the org's library if missing)")
      .option("--ids <list>", "Comma-separated existing tag UUIDs from `senso tags list`")
      .option("--clear", "Remove every tag. Required to clear — passing no flags is an error")
      .action(
        runAction(
          program,
          async (
            ctx,
            rawId: string,
            cmdOpts: { names?: string; ids?: string; clear?: boolean },
          ) => {
            const id = parseId(rawId, nodeSpec("<id>"));
            const names = csv(cmdOpts.names);
            const ids = parseTagIds("--ids", cmdOpts.ids) ?? [];
            const clear = cmdOpts.clear === true;

            if (clear && (names.length > 0 || ids.length > 0)) {
              throw usageError("--clear cannot be combined with --names or --ids.", {
                field: "--clear",
                hint: "--clear removes every tag; --names/--ids replace the set with what you name.",
              });
            }
            if (!clear && names.length === 0 && ids.length === 0) {
              // The API reads `{}` as "remove every tag", so the old
              // no-flags invocation silently stripped a document's tags.
              throw usageError("Provide --names and/or --ids, or --clear.", {
                field: "--names",
                hint: "An empty body would clear every tag on the node; pass --clear if that is what you want.",
              });
            }

            const body: Record<string, string[]> = {};
            if (names.length > 0) body.tag_names = names;
            if (ids.length > 0) body.tag_ids = ids;

            const data = await apiRequest({
              method: "PUT",
              path: `/org/kb/nodes/${id}/tags`,
              body,
              resource: nodeResource(id),
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            }).catch((err: unknown) => {
              throw refine(err, [
                {
                  match: /cannot be applied to folders/i,
                  hint: `This id is a folder. Tag the documents inside it: senso kb children ${id} --type content`,
                },
              ]);
            });
            if (!ctx.quiet) {
              log.success(clear ? `KB node ${id} tags cleared.` : `KB node ${id} tags updated.`);
            }
            emit(ctx, data, {
              columns: ["id", "name", "curated"],
              empty: "tags",
              emptyHint: "Every tag was removed from this node.",
            });
          },
        ),
      ),
    {
      returns: [
        "The node's tag set AFTER the replacement: one row per tag with id, name and curated.",
        "An empty list means the node now carries no tags.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 400 the node is a folder, or a tag id does not exist in this organization",
        2: "<id> is not a UUID, --ids contains a non-UUID, or none of --names/--ids/--clear was given",
        3: "you can see the node but may not modify it",
        4: "no node with this id, or your key cannot see it",
      },
      notes: [
        "--names and --ids combine into ONE replacement set: passing only --names removes tags that were attached by id, and the reverse.",
        "A --names entry the organization's tag library does not have is CREATED there and becomes available to every other document.",
        "Auto-tagging may add tags after this call if ingestion has not finished.",
      ],
      examples: [
        { command: "senso kb tags set 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --names policy,refunds" },
        {
          command:
            "senso kb tags set 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --ids c3d9a0b2-6e11-4f77-8a25-0d4b9e6f2c18",
        },
        {
          comment: "Remove every tag, deliberately",
          command: "senso kb tags set 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --clear",
        },
      ],
      seeAlso: ["senso kb tags add", "senso kb tags list", "senso tags list"],
    },
  );

  describeCommand(
    tags
      .command("add")
      .description("Attach ONE tag, keeping the tags the document already has.")
      .argument("<id>", "kb_node_id of a CONTENT node")
      .option("--name <name>", "Tag name (created in the org's library if missing)")
      .option("--id <tagId>", "Existing tag UUID from `senso tags list`")
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: { name?: string; id?: string }) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const { name, id: tagId } = readTagSelector(cmdOpts, "attach");
          const body = tagId === undefined ? { tag_name: name } : { tag_id: tagId };

          // Two shapes, by design: attaching by name returns 201 with the tag —
          // created if it did not exist, so this is the only place its id is
          // reported — while attaching by id returns 204 and nothing to print.
          // apiRequest gives undefined for the 204, which is what separates them.
          const data = await apiRequest({
            method: "POST",
            path: `/org/kb/nodes/${id}/tags`,
            body,
            resource: nodeResource(id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          }).catch((err: unknown) => {
            throw refine(err, [
              {
                match: /cannot be applied to folders/i,
                hint: `This id is a folder. Tag the documents inside it: senso kb children ${id} --type content`,
              },
            ]);
          });
          if (data === undefined) {
            emitConfirmation(ctx, `Tag attached to KB node ${id}.`, {
              action: "tag_attached",
              resource: "kb_node_tag",
              id,
              kb_node_id: id,
              tag_id: tagId,
            });
            return;
          }
          if (!ctx.quiet) log.success(`Tag attached to KB node ${id}.`);
          emit(ctx, data, { columns: ["id", "name", "curated"] });
        }),
      ),
    {
      returns: [
        "With --name: the tag — id, name, curated. This is the ONLY command that reports a newly created tag's id, so capture it here.",
        'With --id: nothing (the API answers 204). Under --output json the CLI reports {"action": "tag_attached", "kb_node_id": ..., "tag_id": ...}.',
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 400 the node is a folder, or --id names a tag that is not in this organization",
        2: "neither or both of --name and --id, <id> is not a UUID, or --id is not a UUID",
        3: "you can see the node but may not modify it",
        4: "no node with this id, or your key cannot see it",
      },
      notes: [
        "Exactly one of --name or --id. Passing both is refused rather than silently preferring one.",
        "A --name the organization's tag library does not have is CREATED there, for every document.",
        "Additive, and re-adding a tag the document already has is not an error.",
      ],
      examples: [
        { command: "senso kb tags add 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --name refunds" },
        {
          comment: "Learn a newly created tag's id",
          command:
            "senso kb tags add 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --name refunds --output json | jq -r .data.id",
        },
      ],
      seeAlso: ["senso kb tags set", "senso kb tags remove", "senso kb tags list"],
    },
  );

  describeCommand(
    tags
      .command("remove")
      .description("Detach ONE tag. The tag itself stays in the organization's library.")
      .argument("<id>", "kb_node_id of the node to detach from")
      .option("--name <name>", "Tag name to detach")
      .option("--id <tagId>", "Tag UUID to detach, from `senso kb tags list`")
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: { name?: string; id?: string }) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const { name, id: tagId } = readTagSelector(cmdOpts, "detach");

          // Read first, so "removed" and "was never there" can be told apart.
          // Both are a 204 from the API with the same message, which made a typo
          // in --name indistinguishable from a successful removal.
          const before = await apiRequest<{ id?: string; name?: string }[]>({
            path: `/org/kb/nodes/${id}/tags`,
            resource: nodeResource(id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          const had = (before ?? []).some((t) =>
            tagId === undefined ? t.name === name : t.id === tagId,
          );

          if (tagId !== undefined) {
            await apiRequest({
              method: "DELETE",
              path: `/org/kb/nodes/${id}/tags/${tagId}`,
              resource: nodeResource(id),
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } else {
            await apiRequest({
              method: "DELETE",
              path: `/org/kb/nodes/${id}/tags`,
              params: { name },
              resource: nodeResource(id),
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          }

          emitConfirmation(
            ctx,
            had
              ? `Tag detached from KB node ${id}.`
              : `KB node ${id} did not have that tag; nothing changed.`,
            {
              action: "tag_detached",
              resource: "kb_node_tag",
              id,
              kb_node_id: id,
              changed: had,
              ...(tagId === undefined ? { tag_name: name } : { tag_id: tagId }),
            },
          );
        }),
      ),
    {
      returns: [
        'Nothing from the API (204). Under --output json the CLI reports {"action": "tag_detached", "kb_node_id": ..., "changed": true|false}.',
        "changed — false means the node did not have that tag and nothing was removed. This is how a typo in --name is told apart from a real detach.",
      ],
      exitCodes: {
        ...idExits,
        2: "neither or both of --name and --id, <id> or --id is not a UUID, or --name is blank",
        3: "you can see the node but may not modify it",
        4: "no node with this id, or your key cannot see it",
      },
      notes: [
        "The tag itself is NOT deleted: it stays in the organization's library and on every other document. `senso tags delete` removes it everywhere.",
        "This reads the node's tags before detaching, so it makes two requests.",
        "To remove every tag at once, use `senso kb tags set <id> --clear`.",
      ],
      examples: [
        { command: "senso kb tags remove 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --name refunds" },
        {
          command:
            "senso kb tags remove 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --id c3d9a0b2-6e11-4f77-8a25-0d4b9e6f2c18",
        },
      ],
      seeAlso: ["senso kb tags set", "senso kb tags list", "senso tags delete"],
    },
  );

  const permissions = kb
    .command("permissions")
    .description(
      "Who can see and change a knowledge base node. Grants INHERIT down the tree: a grant on a folder reaches everything inside it, and `kb get` reports the resolved answer as effective_role. viewer reads; editor also renames, moves, deletes, re-uploads and tags; owner is assigned by the platform and cannot be granted here. Three ids are in play: <id> is a kb_node_id, --grantee-id is a user_id or group_id, and <permissionId> is the grant's own `id` from `kb permissions list`. An org-admin key bypasses grants entirely, so an empty list does not mean nobody has access.",
    );

  describeCommand(
    permissions
      .command("list")
      .description("List the access grants on a node — who holds what role.")
      .argument("<id>", "kb_node_id, from `senso kb my-files` or `kb find`")
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const data = await apiRequest<{ grants?: Grant[] }>({
            path: `/org/kb/nodes/${id}/permissions`,
            resource: nodeResource(id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, {
            ...grantTable(ctx, data),
            empty: "grants",
            emptyHint: `Access may still come from a grant on a parent folder — check senso kb ancestors ${id} — or from an org-admin key, which bypasses grants.`,
          });
        }),
      ),
    {
      returns: [
        "grants[].id — the PERMISSION id: what `kb permissions update` and `kb permissions remove` take as <permissionId>.",
        "grants[].role — viewer | editor | owner.",
        "grants[].grantee.type — user | group.",
        "grants[].grantee.id — the user_id or group_id. NOT the permission id.",
        "grants[].grantee.display_name and grantee.email (users only).",
        "grants[].granted_at — when the grant was made.",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID",
        3: "you can see the node but may not manage access on it",
        4: "no node with this id, or your key cannot see it",
      },
      notes: [
        "This shows the node's OWN grants. Grants inherit, so a node with none can still be reachable through a grant on a parent folder — `senso kb get <id>` reports your own resolved effective_role.",
        "Group grants for groups you cannot see are omitted without comment, and an org-admin key needs no grant at all.",
        "Reading this needs the share capability, so it can exit 3 where `senso kb get` on the same node succeeds.",
      ],
      examples: [
        { command: "senso kb permissions list 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39" },
        {
          command:
            'senso kb permissions list 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --output json | jq -r \'.data.grants[] | "\\(.id) \\(.role) \\(.grantee.display_name)"\'',
        },
      ],
      seeAlso: ["senso kb permissions add", "senso kb get", "senso kb ancestors"],
    },
  );

  describeCommand(
    permissions
      .command("add")
      .description("Grant one user or group viewer or editor access to a node.")
      .argument("<id>", "kb_node_id to grant access on")
      .requiredOption("--grantee-type <type>", `Who the grant is for: ${GRANTEE_TYPES.join(" | ")}`)
      .requiredOption(
        "--grantee-id <id>",
        "user_id from `senso users list`, or group_id from `senso permissions groups`",
      )
      .requiredOption("--role <role>", `Access level to grant: ${GRANTABLE_ROLES.join(" | ")}`)
      .action(
        runAction(
          program,
          async (
            ctx,
            rawId: string,
            cmdOpts: { granteeType: string; granteeId: string; role: string },
          ) => {
            const id = parseId(rawId, nodeSpec("<id>"));
            const granteeType = requireEnumFlag("--grantee-type", cmdOpts.granteeType, GRANTEE_TYPES);
            const role = requireEnumFlag("--role", cmdOpts.role, GRANTABLE_ROLES);
            const granteeId = parseId(cmdOpts.granteeId, {
              label: "--grantee-id",
              type: granteeType === "user" ? "User" : "Group",
              idField: granteeType === "user" ? "user_id" : "group_id",
              list: granteeType === "user" ? "senso users list" : "senso permissions groups",
            });
            const data = await apiRequest<Grant>({
              method: "POST",
              path: `/org/kb/nodes/${id}/permissions`,
              body: { grantee_type: granteeType, grantee_id: granteeId, role },
              resource: nodeResource(id),
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            }).catch((err: unknown) => {
              throw refine(err, [
                {
                  match: /already has a permission/i,
                  hint: `Find the existing grant with: senso kb permissions list ${id}, then change it with: senso kb permissions update ${id} <permission_id> --role ${role}`,
                },
              ]);
            });
            if (!ctx.quiet) log.success(`Granted ${role} on node ${id}.`);
            emit(ctx, data, {
              next:
                data.id === undefined
                  ? []
                  : [
                      {
                        why: "Change this grant's role",
                        command: `senso kb permissions update ${id} ${data.id} --role editor`,
                      },
                      {
                        why: "Revoke it",
                        command: `senso kb permissions remove ${id} ${data.id}`,
                      },
                    ],
            });
          },
        ),
      ),
    {
      returns: [
        "id — the PERMISSION id. Pass it to `kb permissions update` and `kb permissions remove`.",
        "grantee.id — the user_id or group_id you granted to; a DIFFERENT id.",
        "grantee.type — user | group.",
        "role — viewer | editor, as granted.",
        "granted_at — when.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 409 this grantee already has a grant on this node",
        2: "<id> or --grantee-id is not a UUID, or --grantee-type/--role is not an allowed value",
        3: "you can see the node but may not manage access on it",
        4: "no node with this id, no such user in this organization, or the group does not exist or is invisible to your key",
      },
      notes: [
        "Grants INHERIT: a grant on a folder reaches every folder and document inside it. Granting on a folder is usually what you want.",
        "owner cannot be granted — the platform assigns it to whoever created the node.",
        "A group you cannot see is reported as not found, not as forbidden.",
      ],
      examples: [
        {
          command:
            "senso kb permissions add 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --grantee-type user --grantee-id d8e1f0a3-2b74-4c19-9e56-3a0f8b7d4c21 --role viewer",
        },
        {
          comment: "Capture the permission id",
          command:
            "senso kb permissions add b204e7f1-5c6a-4d38-a9e2-71f0c3b85d6a --grantee-type group --grantee-id 6b0d9f23-7e41-4a85-93c7-25f1a8d40e6b --role editor --output json | jq -r .data.id",
        },
      ],
      seeAlso: ["senso kb permissions list", "senso kb permissions update", "senso users list"],
    },
  );

  describeCommand(
    permissions
      .command("update")
      .description("Change an existing grant's role.")
      .argument("<id>", "kb_node_id the grant is on")
      .argument("<permissionId>", "the grant's own id, the `id` field of `kb permissions list`")
      .requiredOption("--role <role>", `The new role: ${GRANTABLE_ROLES.join(" | ")}`)
      .action(
        runAction(
          program,
          async (ctx, rawId: string, rawPermissionId: string, cmdOpts: { role: string }) => {
            const id = parseId(rawId, nodeSpec("<id>"));
            const permissionId = parseId(rawPermissionId, permissionSpec(id));
            const role = requireEnumFlag("--role", cmdOpts.role, GRANTABLE_ROLES);
            await apiRequest({
              method: "PATCH",
              path: `/org/kb/nodes/${id}/permissions/${permissionId}`,
              body: { role },
              resource: { ...permissionSpec(id), id: permissionId },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            }).catch((err: unknown) => {
              throw refine(err, [
                {
                  match: /own permission/i,
                  hint: "You cannot change your own grant. Another admin has to make this change.",
                },
              ]);
            });
            // The API answers {"message": "Permission updated"}, which tells a
            // caller nothing it can verify. This says what changed.
            emitConfirmation(
              ctx,
              `Grant ${permissionId} is now ${role}.`,
              {
                action: "role_changed",
                resource: "kb_permission",
                id: permissionId,
                node_id: id,
                role,
              },
              {
                next: [
                  { why: "Confirm the new role", command: `senso kb permissions list ${id}` },
                ],
              },
            );
          },
        ),
      ),
    {
      returns: [
        'The API says only {"message": "Permission updated"}. Under --output json the CLI reports',
        '{"action": "role_changed", "resource": "kb_permission", "id": <permissionId>, "node_id": <id>, "role": ...}.',
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 400 it is your own grant",
        2: "either id is not a UUID, or --role is not viewer/editor",
        3: "you can see the node but may not manage access on it",
        4: "no such node, or no such permission ON THIS NODE",
      },
      notes: [
        "The permission id must belong to THIS node: one from another node reports not found, as does a grant to a group your key cannot see.",
        "<permissionId> is the grant's own id, not the grantee's user_id or group_id — the two sit side by side in `kb permissions list`.",
      ],
      examples: [
        {
          command:
            "senso kb permissions update 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 9e3b7c02-4a18-4f65-8d90-1c2e5b7a6f43 --role editor",
        },
        {
          comment: "Find one person's grant id",
          command:
            'senso kb permissions list 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 --output json | jq -r \'.data.grants[] | select(.grantee.email=="ada@example.com") | .id\'',
        },
      ],
      seeAlso: ["senso kb permissions list", "senso kb permissions add", "senso kb permissions remove"],
    },
  );

  describeCommand(
    permissions
      .command("remove")
      .description("Revoke one access grant on a node.")
      .argument("<id>", "kb_node_id the grant is on")
      .argument("<permissionId>", "the grant's own id, the `id` field of `kb permissions list`")
      .action(
        runAction(program, async (ctx, rawId: string, rawPermissionId: string) => {
          const id = parseId(rawId, nodeSpec("<id>"));
          const permissionId = parseId(rawPermissionId, permissionSpec(id));
          await apiRequest({
            method: "DELETE",
            path: `/org/kb/nodes/${id}/permissions/${permissionId}`,
            resource: { ...permissionSpec(id), id: permissionId },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          }).catch((err: unknown) => {
            throw refine(err, [
              {
                match: /own permission/i,
                hint: "You cannot revoke your own grant. Another admin has to do it.",
              },
            ]);
          });
          // The endpoint answers with prose rather than the revoked grant, so
          // the confirmation names what went — as `kb delete` does.
          emitConfirmation(
            ctx,
            `Grant ${permissionId} revoked on node ${id}.`,
            {
              action: "revoked",
              resource: "kb_permission",
              id: permissionId,
              node_id: id,
            },
            {
              next: [
                {
                  why: "Inherited access survives a revoke — check the parents",
                  command: `senso kb ancestors ${id}`,
                },
              ],
            },
          );
        }),
      ),
    {
      returns: [
        'The API says only {"message": "Permission revoked"}. Under --output json the CLI reports',
        '{"action": "revoked", "resource": "kb_permission", "id": <permissionId>, "node_id": <id>}.',
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: 400 it is your own grant",
        2: "either id is not a UUID",
        3: "you can see the node but may not manage access on it",
        4: "no such node, or no such permission ON THIS NODE",
      },
      notes: [
        "This removes ONE grant. It does NOT remove inherited access: a grant on a parent folder keeps the grantee in. Check with `senso kb ancestors <id>` and list the grants on each ancestor.",
        "A revoke cannot be undone — recreating it with `kb permissions add` produces a new permission id.",
      ],
      examples: [
        {
          command:
            "senso kb permissions remove 3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39 9e3b7c02-4a18-4f65-8d90-1c2e5b7a6f43",
        },
      ],
      seeAlso: ["senso kb permissions list", "senso kb permissions add", "senso kb ancestors"],
    },
  );
}

/** A grant, as much of it as the table rendering needs. */
interface Grant {
  id?: string;
  role?: string;
  granted_at?: string;
  grantee?: { type?: string; id?: string; display_name?: string; email?: string };
}

/** The grant's own id space, which is neither the node's nor the grantee's. */
function permissionSpec(nodeId: string): IdSpec {
  return {
    label: "<permissionId>",
    type: "KB permission",
    idField: "id",
    list: `senso kb permissions list ${nodeId}`,
  };
}

/**
 * Table columns for a grant listing, and only for `table`.
 *
 * `grantee` is the payload's whole point and a nested object, so a table cell
 * renders it as truncated JSON. Flattened here for `table` alone — `plain`
 * renders it as an indented sub-block, which is what it should be.
 */
function grantTable(ctx: OutputContext, data: { grants?: Grant[] }): EmitOptions {
  if (ctx.format !== "table") return {};
  return {
    table: {
      rows: (data.grants ?? []).map((g) => ({
        id: g.id,
        role: g.role,
        grantee_type: g.grantee?.type,
        grantee_name: g.grantee?.display_name,
        grantee_email: g.grantee?.email ?? "",
        granted_at: g.granted_at,
      })),
      columns: ["id", "role", "grantee_type", "grantee_name", "grantee_email", "granted_at"],
    },
  };
}

/**
 * The `--name` / `--id` pair the tag subcommands share.
 *
 * Both commands used to prefer `--id` in silence when given both, so a caller
 * who named one tag and pasted the id of another detached the second and was
 * told the first had gone.
 */
function readTagSelector(
  cmdOpts: { name?: string; id?: string },
  verb: string,
): { name?: string; id?: string } {
  const hasName = cmdOpts.name !== undefined;
  const hasId = cmdOpts.id !== undefined;
  if (hasName && hasId) {
    throw usageError("Provide --name or --id, not both.", {
      field: "--id",
      received: `${cmdOpts.name ?? ""} / ${cmdOpts.id ?? ""}`,
      hint: `They can name two different tags, and only one would be ${verb}ed.`,
    });
  }
  if (!hasName && !hasId) {
    throw usageError("Provide --name or --id.", {
      field: "--name",
      hint: "--name takes the tag name; --id takes an existing tag UUID from `senso tags list`.",
    });
  }
  if (hasId) {
    return { id: parseId(cmdOpts.id ?? "", { label: "--id", ...TAG }) };
  }
  const name = (cmdOpts.name ?? "").trim();
  if (name === "") {
    throw usageError("--name is blank.", {
      field: "--name",
      received: cmdOpts.name,
      hint: "Pass the tag name, e.g. --name refunds.",
    });
  }
  return { name };
}

/** A `--data` field the API requires to be a non-empty string. */
function assertNonEmptyString(value: unknown, key: string, raw: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw usageError(`--data has an empty \`${key}\`.`, {
      field: "--data",
      received: raw,
      hint: `\`${key}\` must be a non-empty string; the API rejects a blank one.`,
    });
  }
}

/**
 * `tag_ids` inside a `--data` body.
 *
 * The API rejects the whole update when one entry is not a tag in the
 * organization, and its message names neither the key nor the value.
 */
function assertTagIdArray(value: unknown, raw: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw usageError("--data `tag_ids` must be an array.", {
      field: "--data",
      received: raw,
      hint: 'Pass tag UUIDs: "tag_ids": ["<uuid>"]. An empty array clears the tags.',
    });
  }
  parseIdList(value.map(String), { label: "--data tag_ids", ...TAG });
}
