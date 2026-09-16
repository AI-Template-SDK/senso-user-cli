import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { parseDateFlag, parseEnumFlag, parseIntFlag, assertRange } from "../lib/enum-arg.js";
import { CliError, EXIT, usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { isUuid, parseId, parseIdList, type IdSpec } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
import { runAction } from "../lib/run-action.js";
import { asText } from "../lib/text.js";
import { buildSetTagsBody, buildAttachTagBody } from "../lib/tag-args.js";
import * as log from "../utils/logger.js";

/**
 * The two id spaces this group mixes, and the third it writes against.
 *
 * `content list` returns kb_node_id values and every other command here takes a
 * content_id, which is the commonest way to get a 400 out of this group. Each
 * descriptor is used twice — once to validate the argument before the request,
 * and once as the `resource` on the request, so a 404 names what was addressed
 * and where the right id comes from.
 */
const CONTENT_ID: IdSpec = {
  label: "<id>",
  type: "Content",
  idField: "content_id",
  list: "senso content verification",
};

const VERSION_ID: IdSpec = {
  label: "<versionId>",
  type: "Content version",
  idField: "version_id",
  list: "senso content versions <content_id>",
};

const PUBLISH_RECORD_IDS: IdSpec = {
  label: "--publish-record-ids",
  type: "Publish record",
  idField: "publish_record_id",
  list: "senso content verification --status published",
};

const USER_ID: IdSpec = {
  label: "<userId>",
  type: "User",
  idField: "user_id",
  list: "senso members list",
};

const USER_IDS: IdSpec = { ...USER_ID, label: "--user-ids" };

const TAG_ID: IdSpec = { label: "--id", type: "Tag", idField: "id", list: "senso tags list" };

const TAG_IDS: IdSpec = { ...TAG_ID, label: "--ids" };

/** The same descriptor aimed at one id, for `apiRequest`'s `resource`. */
function ref(spec: IdSpec, id: string): ResourceRef {
  return { type: spec.type, id, idField: spec.idField, list: spec.list };
}

/**
 * The editorial statuses `content verification` filters by, and the substatuses
 * that narrow one of them further. Declared here so the help text and the
 * validation cannot say different things.
 *
 * `review` is a server-side alias for `draft` — the handler rewrites it before
 * it filters — so the two values return the same rows. It stays accepted
 * because callers and shipped skills already pass it.
 */
const VERIFICATION_STATUSES = ["all", "draft", "review", "rejected", "published"] as const;
const VERIFICATION_SUBSTATUSES = ["pending_draft", "unpublished"] as const;
const VERIFICATION_SORTS = [
  "citation_rate_desc",
  "citation_rate_asc",
  "raw_citations_desc",
  "raw_citations_asc",
] as const;

/** The columns worth seeing on the review queue. Every name is a real field. */
const VERIFICATION_COLUMNS = [
  "content_id",
  "title",
  "editorial_status",
  "published_at",
  "citation_rate",
  "tracked_url_count",
];

/** The edit-telemetry closed sets, enforced by the API one event at a time. */
const EDIT_EVENT_TYPES = [
  "ai_patch_requested",
  "ai_patch_proposed",
  "ai_patch_accepted",
  "ai_patch_rejected",
  "ai_patch_failed",
  "manual_edit_session_closed",
  "draft_saved",
  "published",
];
const EDIT_SOURCES = ["manual", "ai", "system"];

/**
 * The models the citation endpoints accept, for the help text only.
 *
 * Deliberately not validated: the accepted set lives in the API's model
 * registry and grows when a provider is added, so a list compiled into the CLI
 * would start refusing valid models the day after a release. The help names the
 * current set; `senso run-config model-options` is the live answer.
 */
const CITATION_MODELS =
  "gpt-4.1, chatgpt, perplexity, aioverview, gemini, linkup, claude-sonnet-4-6, grok, google_ai_overviews, claude, gpt";

/**
 * `/org/content/{id}` serves generated content only.
 *
 * `rejectKBContent` in the API answers 400 "Knowledge base content must be
 * accessed through KB node endpoints" for a knowledge-base document — and the
 * id it refuses is a perfectly valid content_id, just from the other half of
 * the system. Passed through unchanged, that reads as a bug in the command.
 * Re-reported here as a usage error, because it is: the caller reached for the
 * wrong command, and the fix is a different command rather than a retry.
 */
const KB_REJECTION = /knowledge base content/i;

function kbRejection(err: unknown, id: string, hint: string): CliError | undefined {
  if (!(err instanceof ApiError) || err.status !== 400 || !KB_REJECTION.test(err.message)) {
    return undefined;
  }
  return new CliError(
    `Content ${id} is a knowledge base document; \`senso content\` addresses generated content only.`,
    EXIT.USAGE,
    {
      code: "usage",
      status: 400,
      field: "<id>",
      received: id,
      hint,
      details: { api_message: err.message },
      request: err.request,
      cause: err,
    },
  );
}

/** Runs a request against generated content, translating the KB refusal. */
async function generatedOnly<T>(id: string, hint: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const rejection = kbRejection(err, id, hint);
    if (rejection) throw rejection;
    throw err;
  }
}

/**
 * `key  value` lines, for a command that supplies its own `plain` rendering.
 *
 * lib/output.ts renders an object this way when it owns the whole payload; a
 * command that hands `emit` an explicit `plain` has to say it again, and saying
 * it the same way is what stops the two renderings from drifting apart.
 */
function fieldLines(obj: Record<string, unknown>, indent = "  "): string[] {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const width = Math.max(0, ...keys.map((k) => k.length));
  return keys.map((k) => `${indent}${k.padEnd(width)}  ${cell(obj[k])}`);
}

/** One numbered block per row, matching the shape lib/output.ts prints. */
function itemLines(rows: Record<string, unknown>[], indent = "  "): string[] {
  const lines: string[] = [];
  rows.forEach((row, i) => {
    if (i > 0) lines.push("");
    lines.push(`${indent}${i + 1}.`);
    lines.push(...fieldLines(row, `${indent}   `));
  });
  return lines;
}

function cell(value: unknown): string {
  return asText(value);
}

/**
 * The edit-telemetry batch, checked before it is sent.
 *
 * The endpoint writes events one at a time with no transaction, fails on the
 * first invalid one, and then discards the counts — so a batch with a typo in
 * its fourth event leaves three events written and reports nothing about them.
 * Both closed sets are therefore checked here, where nothing has been written
 * yet, rather than there.
 */
function assertEvents(events: unknown): void {
  if (!Array.isArray(events) || events.length === 0) {
    throw usageError('--data must contain a non-empty "events" array.', {
      field: "--data",
      hint: 'Example: --data \'{"events":[{"event_type":"draft_saved","edit_source":"manual"}]}\'',
    });
  }

  events.forEach((event: unknown, i) => {
    const at = `--data events[${i}]`;
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      throw usageError(`${at} is not an object.`, { field: "--data", received: cell(event) });
    }
    const record = event as Record<string, unknown>;
    assertMember(`${at}.event_type`, record.event_type, EDIT_EVENT_TYPES);
    assertMember(`${at}.edit_source`, record.edit_source, EDIT_SOURCES);

    const clientEventId = record.client_event_id;
    if (
      clientEventId !== undefined &&
      (typeof clientEventId !== "string" || !isUuid(clientEventId))
    ) {
      throw usageError(`${at}.client_event_id is not a UUID.`, {
        field: "--data",
        received: cell(clientEventId),
        hint: "client_event_id is the dedupe key that makes retrying a half-written batch safe.",
      });
    }
  });
}

