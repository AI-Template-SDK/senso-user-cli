/**
 * Reading what the content engine produced.
 *
 * A lighter view of the same rows `senso content verification` returns, and the
 * only command that renders the body. Three things this file is careful about:
 *
 *   - The table named `id` and `status`; the DTO calls them `content_id` and
 *     `editorial_status` (internal/api/dto/generated_content_dto.go), so
 *     `--output table` printed two blank columns — one of them the id an agent
 *     needs for every following command.
 *   - `--limit` is advertised as 1-100 and the API does not clamp an
 *     out-of-range value, it falls back to 10. `--limit 500` returned TEN rows,
 *     not 100, and nothing said so.
 *   - `get` shares its route with `senso content get`, which refuses knowledge
 *     base content with a 400. That refusal is a wrong-command error, not an
 *     API failure, and is re-reported here as one.
 */

import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { parseEnumFlag, parseIntFlag } from "../lib/enum-arg.js";
import { CliError, EXIT } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId, type IdSpec } from "../lib/id-arg.js";
import { emit, type NextStep } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

/** The two listings, which are path segments rather than a query parameter. */
const STATUSES = ["published", "drafts"] as const;

/** The editorial states an item can report. */
const EDITORIAL_STATUSES = ["draft", "rejected", "published"] as const;

/** The columns the list DTO actually carries. */
const LIST_COLUMNS = ["content_id", "title", "editorial_status", "generated_at"];

/** The API silently returns 10 rows for a limit outside this range. */
const MAX_LIMIT = 100;

const CONTENT_ID: IdSpec = {
  label: "<id>",
  type: "Generated content",
  idField: "content_id",
  list: "senso generated-content list --status drafts",
};

/**
 * `/org/generated-content/{id}` serves generated content only.
 *
 * `rejectKBContent` (content_handler.go:775) answers 400 "Knowledge base
 * content must be accessed through KB node endpoints" — and the id it refuses
 * is a perfectly valid content_id, just from the other half of the system.
 * Passed through unchanged that reads as a bug in the command. It is not: the
 * caller reached for the wrong command, and the fix is a different command
 * rather than a retry, so it is reported as a usage error.
 */
const KB_REJECTION = /knowledge base content/i;

function kbRejection(err: unknown, id: string): CliError | undefined {
  if (!(err instanceof ApiError) || err.status !== 400 || !KB_REJECTION.test(err.message)) {
    return undefined;
  }
  return new CliError(
    `Content ${id} is a knowledge base document; \`senso generated-content\` addresses generated content only.`,
    EXIT.USAGE,
    {
      code: "usage",
      status: 400,
      field: "<id>",
      received: id,
      hint: "Knowledge base documents are addressed by kb_node_id, not content_id: find the node with `senso kb find --query <text>`, then read it with `senso kb get <kb_node_id>` (or `senso kb get-content <kb_node_id>` for the text).",
      details: { api_message: err.message },
      request: err.request,
      cause: err,
    },
  );
}

interface ListItem {
  content_id?: string;
  editorial_status?: string;
}

/** What to do with one item, given the state its review is in. */
function itemSteps(contentId: string | undefined, status: string | undefined): NextStep[] {
  if (contentId === undefined) return [];
  if (status === "published") {
    return [
      {
        why: "See where it is live and how often it is cited",
        command: `senso content citation-details ${contentId}`,
      },
    ];
  }
  return [
    {
      why: "Publish this draft — keep content_id so it updates rather than duplicating",
      command: `senso engine publish --data '{"content_id":"${contentId}","raw_markdown":"…","seo_title":"…"}'`,
    },
  ];
}