/** Exact membership, not case-folded: the API compares these literally. */
function assertMember(at: string, value: unknown, allowed: string[]): void {
  if (typeof value === "string" && allowed.includes(value)) return;
  throw usageError(value === undefined ? `${at} is missing.` : `Invalid ${at}: ${cell(value)}.`, {
    field: "--data",
    received: cell(value),
    allowed,
    hint: `Must be one of: ${allowed.join(", ")}.`,
  });
}

/**
 * `--substatus` narrows exactly one `--status`, and the API says which.
 *
 * Checked locally because the pairing is the part a caller gets wrong, and the
 * server's answer — a 400 reading "substatus=pending_draft requires
 * status=published" — costs a round trip to learn something the CLI knows.
 */
function assertSubstatusPairing(status: string | undefined, substatus: string | undefined): void {
  if (substatus === undefined) return;
  // The API rewrites `review` to `draft` before it checks the pairing, so
  // `--status review --substatus unpublished` is accepted there too.
  const effective = status === "review" ? "draft" : status;
  const required = substatus === "pending_draft" ? "published" : "draft";
  if (effective !== required) {
    throw usageError(`--substatus ${substatus} requires --status ${required}.`, {
      field: "--substatus",
      received: substatus,
      hint: `Run: senso content verification --status ${required} --substatus ${substatus}`,
    });
  }
}

export function registerContentCommands(program: Command): void {
  const content = program
    .command("content")
    .description(
      "Inspect and manage GENERATED content — items created by `senso engine draft` and `senso engine publish` — through review, publication and ownership. Knowledge base documents are not managed here: use `senso kb`. Ids: content_id from `senso content verification` (items[].content_id), version_id from `senso content versions` (reject and restore take that one), publish_record_id from `senso content verification` (items[].destinations[].publish_record_id). Most commands need the GEO product; `content list` and `content tags` do not.",
    );

  /**
   * The subset of a KB node this command renders. Typed here rather than read
   * off `Record<string, unknown>` so the table projection below is checked
   * against something — the projection used to read `processing_status` at the
   * top level, where the API has never put it, and printed a blank column.
   */
  interface KbFileNode {
    kb_node_id?: string;
    name?: string;
    type?: string;
    content?: { id?: string; processing_status?: string };
  }

  describeCommand(
    content
      .command("list")
      .description(
        "List top-level knowledge base files and folders. Deprecated: this returns KB NODES, so each id is a kb_node_id and `senso content get` rejects it. Prefer `senso kb my-files`, which returns the same rows with every field.",
      )
      .option("--limit <n>", "Items per page. The API caps this at 50", "10")
      .option("--offset <n>", "Pagination offset", "0"),
    {
      returns: [
        "nodes[].kb_node_id — use with `senso kb get`, `senso kb children`. NOT with `senso content get`",
        "nodes[].name, nodes[].type — file | folder",
        "nodes[].content.id — the KB document's content_id; `senso content get` rejects it, read the text with `senso kb content <kb_node_id>`",
        "nodes[].content.processing_status — pending | processing | complete | failed",
        "total — nodes at this level, for paging",
      ],
      exitCodes: {
        ...apiExits,
        2: "--limit or --offset is not a whole number, or below its floor",
      },
      notes: [
        "The API silently substitutes its own defaults for an unparseable --limit or --offset, so both are checked here first.",
      ],
      examples: [
        { comment: "The ids this prints belong to the kb group", command: "senso content list" },
        {
          command: "senso content list --limit 50 --output json | jq -r '.data.nodes[].kb_node_id'",
        },
      ],
      seeAlso: ["senso kb my-files", "senso kb find", "senso kb get <kb_node_id>"],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
      // The endpoint returns a bare array on some deployments and a wrapper
      // on others, which is why both shapes are handled here.
      const data = await apiRequest<KbFileNode[] | { nodes?: KbFileNode[] }>({
        path: "/org/kb/my-files",
        params: {
          limit: parseIntFlag("--limit", cmdOpts.limit, { min: 1 }),
          offset: parseIntFlag("--offset", cmdOpts.offset, { min: 0 }),
        },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      const rows = Array.isArray(data) ? data : (data.nodes ?? []);
      emit(ctx, data, {
        table: {
          rows: rows.map((r) => ({
            kb_node_id: r.kb_node_id,
            name: r.name === undefined || r.name === "" ? "Untitled" : r.name,
            type: r.type,
            // Nested in the API's own DTO. Read from the top level, this column
            // was blank on every row the command has ever printed.
            processing_status: r.content?.processing_status,
          })),
          columns: ["kb_node_id", "name", "type", "processing_status"],
        },
        empty: "content",
        emptyHint:
          "Upload something with `senso kb upload <file>`, or look deeper with `senso kb find --q <text>`.",
      });
    }),
  );

  describeCommand(
    content
      .command("get")
      .description(
        "Read one GENERATED content item: its current version's title, summary, rendered text, editorial status and tags. This endpoint serves generated content ONLY — a knowledge base document is refused, even though its id is a valid content_id. Read those with `senso kb get <kb_node_id>` (metadata) or `senso kb content <kb_node_id>` (text). It does NOT return the version history (`senso content versions`) or publish records (`senso content verification`).",
      )
      .argument(
        "<id>",
        "content_id of a generated item, from `senso content verification` (items[].content_id) or `senso generated-content list`. Not a kb_node_id",
      ),
    {
      returns: [
        "id — the content_id every other command in this group takes",
        "title, summary, text — the current version's title, summary and rendered body",
        "editorial_status — draft | review | rejected | published",
        "processing_status — pending | processing | complete | failed (usually empty for generated content)",
        "version_num — the current revision; `senso content versions <id>` lists them all",
        "org_tags[], uploaded_by — attached tags, and who produced this version",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID, or it is a knowledge base document (use `senso kb get`)",
        3: "the organization lacks the GEO product, or the key lacks read:content",
        4: "no generated content with this id in your organization",
      },
      examples: [
        { command: "senso content get 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81" },
        {
          comment: "Read just the editorial status",
          command:
            "senso content get 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --output json | jq -r .data.editorial_status",
        },
      ],
      seeAlso: [
        "senso content versions <id>",
        "senso content verification",
        "senso generated-content get <id>",
        "senso kb get <kb_node_id>",
      ],
    },
  ).action(
    runAction(program, async (ctx, idArg: string) => {
      const id = parseId(idArg, CONTENT_ID);
      const data = await generatedOnly(
        id,
        "Knowledge base documents are read with `senso kb get <kb_node_id>` and `senso kb content <kb_node_id>`. Find one with `senso kb find --q <text>`.",
        () =>
          apiRequest({
            path: `/org/content/${id}`,
            resource: ref(CONTENT_ID, id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          }),
      );
      emit(ctx, data, {
        next: [
          { why: "List every revision of this item", command: `senso content versions ${id}` },
          {
            why: "See where it is published and how often it is cited",
            command: `senso content citation-details ${id}`,
          },
        ],
      });
    }),
  );

  describeCommand(
    content
      .command("delete")
      .description(
        "Permanently delete one GENERATED content item and remove it from every external destination. This cannot be undone, and it is not atomic: the destinations are cleared first, so a failure there leaves the local item in place. Knowledge base documents are refused — delete those with `senso kb delete <kb_node_id>`.",
      )
      .argument("<id>", "content_id, from `senso content verification` (items[].content_id)"),
    {
      returns: ["Nothing. The API answers 204 No Content."],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID, or it is a knowledge base document (use `senso kb delete`)",
        3: "the organization lacks the GEO product, or the key lacks delete:content",
        4: "no generated content with this id in your organization",
        1: "an ingestion is in progress (409 — retry when it finishes), or the external destination delete failed",
      },
      examples: [
        { command: "senso content delete 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81" },
        {
          comment: "Take it down from its destinations without deleting it",
          command: "senso content unpublish 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81",
        },
      ],
      seeAlso: ["senso content unpublish <id>", "senso kb delete <kb_node_id>"],
    },
  ).action(
    runAction(program, async (ctx, idArg: string) => {
      const id = parseId(idArg, CONTENT_ID);
      await generatedOnly(
        id,
        "Knowledge base documents are deleted with `senso kb delete <kb_node_id>`. Find one with `senso kb find --q <text>`.",
        () =>
          apiRequest({
            method: "DELETE",
            path: `/org/content/${id}`,
            resource: ref(CONTENT_ID, id),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          }),
      );
      emitConfirmation(ctx, `Content ${id} deleted.`, {
        action: "deleted",
        resource: "content",
        id,
      });
    }),
  );

  /** What the unpublish endpoint returns when it returns anything at all. */
  interface UnpublishResult {
    unpublished_count?: number;
    failures?: string[];
  }

  describeCommand(
    content
      .command("unpublish")
      .description(
        "Retract a published content item. With no flags it removes the content from EVERY destination it is live on, and the version returns to draft once no live publish record remains. With --publish-record-ids only those destinations are retracted and the rest stay live. Only generated content — content created by `senso engine publish` — can be unpublished.",
      )
      .argument("<id>", "content_id, from `senso content verification` (items[].content_id)")
      .option(
        "--publish-record-ids <ids...>",
        "Restrict the unpublish to these publish_record_id UUIDs, from `senso content verification --status published` (items[].destinations[].publish_record_id). Every value must be a UUID: the API reads a list it cannot parse as no list at all and would then unpublish everywhere",
      ),
    {
      returns: [
        "unpublished_count — how many publish records were actually retracted",
        "failures[] — one entry per destination that refused; a non-empty list means the content is still partly live",
        "Nothing at all (204) for the unpublish-everywhere form, which is a full success",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> or a --publish-record-ids value is not a UUID",
        3: "the organization lacks the GEO product, or the key lacks update:content",
        4: "no content with this id in your organization",
        1: "the content is not published (409), has no current version (409), is not generated content (400), or some destinations refused the retraction",
      },
      notes: [
        "The success line reports what the API says it retracted, not how many records were asked for: `unpublished_count` 0 with failures is a failure, and exits 1.",
      ],
      examples: [
        {
          comment: "Take it down everywhere",
          command: "senso content unpublish 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81",
        },
        {
          comment: "Retract one destination and leave the rest live",
          command:
            "senso content unpublish 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --publish-record-ids 2b7f0c93-41a8-4d6e-9f52-7c8a1e3b0d45",
        },
      ],
      seeAlso: [
        "senso content verification --status published",
        "senso publish-records retry <publishRecordId>",
        "senso content delete <id>",
      ],
    },
  ).action(
    runAction(program, async (ctx, idArg: string, cmdOpts: { publishRecordIds?: string[] }) => {
      const id = parseId(idArg, CONTENT_ID);
      // The whole reason this validation exists: the API ignores the bind error
      // on this body, so ONE malformed id turns "retract these two
      // destinations" into "retract every destination" and answers 204.
      const recordIds =
        cmdOpts.publishRecordIds && cmdOpts.publishRecordIds.length > 0
          ? parseIdList(cmdOpts.publishRecordIds, PUBLISH_RECORD_IDS)
          : undefined;

      const data = await apiRequest<UnpublishResult | undefined>({
        method: "POST",
        path: `/org/content/${id}/unpublish`,
        body: recordIds ? { publish_record_ids: recordIds } : undefined,
        resource: ref(CONTENT_ID, id),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });

      // A 204 is the unpublish-everywhere success; the per-record path answers
      // 200 with counts. Neither shape is optional to handle: the endpoint
      // chooses between them by the flags it was given.
      if (!data) {
        emitConfirmation(ctx, `Content ${id} unpublished from every destination.`, {
          action: "unpublished",
          resource: "content",
          id,
        });
        return;
      }

      const failures = data.failures ?? [];
      const count = data.unpublished_count ?? 0;
      const scope = recordIds ? ` of ${recordIds.length} requested` : "";

      if (failures.length > 0) {
        throw new CliError(
          `Unpublished ${count}${scope} publish record(s) from content ${id}; ${failures.length} destination(s) are still live.`,
          EXIT.ERROR,
          {
            code: "error",
            details: { unpublished_count: count, failures },
            hint: "Read each destination's last_error with `senso content verification --status published`, then retry one with `senso publish-records retry <publish_record_id>`.",
          },
        );
      }

      if (!ctx.quiet) {
        log.success(`Unpublished ${count}${scope} publish record(s) from content ${id}.`);
      }
      emit(ctx, data, {
        next: [
          {
            why: "Confirm what is still live",
            command: "senso content verification --status published",
          },
        ],
      });
    }),
  );

  describeCommand(
    content
      .command("verification")
      .description(
        "List generated content in the review pipeline with its editorial status, owners, tags, per-destination publish records and citation metrics. This is where content_id, version_id and publish_record_id all come from.",
      )
      .option("--limit <n>", "Rows per page, 1-100. The API silently returns 10 for anything else")
      .option("--offset <n>", "Rows to skip")
      .option("--search <query>", "Substring match on the title")
      .option(
        "--status <status>",
        `Filter by editorial status: ${VERIFICATION_STATUSES.join(" | ")}. NOTE: the API treats \`review\` as an alias for \`draft\` — the two return the same rows`,
      )
      .option(
        "--substatus <substatus>",
        `Narrow one status further: pending_draft (requires --status published) | unpublished (requires --status draft)`,
      )
      .option("--tag-ids <ids>", "Comma-separated tag UUIDs, from `senso tags list`")
      .option("--sort <sort>", `Order the queue: ${VERIFICATION_SORTS.join(" | ")}`),
    {
      returns: [
        "items[].content_id — feeds content get / versions / owners / unpublish / delete, and `engine publish --data '{\"content_id\":…}'`",
        "items[].version_id — the CURRENT version; `content reject` and `content restore` take this",
        "items[].editorial_status — draft | rejected | published",
        "items[].ever_published — true once it has been live, even if it is a draft now",
        "items[].destinations[].publish_record_id — the id for `content unpublish --publish-record-ids` and `publish-records retry`",
        "items[].destinations[].state — live | pending | publishing | failed | unpublishing | unpublished",
        "items[].tracked_url_count — 0 means published but UNTRACKED, so citation_rate measures nothing rather than zero",
        "total_count — matching rows, for paging",
        "draft_count, rejected_count, pending_published_draft_count — org-wide counts, independent of this page's filter",
      ],
      exitCodes: {
        ...apiExits,
        2: "--status, --substatus or --sort is not a valid value, the status/substatus pairing is wrong, or --limit / --offset is out of range",
        3: "the organization lacks the GEO product, or the key lacks read:content",
      },
      examples: [
        {
          comment: "What is waiting for review",
          command: "senso content verification --status draft",
        },
        {
          comment: "Live pages whose newest version is an unpublished draft",
          command: "senso content verification --status published --substatus pending_draft",
        },
        {
          comment: "Every publish record id, for a retry or an unpublish",
          command:
            "senso content verification --status published --output json | jq -r '.data.items[].destinations[].publish_record_id'",
        },
      ],
      seeAlso: [
        "senso content verification-counts",
        "senso content versions <id>",
        "senso content unpublish <id>",
        "senso engine publish",
      ],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
      // Every closed set here is documented in this command's own help, so a
      // typo is knowably wrong: checking costs nothing and fails at exit 2
      // naming the valid values, instead of a round trip that comes back as an
      // opaque server-side validation error.
      const status = parseEnumFlag("--status", cmdOpts.status, VERIFICATION_STATUSES);
      const substatus = parseEnumFlag("--substatus", cmdOpts.substatus, VERIFICATION_SUBSTATUSES);
      assertSubstatusPairing(status, substatus);

      const data = await apiRequest({
        path: "/org/content/verification",
        params: {
          limit: parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 }),
          offset: parseIntFlag("--offset", cmdOpts.offset, { min: 0 }),
          search: cmdOpts.search,
          status,
          substatus,
          tag_ids: cmdOpts.tagIds
            ? parseIdList(cmdOpts.tagIds.split(","), TAG_IDS).join(",")
            : undefined,
          sort: parseEnumFlag("--sort", cmdOpts.sort, VERIFICATION_SORTS),
        },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        columns: VERIFICATION_COLUMNS,
        empty: "content",
        emptyHint:
          "The queue is filtered by --status and --search. Widen it with `senso content verification --status all`, or count everything with `senso content verification-counts`.",
      });
    }),
  );

  describeCommand(
    content
      .command("verification-counts")
      .description(
        "Count generated content by editorial status, plus a per-publisher rollup of published items and how often they are cited. One cheap call instead of paging through `content verification`. Requires the GEO product.",
      ),
    {
      returns: [
        "draft_count, published_count, rejected_count — items whose current version is in each state",
        "pending_published_draft_count — live items whose newest version is an unpublished draft; list them with `senso content verification --status published --substatus pending_draft`",
        "published_domain_summaries[].publisher_name, external_url, item_count — one row per publisher",
        "published_domain_summaries[].citation_rate — weighted over citation_window_days. NULL, not 0, when the organization had no qualifying runs",
        "published_domain_summaries[].citation_numerator, citation_denominator — the raw figures behind the rate",
        "published_domain_summaries[].citation_window_days, citation_missing_days_excluded — what the rate was computed over",
      ],
      exitCodes: { ...apiExits, 3: "the organization lacks the GEO product" },
      examples: [
        { command: "senso content verification-counts" },
        { command: "senso content verification-counts --output json | jq -r .data.draft_count" },
      ],
      seeAlso: ["senso content verification", "senso content verification-velocity"],
    },
  ).action(
    runAction(program, async (ctx) => {
      const data = await apiRequest({
        path: "/org/content/verification/counts",
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        next: [
          { why: "See what the drafts are", command: "senso content verification --status draft" },
          {
            why: "See how long published pages take to be cited",
            command: "senso content verification-velocity",
          },
        ],
      });
    }),
  );

  describeCommand(
    content
      .command("verification-velocity")
      .description(
        "How long published content takes to earn its first AI citation, for the whole organization and per publisher. All-time: there is no date window. Requires the GEO product.",
      ),
    {
      returns: [
        "total_live_pages, pages_with_citations — org level, counting a page ONCE however many destinations it is on",
        "earliest_publish_at, first_citation_at — null when nothing has been published or cited yet",
        "avg_days_to_first_citation — mean days from publish to first citation; null means nothing has been cited, not zero days",
        "destinations[] — the same figures at (page, publisher) grain, so their total_live_pages can sum to more than the org total",
      ],
      exitCodes: {
        ...apiExits,
        3: "the organization lacks the GEO product, or the key lacks read:content",
      },
      examples: [
        { command: "senso content verification-velocity" },
        {
          command:
            "senso content verification-velocity --output json | jq -r .data.avg_days_to_first_citation",
        },
      ],
      seeAlso: [
        "senso content verification-counts",
        "senso content citation-details <id>",
        "senso content verification --status published",
      ],
    },
  ).action(
    runAction(program, async (ctx) => {
      const data = await apiRequest({
        path: "/org/content/verification/velocity",
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        next: [
          {
            why: "Drill into one published item",
            command: "senso content citation-details <content_id>",
          },
        ],
      });
    }),
  );

  /** The provenance audit, whose five stages are a documented contract. */
  interface Provenance {
    published_url?: string;
    content_id?: string;
    content_version_id?: string;
    creation_origin?: string;
    overall_status?: string;
    stages?: Record<string, Record<string, unknown>>;
  }

  describeCommand(
    content
      .command("provenance")
      .description(
        "Audit one live published URL end to end: how its knowledge base sources were ingested, the retrieved chunks and model context, the accepted generation attempt, the editing history, and every publish record. Each stage reports what the stored evidence proves and what is missing rather than guessing. Requires the GEO product.",
      )
      .requiredOption(
        "--url <url>",
        "The live published URL to audit, matched EXACTLY against a publish record's external_url — scheme, case and a trailing slash all matter. Real URLs come from `senso content verification --status published` (items[].destinations[].external_url)",
      ),
    {
      returns: [
        "published_url, content_id, content_version_id — the content behind the URL",
        "creation_origin — where the content came from",
        "overall_status — complete | partial | missing",
        "stages — always ingestion, source, creation, editing, publication, in that order",
        "stages.*.status — complete | partial | missing",
        "stages.*.applicability — applicable | not_applicable | unknown; `missing` on a not_applicable stage is not a problem",
        "stages.*.what_can_be_proven[], stages.*.missing_evidence[] — the evidence, and the gaps",
      ],
      exitCodes: {
        ...idExits,
        2: "--url is absent or is not an http/https URL",
        3: "the organization lacks the GEO product, or the key lacks read:content",
        4: "no live publish record has exactly this URL",
      },
      examples: [
        { command: "senso content provenance --url https://example.com/refunds" },
        {
          comment: "One line per stage",
          command:
            "senso content provenance --url https://example.com/refunds --output json | jq -r '.data.stages | to_entries[] | \"\\(.key): \\(.value.status)\"'",
        },
      ],
      seeAlso: [
        "senso content verification --status published",
        "senso content citation-details <id>",
        "senso content versions <id>",
      ],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: { url: string }) => {
      const url = assertHttpUrl(cmdOpts.url);
      const data = await apiRequest<Provenance>({
        path: "/org/content/provenance",
        params: { published_url: url },
        resource: {
          type: "Published URL",
          id: url,
          idField: "published_url",
          list: "senso content verification --status published",
        },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });

      // The stages are the answer, and they are keyed by name rather than
      // listed, so the generic renderer has no rows to find. Turning them into
      // rows is what keeps what_can_be_proven and missing_evidence out of a
      // single stringified line.
      const stages = Object.entries(data.stages ?? {}).map(([stage, detail]) => ({
        stage,
        ...detail,
      }));
      const header = {
        published_url: data.published_url,
        content_id: data.content_id,
        content_version_id: data.content_version_id,
        creation_origin: data.creation_origin,
        overall_status: data.overall_status,
      };
      emit(ctx, data, {
        table: {
          rows: stages,
          columns: ["stage", "status", "applicability", "what_can_be_proven", "missing_evidence"],
        },
        plain: [...fieldLines(header), "", ...itemLines(stages)],
        next: data.content_id
          ? [
              {
                why: "Read the content behind this URL",
                command: `senso content get ${data.content_id}`,
              },
            ]
          : undefined,
      });
    }),
  );

  describeCommand(
    content
      .command("citation-details")
      .description(
        "Citation performance for one PUBLISHED content item: a pooled summary across its live destinations, the same metrics per destination, and a daily trend. Requires the GEO product.",
      )
      .argument(
        "<id>",
        "content_id of a published item, from `senso content verification --status published` (items[].content_id). Not a kb_node_id, and not from `content list`",
      )
      .option(
        "--start-date <YYYY-MM-DD>",
        "Inclusive start of the window. Omit both dates for all time",
      )
      .option("--end-date <YYYY-MM-DD>", "Inclusive end of the window; not before --start-date")
      .option(
        "--models <list>",
        `Comma-separated models to filter by. Currently: ${CITATION_MODELS}. Omit for all`,
      )
      .option(
        "--locations <list>",
        "Comma-separated locations to filter by. There is no allow-list: an unrecognized name returns an empty result rather than an error",
      ),
    {
      returns: [
        "summary.total_citations — citations pooled over every destination",
        "summary.mention_rate — cited_mentioned_run_count / cited_run_count",
        "summary.avg_sov — cited_mention_total / cited_brand_mention_total",
        "summary.cited_run_count, cited_mentioned_run_count, cited_mention_total, cited_brand_mention_total — the raw inputs, so a subset can be re-pooled exactly instead of averaging ratios",
        "days_to_first_citation — null when the item has never been cited",
        "destinations[] — one block per publish record, with external_url and its own metrics",
        "trend[] — one row per day: date, total_citations, total_prompt_runs, by_destination",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID, a date is not YYYY-MM-DD, or --start-date is after --end-date",
        3: "the organization lacks the GEO product, or the key lacks read:content",
        4: "no content with this id in your organization",
      },
      examples: [
        { command: "senso content citation-details 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81" },
        {
          command:
            "senso content citation-details 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --start-date 2026-08-01 --end-date 2026-08-31 --models chatgpt,perplexity",
        },
      ],
      seeAlso: [
        "senso content citation-prompts <id>",
        "senso content verification-velocity",
        "senso content provenance --url <url>",
      ],
    },
  ).action(
    runAction(program, async (ctx, idArg: string, cmdOpts: Record<string, string>) => {
      const id = parseId(idArg, CONTENT_ID);
      const startDate = parseDateFlag("--start-date", cmdOpts.startDate);
      const endDate = parseDateFlag("--end-date", cmdOpts.endDate);
      assertRange("--start-date", startDate, "--end-date", endDate);
      const data = await apiRequest({
        path: `/org/content/${id}/citation-details`,
        params: {
          start_date: startDate,
          end_date: endDate,
          models: cmdOpts.models,
          locations: cmdOpts.locations,
        },
        resource: ref(CONTENT_ID, id),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        next: [
          {
            why: "See which prompts this page is winning",
            command: `senso content citation-prompts ${id}`,
          },
        ],
      });
    }),
  );

  /** The prompt rows, plus the header fields that make them interpretable. */
  interface CitationPrompts {
    content_id?: string;
    date_range?: Record<string, unknown>;
    models?: string[];
    external_urls?: string[];
    prompts?: Record<string, unknown>[];
  }

  describeCommand(
    content
      .command("citation-prompts")
      .description(
        "Which prompts a published page is winning: every prompt/model pair whose question runs cite one of this content's live URLs, with the mention-rate and share-of-voice LIFT against runs of the same prompt that cite none of them. Requires the GEO product.",
      )
      .argument(
        "<id>",
        "content_id of a published item, from `senso content verification --status published` (items[].content_id). Not a kb_node_id, and not from `content list`",
      )
      .option(
        "--start-date <YYYY-MM-DD>",
        "Inclusive start of the window. Omit both dates for all time",
      )
      .option("--end-date <YYYY-MM-DD>", "Inclusive end of the window; not before --start-date")
      .option(
        "--models <list>",
        `Comma-separated models to filter by. Currently: ${CITATION_MODELS}. Omit for all`,
      )
      .option(
        "--locations <list>",
        "Comma-separated locations to filter by. No allow-list: an unknown name narrows to nothing silently",
      )
      .option(
        "--destinations <list>",
        "Comma-separated publisher slugs to restrict to. The API IGNORES a slug it does not recognize, so a typo widens the result instead of failing",
      ),
    {
      returns: [
        "external_urls[] — the live URLs that were matched. Empty means the item is published but untracked, and prompts[] will always be empty",
        "prompts[].prompt, prompts[].model — the prompt text and the model that ran it",
        "prompts[].citation_count, citation_rate — how often this page was cited in those runs",
        "prompts[].mention_rate, avg_sov — brand mention rate and share of voice in the CITING runs",
        "prompts[].mention_rate_lift, avg_sov_lift — the difference against runs that cited none of these URLs. NULL when there were no non-citing runs to form a baseline",
        "prompts[].eval_count — how many runs are behind the row",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID, a date is not YYYY-MM-DD, or --start-date is after --end-date",
        3: "the organization lacks the GEO product, or the key lacks read:content",
        4: "no content with this id in your organization",
      },
      examples: [
        { command: "senso content citation-prompts 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81" },
        {
          command:
            "senso content citation-prompts 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --models chatgpt --output json | jq -r '.data.prompts[].prompt'",
        },
      ],
      seeAlso: [
        "senso content citation-details <id>",
        "senso content verification",
        "senso questions list",
      ],
    },
  ).action(
    runAction(program, async (ctx, idArg: string, cmdOpts: Record<string, string>) => {
      const id = parseId(idArg, CONTENT_ID);
      const startDate = parseDateFlag("--start-date", cmdOpts.startDate);
      const endDate = parseDateFlag("--end-date", cmdOpts.endDate);
      assertRange("--start-date", startDate, "--end-date", endDate);
      const data = await apiRequest<CitationPrompts>({
        path: `/org/content/${id}/citation-prompts`,
        params: {
          start_date: startDate,
          end_date: endDate,
          models: cmdOpts.models,
          locations: cmdOpts.locations,
          destinations: cmdOpts.destinations,
        },
        resource: ref(CONTENT_ID, id),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });

      // `external_urls` and `date_range` sit alongside `prompts` and are not
      // pagination keys, so the generic row-finder declines the response. They
      // are also what makes the rows interpretable — an empty external_urls
      // explains an empty prompts list — so they are printed as a header rather
      // than dropped along with the rest of the envelope.
      const rows = data.prompts ?? [];
      const header = {
        content_id: data.content_id,
        date_range: data.date_range,
        models: data.models,
        external_urls: data.external_urls,
      };
      emit(ctx, data, {
        table: {
          rows,
          columns: [
            "prompt",
            "model",
            "citation_count",
            "mention_rate",
            "avg_sov",
            "mention_rate_lift",
            "avg_sov_lift",
          ],
        },
        plain:
          rows.length > 0
            ? [...fieldLines(header), "", ...itemLines(rows)]
            : [...fieldLines(header), "", "  No prompts found."],
        warnings:
          (data.external_urls ?? []).length === 0
            ? [
                "This item has no tracked URL, so no run can cite it. `senso content verification` reports the same thing as tracked_url_count 0.",
              ]
            : undefined,
      });
    }),
  );

  describeCommand(
    content
      .command("record-edits")
      .description(
        "Record Builder edit-telemetry events for one content item in bulk, and return how many were inserted versus skipped as duplicates. Events are written ONE AT A TIME with no transaction: if one is rejected the request fails with the earlier events already recorded, and the API does not report how many that was. Give every event a client_event_id — an event repeating one already seen is skipped — so that retrying the whole batch is safe. Requires the GEO product.",
      )
      .argument("<id>", "content_id, from `senso content verification` (items[].content_id)")
      .requiredOption(
        "--data <json>",
        `JSON: { "events": [{ "event_type": "<${EDIT_EVENT_TYPES.join(" | ")}>", "edit_source": "<${EDIT_SOURCES.join(" | ")}>", "client_event_id": "<uuid>", "session_id": "<uuid>", "content_version_id": "<uuid>", "generation_run_id": "<uuid>", "payload": {}, "meta_data": {}, "client_created_at": "<RFC3339>" }] }`,
      ),
    {
      returns: [
        "inserted_count — events newly written",
        "duplicate_count — events skipped because their client_event_id had been seen before",
        "On success the two add up to the number of events sent",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID, --data is not JSON, `events` is missing or empty, or an event_type, edit_source or client_event_id is invalid",
        3: "the organization lacks the GEO product, or the key lacks update:content",
        4: "an event's generation_run_id does not belong to this organization and content",
        1: "the API rejected the batch part-way — the earlier events are already recorded; retry the whole batch and let client_event_id dedupe it",
      },
      examples: [
        {
          command:
            'senso content record-edits 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --data \'{"events":[{"event_type":"ai_patch_accepted","edit_source":"ai","client_event_id":"b1c2d3e4-f5a6-4071-8293-a4b5c6d7e8f9"}]}\'',
        },
      ],
      seeAlso: ["senso content versions <id>", "senso content verification"],
    },
  ).action(
    runAction(program, async (ctx, idArg: string, cmdOpts: { data: string }) => {
      const id = parseId(idArg, CONTENT_ID);
      const body = parseJsonFlag<{ events?: unknown }>(cmdOpts.data);
      assertEvents(body.events);
      const data = await apiRequest<{ inserted_count?: number; duplicate_count?: number }>({
        method: "POST",
        path: `/org/content/${id}/edit-events/bulk`,
        body,
        resource: ref(CONTENT_ID, id),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      if (!ctx.quiet) {
        // The counts are the answer: a batch where every event was a duplicate
        // used to read exactly like one where every event was new.
        log.success(
          `Recorded ${data.inserted_count ?? 0} new event(s) and skipped ${data.duplicate_count ?? 0} duplicate(s) for content ${id}.`,
        );
      }
      emit(ctx, data);
    }),
  );

  describeCommand(
    content
      .command("versions")
      .description(
        "List the full revision history of one content item, newest first. Every version is returned — there is no paging. This is where version_id values come from: `content reject` and `content restore` take a version_id, not a content_id.",
      )
      .argument("<id>", "content_id, from `senso content verification` (items[].content_id)"),
    {
      returns: [
        "content_id — echo of the item",
        "versions[].version_id — pass to `senso content reject` or `senso content restore`",
        "versions[].version_num — monotonic revision number; the list is ordered by it, descending",
        "versions[].editorial_status — draft | rejected | published",
        "versions[].is_current — true for the one version publishing, unpublishing and citation tracking follow",
        "versions[].title, summary, created_at, updated_at",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID",
        3: "the organization lacks the GEO product, or the key lacks read:content",
        4: "no content with this id in your organization",
      },
      examples: [
        { command: "senso content versions 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81" },
        {
          comment: "The current version's id, which reject and restore take",
          command:
            "senso content versions 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --output json | jq -r '.data.versions[] | select(.is_current) | .version_id'",
        },
      ],
      seeAlso: [
        "senso content reject <versionId>",
        "senso content restore <versionId>",
        "senso content get <id>",
      ],
    },
  ).action(
    runAction(program, async (ctx, idArg: string) => {
      const id = parseId(idArg, CONTENT_ID);
      const data = await apiRequest({
        path: `/org/content/${id}/versions`,
        resource: ref(CONTENT_ID, id),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        columns: ["version_id", "version_num", "editorial_status", "is_current", "updated_at"],
        empty: "versions",
        emptyHint:
          "An item with no versions cannot be published. Check it with `senso content get <id>`.",
      });
    }),
  );

  describeCommand(
    content
      .command("reject")
      .description(
        "Reject one content VERSION in the review workflow: its editorial status becomes `rejected` and the reason is recorded against it. Rejecting does NOT take a live page down — use `senso content unpublish` for that. Undo it with `senso content restore`.",
      )
      .argument(
        "<versionId>",
        "A version_id — NOT a content_id. From `senso content versions <content_id>` (versions[].version_id) or `senso content verification` (items[].version_id). A content_id here is reported as not found",
      )
      .option(
        "--reason <text>",
        "Why it was rejected. Strongly recommended: this is the only record of the decision, and it surfaces as items[].rejection.reason on `senso content verification --status rejected`",
      ),
    {
      returns: ["Nothing. The API answers 204 No Content."],
      exitCodes: {
        ...idExits,
        2: "<versionId> is not a UUID",
        3: "the organization lacks the GEO product, or the key lacks update:content",
        4: "no version with this id in your organization — a content_id lands here",
      },
      examples: [
        {
          command:
            'senso content reject 4c6b8e02-7f31-4a95-b0d3-8e1f2a5c7d94 --reason "no source for the 30-day claim"',
        },
      ],
      seeAlso: [
        "senso content restore <versionId>",
        "senso content versions <id>",
        "senso content unpublish <id>",
      ],
    },
  ).action(
    runAction(program, async (ctx, versionIdArg: string, cmdOpts: { reason?: string }) => {
      const versionId = parseId(versionIdArg, VERSION_ID);
      await apiRequest({
        method: "POST",
        path: `/org/content/versions/${versionId}/reject`,
        body: cmdOpts.reason ? { reason: cmdOpts.reason } : undefined,
        resource: ref(VERSION_ID, versionId),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emitConfirmation(
        ctx,
        `Version ${versionId} rejected.`,
        { action: "rejected", resource: "content_version", id: versionId, reason: cmdOpts.reason },
        {
          next: [
            { why: "Undo it", command: `senso content restore ${versionId}` },
            {
              why: "Review everything rejected",
              command: "senso content verification --status rejected",
            },
          ],
        },
      );
    }),
  );

  describeCommand(
    content
      .command("restore")
      .description(
        "Set one content VERSION back to draft so it can be edited and published again. Normally used to undo `senso content reject`. The API does not check the version's current status: restoring a PUBLISHED version marks it draft but leaves its publish records live, so the page stays up while the record says draft. Take a live page down with `senso content unpublish <content_id>`.",
      )
      .argument(
        "<versionId>",
        "A version_id — NOT a content_id. From `senso content versions <content_id>` or `senso content verification --status rejected` (items[].version_id)",
      ),
    {
      returns: ["Nothing. The API answers 204 No Content."],
      exitCodes: {
        ...idExits,
        2: "<versionId> is not a UUID",
        3: "the organization lacks the GEO product, or the key lacks update:content",
        4: "no version with this id in your organization — a content_id lands here",
      },
      examples: [
        { command: "senso content restore 4c6b8e02-7f31-4a95-b0d3-8e1f2a5c7d94" },
        {
          comment: "Send everything rejected back to draft",
          command:
            "senso content verification --status rejected --output json | jq -r '.data.items[].version_id' | xargs -n1 senso content restore",
        },
      ],
      seeAlso: [
        "senso content reject <versionId>",
        "senso engine publish",
        "senso content unpublish <id>",
      ],
    },
  ).action(
    runAction(program, async (ctx, versionIdArg: string) => {
      const versionId = parseId(versionIdArg, VERSION_ID);
      await apiRequest({
        method: "POST",
        path: `/org/content/versions/${versionId}/restore`,
        resource: ref(VERSION_ID, versionId),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emitConfirmation(
        ctx,
        `Version ${versionId} restored to draft.`,
        {
          action: "restored",
          resource: "content_version",
          id: versionId,
          editorial_status: "draft",
        },
        {
          next: [
            { why: "Find it in the queue", command: "senso content verification --status draft" },
          ],
        },
      );
    }),
  );

  describeCommand(
    content
      .command("owners")
      .description(
        "List the organization members assigned as owners of one content item. Owners are metadata: they are recorded here and surfaced as items[].owners on `senso content verification`, and nothing in the CLI enforces their approval.",
      )
      .argument("<id>", "content_id, from `senso content verification` (items[].content_id)"),
    {
      returns: [
        "user_id — pass to `senso content remove-owner <id> <userId>`",
        "email, given_name, family_name",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID",
        3: "the organization lacks the GEO product, or the key lacks read:content",
        4: "no content with this id in your organization",
      },
      examples: [
        { command: "senso content owners 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81" },
        {
          command:
            "senso content owners 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --output json | jq -r '.data[].email'",
        },
      ],
      seeAlso: [
        "senso content set-owners <id>",
        "senso content remove-owner <id> <userId>",
        "senso members list",
      ],
    },
  ).action(
    runAction(program, async (ctx, idArg: string) => {
      const id = parseId(idArg, CONTENT_ID);
      const data = await apiRequest({
        path: `/org/content/${id}/owners`,
        resource: ref(CONTENT_ID, id),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        empty: "owners",
        emptyHint: `Content is not assigned owners automatically. Assign some with \`senso content set-owners ${id} --user-ids <user_id>\`; ids come from \`senso members list\`.`,
      });
    }),
  );

  describeCommand(
    content
      .command("set-owners")
      .description(
        "Replace the owner list of one content item. This is a REPLACE, not an add: any owner not named in --user-ids is removed. To drop one owner without listing all the others, use `senso content remove-owner`.",
      )
      .argument("<id>", "content_id, from `senso content verification` (items[].content_id)")
      .requiredOption(
        "--user-ids <ids...>",
        "One or more user_id UUIDs, from `senso members list`. Each must already be a member of this organization",
      ),
    {
      returns: ["The resulting owner set: user_id, email, given_name, family_name."],
      exitCodes: {
        ...idExits,
        2: "<id> or a --user-ids value is not a UUID",
        3: "the organization lacks the GEO product, or the key lacks update:content",
        4: "no content with this id in your organization",
        1: "one of the users is not a member of this organization",
      },
      examples: [
        {
          command:
            "senso content set-owners 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --user-ids c3d4e5f6-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
        },
      ],
      seeAlso: [
        "senso content owners <id>",
        "senso content remove-owner <id> <userId>",
        "senso members list",
      ],
    },
  ).action(
    runAction(program, async (ctx, idArg: string, cmdOpts: { userIds: string[] }) => {
      const id = parseId(idArg, CONTENT_ID);
      const userIds = parseIdList(cmdOpts.userIds, USER_IDS);
      const data = await apiRequest({
        method: "PUT",
        path: `/org/content/${id}/owners`,
        body: { user_ids: userIds },
        resource: ref(CONTENT_ID, id),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      if (!ctx.quiet) {
        log.success(`Owners of content ${id} replaced with ${userIds.length} user(s).`);
      }
      // The API answers with the resulting owner set. Discarding it, as this
      // used to, forced a second `content owners` call to see what was written.
      if (data) {
        emit(ctx, data, {
          warnings: [
            "This replaced the whole owner list: anyone not named in --user-ids was removed.",
          ],
        });
      } else {
        emitConfirmation(ctx, `Owners updated for content ${id}.`, {
          action: "replaced",
          resource: "content_owners",
          id,
          user_ids: userIds,
        });
      }
    }),
  );

  describeCommand(
    content
      .command("remove-owner")
      .description(
        "Remove one owner from one content item. Idempotent: removing someone who is not an owner succeeds.",
      )
      .argument(
        "<id>",
        "FIRST argument: the content_id, from `senso content verification` (items[].content_id)",
      )
      .argument(
        "<userId>",
        "SECOND argument: the user_id to remove, from `senso content owners <id>` or `senso members list`. Both are UUIDs, and swapping them reports the content as not found",
      ),
    {
      returns: ["Nothing. The API answers 204 No Content."],
      exitCodes: {
        ...idExits,
        2: "<id> or <userId> is not a UUID",
        3: "the organization lacks the GEO product, or the key lacks update:content",
        4: "no content with this id in your organization",
      },
      examples: [
        {
          command:
            "senso content remove-owner 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 c3d4e5f6-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
        },
      ],
      seeAlso: ["senso content owners <id>", "senso content set-owners <id>"],
    },
  ).action(
    runAction(program, async (ctx, idArg: string, userIdArg: string) => {
      const id = parseId(idArg, CONTENT_ID);
      const userId = parseId(userIdArg, USER_ID);
      await apiRequest({
        method: "DELETE",
        path: `/org/content/${id}/owners/${userId}`,
        resource: ref(CONTENT_ID, id),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emitConfirmation(
        ctx,
        `Owner ${userId} removed from content ${id}.`,
        { action: "removed", resource: "content_owner", content_id: id, user_id: userId },
        { next: [{ why: "See who is left", command: `senso content owners ${id}` }] },
      );
    }),
  );

  const tags = content
    .command("tags")
    .description(
      "Manage the tags attached to one content item. Unlike the rest of `senso content`, these four commands accept BOTH knowledge-base and generated content_id values, and they need neither the GEO product nor a permission scope. Content is auto-tagged when it is created (KB uploads once ingestion finishes, raw content on create); these override that afterwards. Tag names are resolved against the organization's tag library and unknown names are created. Note the flag shapes differ: `set` takes the comma-separated lists --names / --ids, while `add` and `remove` take a single --name / --id.",
    );

  describeCommand(
    tags
      .command("list")
      .description(
        "List the tags attached to one content item. Works on knowledge-base documents and generated content alike.",
      )
      .argument(
        "<id>",
        "content_id. For a KB document, `senso kb my-files --output json | jq -r '.data.nodes[].content.id'`; for generated content, `senso content verification` (items[].content_id)",
      ),
    {
      returns: [
        "id — the tag_id, for `senso content tags add/remove --id`",
        "name — the tag name",
        "curated — true when the tag is part of the organization's working vocabulary, false when it was machine-minted from a search query and has not been adopted",
        "*_count — usage counts across the organization, present on some listings only",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID",
        4: "no content with this id in your organization",
      },
      examples: [
        { command: "senso content tags list 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81" },
        {
          command:
            "senso content tags list 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --output json | jq -r '.data[].name'",
        },
      ],
      seeAlso: ["senso content tags set <id>", "senso content tags add <id>", "senso tags list"],
    },
  ).action(
    runAction(program, async (ctx, idArg: string) => {
      const id = parseId(idArg, CONTENT_ID);
      const data = await apiRequest({
        path: `/org/content/${id}/tags`,
        resource: ref(CONTENT_ID, id),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        empty: "tags",
        emptyHint: `Attach one with \`senso content tags add ${id} --name <name>\`.`,
      });
    }),
  );

  describeCommand(
    tags
      .command("set")
      .description(
        "REPLACE the whole tag collection of one content item: any tag not named in --names or --ids is detached. To empty the collection pass --clear; a bare `set` with no flags is refused rather than silently removing every tag, which is what the API does with an empty body.",
      )
      .argument("<id>", "content_id, for a KB document or a generated item")
      .option(
        "--names <list>",
        "Comma-separated tag names. Names not in the tag library are created",
      )
      .option("--ids <list>", "Comma-separated existing tag UUIDs, from `senso tags list`")
      .option("--clear", "Detach every tag. Mutually exclusive with --names and --ids"),
    {
      returns: ["The resulting tag collection: id, name, curated."],
      exitCodes: {
        ...idExits,
        2: "<id> or an --ids value is not a UUID, or none of --names / --ids / --clear was given",
        4: "no content with this id in your organization",
        1: "a tag id does not exist or belongs to another organization",
      },
      examples: [
        {
          command:
            "senso content tags set 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --names refunds,policy",
        },
        { command: "senso content tags set 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --clear" },
      ],
      seeAlso: ["senso content tags add <id>", "senso content tags remove <id>", "senso tags list"],
    },
  ).action(
    runAction(
      program,
      async (ctx, idArg: string, cmdOpts: { names?: string; ids?: string; clear?: boolean }) => {
        const id = parseId(idArg, CONTENT_ID);
        const body = buildSetTagsBody(cmdOpts);
        // An empty body means "replace with nothing", which the API applies
        // without complaint. Requiring --clear makes deleting every tag
        // something a caller has to ask for rather than something a forgotten
        // flag does for them.
        if (Object.keys(body).length === 0 && !cmdOpts.clear) {
          throw usageError(
            "`content tags set` with no --names and no --ids would remove every tag.",
            {
              field: "--names",
              hint: `Pass --names <a,b> or --ids <uuid,uuid> to replace the collection, or --clear to empty it: senso content tags set ${id} --clear`,
            },
          );
        }
        if (cmdOpts.clear && Object.keys(body).length > 0) {
          throw usageError("--clear cannot be combined with --names or --ids.", {
            field: "--clear",
            hint: "--clear empties the collection; --names/--ids replace it with those tags.",
          });
        }
        if (body.tag_ids) parseIdList(body.tag_ids, TAG_IDS);

        const data = await apiRequest({
          method: "PUT",
          path: `/org/content/${id}/tags`,
          body,
          resource: ref(CONTENT_ID, id),
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Content ${id} tags replaced.`);
        emit(ctx, data, {
          warnings: ["This replaced the whole collection: any tag not named above was detached."],
          empty: "tags",
        });
      },
    ),
  );

  describeCommand(
    tags
      .command("add")
      .description(
        "Attach ONE tag to a content item. Idempotent: attaching a tag that is already attached succeeds. Works on knowledge-base documents and generated content alike.",
      )
      .argument("<id>", "content_id, for a KB document or a generated item")
      .option("--name <name>", "Tag name. Created in the organization's tag library if it is new")
      .option("--id <tagId>", "Existing tag UUID, from `senso tags list`"),
    {
      returns: [
        "Nothing. The API answers 204 No Content; read the result with `senso content tags list <id>`.",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> or --id is not a UUID, neither --name nor --id was given, or both were",
        4: "no content with this id in your organization",
        1: "the tag id does not exist or belongs to another organization",
      },
      examples: [
        { command: "senso content tags add 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --name refunds" },
        {
          command:
            "senso content tags add 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --id 5e2a7b91-6c04-4d3f-9a18-b2c7e4f01d65",
        },
      ],
      seeAlso: [
        "senso content tags list <id>",
        "senso content tags remove <id>",
        "senso tags list",
      ],
    },
  ).action(
    runAction(program, async (ctx, idArg: string, cmdOpts: { name?: string; id?: string }) => {
      const id = parseId(idArg, CONTENT_ID);
      assertOneTagFlag(cmdOpts, "attach");
      if (cmdOpts.id) parseId(cmdOpts.id, TAG_ID);
      const body = buildAttachTagBody(cmdOpts);
      if (!body) {
        throw usageError("Provide --name or --id.", {
          field: "--name",
          hint: "Pass --name <name> to create or reuse a tag by name, or --id <tagId> for an existing tag UUID.",
        });
      }
      await apiRequest({
        method: "POST",
        path: `/org/content/${id}/tags`,
        body,
        resource: ref(CONTENT_ID, id),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emitConfirmation(
        ctx,
        `Tag ${cmdOpts.name ?? cmdOpts.id} attached to content ${id}.`,
        { action: "attached", resource: "content_tag", id, tag: cmdOpts.name ?? cmdOpts.id },
        {
          next: [{ why: "See the resulting collection", command: `senso content tags list ${id}` }],
        },
      );
    }),
  );

  describeCommand(
    tags
      .command("remove")
      .description(
        "Detach ONE tag from a content item. This is a silent no-op when the tag is not attached and — with --name — when no tag of that name exists in the organization at all, so a typo reports success. Check the result with `senso content tags list <id>`.",
      )
      .argument("<id>", "content_id, for a KB document or a generated item")
      .option("--name <name>", "Tag name to detach, sent as the `name` query parameter")
      .option("--id <tagId>", "Existing tag UUID to detach, from `senso tags list`"),
    {
      returns: ["Nothing. The API answers 204 No Content."],
      exitCodes: {
        ...idExits,
        2: "<id> or --id is not a UUID, --name is blank, neither flag was given, or both were",
        4: "no content with this id in your organization",
      },
      notes: [
        "The two flags use different routes: --name sends DELETE …/tags?name=, --id sends DELETE …/tags/<tagId>.",
      ],
      examples: [
        {
          command: "senso content tags remove 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --name refunds",
        },
        {
          command:
            "senso content tags remove 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --id 5e2a7b91-6c04-4d3f-9a18-b2c7e4f01d65",
        },
      ],
      seeAlso: [
        "senso content tags list <id>",
        "senso content tags add <id>",
        "senso content tags set <id>",
      ],
    },
  ).action(
    runAction(program, async (ctx, idArg: string, cmdOpts: { name?: string; id?: string }) => {
      const id = parseId(idArg, CONTENT_ID);
      assertOneTagFlag(cmdOpts, "detach");
      // The missing-flag case is the final branch so that `--name` narrows to
      // a string here, without a non-null assertion.
      if (cmdOpts.id) {
        const tagId = parseId(cmdOpts.id, TAG_ID);
        await apiRequest({
          method: "DELETE",
          path: `/org/content/${id}/tags/${tagId}`,
          resource: ref(CONTENT_ID, id),
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
      } else if (cmdOpts.name) {
        await apiRequest({
          method: "DELETE",
          path: `/org/content/${id}/tags`,
          params: { name: cmdOpts.name },
          resource: ref(CONTENT_ID, id),
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
      } else {
        throw usageError("Provide --name or --id.", {
          field: "--name",
          hint: "Pass --name <name> or --id <tagId> naming the tag to detach.",
        });
      }
      emitConfirmation(
        ctx,
        `Tag ${cmdOpts.name ?? cmdOpts.id} detached from content ${id}.`,
        { action: "detached", resource: "content_tag", id, tag: cmdOpts.name ?? cmdOpts.id },
        {
          next: [{ why: "Confirm what is left", command: `senso content tags list ${id}` }],
          warnings: cmdOpts.name
            ? [
                "Detaching by name is a no-op when no tag of that name is attached, and the API cannot tell the two apart.",
              ]
            : undefined,
        },
      );
    }),
  );
}

/**
 * Exactly one of --name and --id.
 *
 * `buildAttachTagBody` prefers --id when both are given, silently ignoring the
 * name the caller also typed — and on `remove` the two flags hit different
 * routes, so the choice decides which request is made. Neither is something to
 * guess at.
 */
function assertOneTagFlag(cmdOpts: { name?: string; id?: string }, verb: string): void {
  if (cmdOpts.name !== undefined && cmdOpts.id !== undefined) {
    throw usageError("Pass either --name or --id, not both.", {
      field: "--name",
      hint: `A tag to ${verb} is named once: by --name <name> or by --id <tagId>.`,
    });
  }
  if (cmdOpts.name?.trim() === "") {
    throw usageError("--name is empty.", {
      field: "--name",
      received: cmdOpts.name,
      hint: "Name the tag, or use --id <tagId>.",
    });
  }
}

/** `--url` has to be a real URL before an exact string match can mean anything. */
function assertHttpUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw usageError(`Invalid --url: "${value}" is not a URL.`, {
      field: "--url",
      received: value,
      hint: "Pass the full live URL, scheme included: --url https://example.com/refunds. Real URLs come from `senso content verification --status published`.",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError(`Invalid --url: "${value}" is not an http or https URL.`, {
      field: "--url",
      received: value,
      hint: "Publish records store http/https URLs, and the match is exact.",
    });
  }
  return trimmed;
}