export function registerGeneratedContentCommands(program: Command): void {
  const gc = program
    .command("generated-content")
    .description(
      "Browse content produced by the content engine (`senso engine draft` and `senso engine publish`). Requires the GEO product and read:content. This is a lighter view of the rows `senso content verification` returns: use that one for owners, tags, per-destination publish records and citation metrics, and this one for id, title, question text and editorial status — or for the rendered body, which only `generated-content get` returns. The content_id here is the SAME id used by `senso content get`, `senso content versions`, `senso content unpublish` and `senso engine publish --data '{\"content_id\": …}'`. Workflow: engine draft → generated-content list --status drafts → generated-content get → engine publish → generated-content list --status published.",
    );

  describeCommand(
    gc
      .command("list")
      .description(
        "List content produced by the content engine, newest first. --status selects the API PATH, not a filter: `drafts` means the item's CURRENT version is a draft, so an item that was published and then edited appears there — which is why these counts can disagree with `senso content verification-counts`.",
      )
      .option("--status <status>", `Which listing to read: ${STATUSES.join(" | ")}`, "published")
      .option(
        "--limit <n>",
        `Rows per page, 1-${MAX_LIMIT}. The API silently returns 10 rows for anything outside that, so the CLI rejects it`,
        "10",
      )
      .option("--offset <n>", "Rows to skip", "0")
      .option("--search <query>", "Substring match on the title")
      .action(
        runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
          // `draft` has always been accepted as a spelling of `drafts`; fold it in
          // before validating, so the hint names only the two documented values.
          // Anything else used to fall through to "published" and return a
          // plausible-looking wrong list.
          const requested = cmdOpts.status === "draft" ? "drafts" : cmdOpts.status;
          const status = parseEnumFlag("--status", requested, STATUSES) ?? "published";
          const data = await apiRequest<{ items?: ListItem[] }>({
            path: `/org/generated-content/${status}`,
            params: {
              limit: parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: MAX_LIMIT }),
              offset: parseIntFlag("--offset", cmdOpts.offset, { min: 0 }),
              search: cmdOpts.search,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          const first = (data.items ?? [])[0];
          emit(ctx, data, {
            columns: LIST_COLUMNS,
            empty: "generated content",
            emptyHint:
              status === "published"
                ? "Nothing is published yet. Look at the other listing with `senso generated-content list --status drafts`, or write something with `senso engine draft`."
                : 'No drafts. Write one with `senso engine draft --data \'{"raw_markdown":"…","seo_title":"…"}\'`, or see what is already live with `senso generated-content list --status published`.',
            next:
              first?.content_id === undefined
                ? []
                : [
                    {
                      why: "Read one item, including its body",
                      command: `senso generated-content get ${first.content_id}`,
                    },
                    ...itemSteps(first.content_id, first.editorial_status),
                  ],
          });
        }),
      ),
    {
      returns: [
        "items[].content_id — feeds `senso generated-content get`, `senso content get`, `senso content unpublish` and `senso engine publish --data '{\"content_id\": …}'`.",
        "items[].version_id — the CURRENT version; `senso content reject` and `senso content restore` take this one.",
        `items[].editorial_status — ${EDITORIAL_STATUSES.join(" | ")}.`,
        "items[].question_text — the prompt this content answers. EMPTY for content written without one (blank Builder documents, recorded URLs).",
        "items[].title, summary, version_num, generated_at, created_at, updated_at.",
        "total / limit / offset — the page window; page with --offset.",
      ],
      exitCodes: {
        ...apiExits,
        2: `--status is not one of ${STATUSES.join(" | ")}, or --limit / --offset is out of range`,
        3: "the organization lacks the GEO product, or the key lacks read:content",
      },
      notes: [
        "An empty page is a success, not an error.",
        "`draft` is accepted as a spelling of `drafts`; anything else exits 2 rather than silently listing published items.",
      ],
      examples: [
        { command: "senso generated-content list --status drafts" },
        {
          comment: "Every published item, id and title",
          command:
            "senso generated-content list --status published --limit 100 --output json | jq -r '.data.items[] | \"\\(.content_id)  \\(.title)\"'",
        },
        { comment: "Find one by title", command: "senso generated-content list --search refund" },
      ],
      seeAlso: [
        "senso generated-content get",
        "senso content verification",
        "senso engine draft",
        "senso engine publish",
      ],
    },
  );

  describeCommand(
    gc
      .command("get")
      .description(
        "Read one generated content item: the prompt it answers and its rendered markdown body. This serves GENERATED content only — a knowledge base document is refused even though its id is a valid content_id; read those with `senso kb get <kb_node_id>`. `senso content get <id>` returns the same item with tags and upload provenance but WITHOUT question_text; this one returns question_text and the body.",
      )
      .argument(
        "<id>",
        "content_id, from `senso generated-content list` (items[].content_id) or `senso content verification` (items[].content_id). NOT a kb_node_id",
      )
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const id = parseId(rawId, CONTENT_ID);
          let data: { editorial_status?: string };
          try {
            data = await apiRequest<{ editorial_status?: string }>({
              path: `/org/generated-content/${id}`,
              resource: { ...CONTENT_ID, id },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            const rejection = kbRejection(err, id);
            if (rejection) throw rejection;
            throw err;
          }
          emit(ctx, data, { next: itemSteps(id, data.editorial_status) });
        }),
      ),
    {
      returns: [
        "content_id — the same id `senso engine publish --data '{\"content_id\": …}'`, `senso content versions` and `senso content unpublish` take.",
        "text — the full markdown body. This is the key: not `body`, not `markdown`.",
        "question_text — the prompt this content answers. EMPTY for content written without one.",
        `editorial_status — ${EDITORIAL_STATUSES.join(" | ")}.`,
        "title, summary, content_type, version_num, generated_at, created_at, updated_at.",
        "No tags and no provenance here — `senso content get <id>` carries those.",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID, or it is a knowledge base document (read that with `senso kb get <kb_node_id>`)",
        3: "the organization lacks the GEO product, or the key lacks read:content",
        4: "no generated content with this id in your organization",
      },
      examples: [
        { command: "senso generated-content get 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81" },
        {
          comment: "Just the markdown body",
          command:
            "senso generated-content get 9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81 --output json | jq -r .data.text",
        },
      ],
      seeAlso: [
        "senso generated-content list",
        "senso content get",
        "senso engine publish",
        "senso kb get",
      ],
    },
  );
}
