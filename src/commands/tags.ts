import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId } from "../lib/id-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * Which id space a tag id is, named once.
 *
 * A tag id is NOT a kb_node_id, content_id or prompt_id, and the sibling
 * commands (`kb tags`, `content tags`, `prompts tags`) take those as their
 * `<id>` argument while taking a tag id under `--id`. Two UUIDs, one command
 * line: this descriptor is what makes a mix-up exit 2 instead of 404.
 */
const TAG_ID = {
  label: "<id>",
  type: "Tag",
  idField: "id",
  list: "senso tags list",
};

/** dto.CreateTagRequest / dto.UpdateTagRequest: binding:"required,min=1,max=255". */
const MAX_NAME_LENGTH = 255;

/**
 * A tag name, checked against the API's own binding rules before the request.
 *
 * The API answers a bad one with a Go struct path — "Key: 'CreateTagRequest.Name'
 * Error:Field validation for 'Name' failed on the 'min' tag" — as a 400, which
 * this CLI reports as exit 1. A caller cannot tell that from the API being down.
 */
function parseTagName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw usageError("Invalid --name: the tag name is empty.", {
      field: "--name",
      received: value,
      hint: `Pass a name of 1-${String(MAX_NAME_LENGTH)} characters: senso tags create --name pricing`,
    });
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw usageError(
      `Invalid --name: ${String(trimmed.length)} characters, the maximum is ${String(MAX_NAME_LENGTH)}.`,
      {
        field: "--name",
        received: value,
        hint: `Shorten the name to ${String(MAX_NAME_LENGTH)} characters or fewer.`,
      },
    );
  }
  return trimmed;
}

/** The seven counts `--counts` adds, for the help of both list and get. */
const COUNT_FIELDS = [
  "prompt_count — prompts carrying the tag",
  "content_count — content items carrying it (KB + generated)",
  "kb_content_count — of those, items that came from the knowledge base",
  "generated_content_count — of those, items the content engine generated",
  "generated_draft_count — generated items still in draft",
  "generated_published_count — generated items that have been published",
  "kb_search_message_count — search turns auto-tagged with it",
];

export function registerTagsCommands(program: Command): void {
  const tags = program.command("tags").description(
    `Manage the organization's tag library — the shared vocabulary that prompts, KB nodes and content items are labeled with. A tag is org-scoped: renaming or deleting one here changes every resource it was applied to, immediately.

Most workflows never need this group. \`senso kb tags attach\`, \`senso content tags attach\` and \`senso prompts tags attach\` all create a tag by name when it does not exist, so the library grows on its own. Senso also auto-tags prompts, KB content and search queries; those machine-minted tags arrive with curated=false and are hidden from \`tags list\` unless you pass --include-uncurated.

Id spaces: a tag id is the \`id\` field of \`senso tags list\`, passed as --id/--ids/--tag-ids on the resource tag commands. A kb_node_id, content_id or prompt_id is the <id> ARGUMENT of those commands, and the two are never interchangeable.

Typical workflow: tags list --counts → attach by name on the resource → tags list --include-uncurated to review what auto-tagging minted → tags update to fold a variant into the canonical name → tags delete to retire one everywhere.

See also: senso kb tags, senso content tags, senso prompts tags, senso auto-tag`,
  );

  describeCommand(
    tags
      .command("list")
      .description(
        "List the organization's tag library. Returns every tag — this endpoint is not paginated.",
      )
      .option("--counts", "Include the seven usage counts. Maps to `counts=true`")
      .option(
        "--include-uncurated",
        "Also return machine-minted tags (curated=false). Maps to `include_uncurated=true`",
      )
      .action(
        runAction(
          program,
          async (ctx, cmdOpts: { counts?: boolean; includeUncurated?: boolean }) => {
            const data = await apiRequest({
              path: "/org/tags",
              params: {
                ...(cmdOpts.counts ? { counts: "true" } : {}),
                ...(cmdOpts.includeUncurated ? { include_uncurated: "true" } : {}),
              },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
              resource: { type: "Tag", list: "senso tags list" },
            });
            // `id`, not `tag_id`: dto.TagResponse marshals `id`, and the count
            // columns are absent — not zero — unless --counts was passed, so
            // declaring them unconditionally made every plain `list --output
            // table` warn that the API had not returned a field this command
            // had not asked it for.
            emit(ctx, data, {
              columns: cmdOpts.counts
                ? ["id", "name", "curated", "prompt_count", "content_count", "created_at"]
                : ["id", "name", "curated", "created_at"],
              empty: "tags",
              emptyHint: cmdOpts.includeUncurated
                ? "Create one with `senso tags create --name pricing`, or attach one by name from a resource command."
                : "Auto-minted tags are hidden by default. Retry with --include-uncurated, or create one with `senso tags create --name pricing`.",
              next: [
                {
                  why: "See the tags auto-tagging minted but nobody adopted",
                  command: "senso tags list --include-uncurated",
                },
                {
                  why: "Attach a tag to a KB node, creating it if it does not exist",
                  command: "senso kb tags attach <kb_node_id> --name pricing",
                },
              ],
            });
          },
        ),
      ),
    {
      returns: [
        "items[].id — the tag id every other tags command takes, and the --id/--ids/--tag-ids value on the resource tag commands",
        "items[].name — unique per organization, case-insensitively",
        "items[].curated — true = part of the org's working vocabulary; false = minted by auto-tagging from a search query and not yet adopted, and hidden unless --include-uncurated",
        ...COUNT_FIELDS.map((f) => `items[].${f} (--counts only)`),
        "total_count — the number of items in THIS response. The endpoint is not paginated, so it is also the size of the library under the filter.",
      ],
      exitCodes: { ...apiExits, 3: "the key's role lacks read:tag (a viewer has no tag access)" },
      examples: [
        { command: "senso tags list --counts" },
        {
          comment: "Read the ids and names out of the payload",
          command: "senso tags list --output json | jq -r '.data.items[] | \"\\(.id) \\(.name)\"'",
        },
      ],
      seeAlso: ["senso tags get <id>", "senso kb tags attach", "senso auto-tag get"],
    },
  );

  describeCommand(
    tags
      .command("create")
      .description(
        "Create a tag with no attachments. You rarely need this: `senso kb tags attach`, `senso content tags attach` and `senso prompts tags attach` create a tag by name when it does not exist.",
      )
      .requiredOption(
        "--name <name>",
        "Tag name. 1-255 characters, unique per org (case-insensitive)",
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { name: string }) => {
          const name = parseTagName(cmdOpts.name);
          const data = await apiRequest<{ id?: string }>({
            method: "POST",
            path: "/org/tags",
            body: { name },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { type: "Tag", list: "senso tags list" },
          });
          const id = data.id ?? "<id>";
          if (!ctx.quiet) log.success(`Created tag ${id} ("${name}").`);
          emit(ctx, data, {
            next: [
              {
                why: "Attach the new tag to a KB node",
                command: `senso kb tags attach <kb_node_id> --id ${id}`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "id — the new tag id",
        "name — the stored, trimmed name",
        "curated — always true here; only auto-tagging mints curated=false tags",
        "created_at, updated_at",
        "Usage counts are NOT returned by create. Read them with `senso tags get <id>`.",
      ],
      exitCodes: {
        ...apiExits,
        1: "409 — a tag with that name already exists in this organization",
        2: "--name is missing, empty after trimming, or longer than 255 characters",
        3: "the role lacks create:tag",
      },
      examples: [
        { command: "senso tags create --name pricing" },
        { command: "senso tags create --name pricing --output json | jq -r .data.id" },
      ],
      seeAlso: ["senso tags list", "senso kb tags attach", "senso content tags attach"],
    },
  );

  describeCommand(
    tags
      .command("get")
      .description(
        "Read one tag with its full usage counts. Unlike `tags list`, counts are always included here.",
      )
      .argument(
        "<id>",
        "A tag id (UUID) — the `id` field of `senso tags list`. NOT a kb_node_id, content_id or prompt_id",
      )
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const id = parseId(rawId, TAG_ID);
          const data = await apiRequest({
            path: `/org/tags/${id}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...TAG_ID, id },
          });
          emit(ctx, data, {
            next: [
              {
                why: "Rename it without losing any attachment",
                command: `senso tags update ${id} --name "Pricing"`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "id, name — as in `tags list`",
        "curated — true = adopted vocabulary; false = auto-minted from a search query and not yet adopted",
        ...COUNT_FIELDS,
        "created_at, updated_at",
      ],
      exitCodes: {
        ...idExits,
        3: "the role lacks read:tag",
        4: "no tag with this id in your organization — a tag from another org also reads as not found, by design",
      },
      examples: [
        { command: "senso tags get 9f1c4e2a-5c1d-4d0e-9f7a-2b8c6e1d3a44" },
        {
          comment: "How many prompts would a delete strip the label from",
          command:
            "senso tags get 9f1c4e2a-5c1d-4d0e-9f7a-2b8c6e1d3a44 --output json | jq -r .data.prompt_count",
        },
      ],
      seeAlso: ["senso tags list", "senso tags update <id>", "senso tags delete <id>"],
    },
  );

  describeCommand(
    tags
      .command("update")
      .description(
        "Rename a tag. It keeps its id and every attachment, so the new name appears immediately on every prompt, content item, KB node and search turn it is on. There is no merge: renaming onto an existing name is a conflict, not a fold.",
      )
      .argument("<id>", "A tag id (UUID) — the `id` field of `senso tags list`")
      .requiredOption(
        "--name <name>",
        "The new name. 1-255 characters, unique per org (case-insensitive)",
      )
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: { name: string }) => {
          const id = parseId(rawId, TAG_ID);
          const name = parseTagName(cmdOpts.name);
          // PATCH, not PUT: the attachments must survive the rename.
          const data = await apiRequest({
            method: "PATCH",
            path: `/org/tags/${id}`,
            body: { name },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...TAG_ID, id },
          });
          if (!ctx.quiet) log.success(`Renamed tag ${id} to "${name}".`);
          emit(ctx, data, {
            warnings: ["The new name is live on every resource this tag is attached to."],
            next: [
              {
                why: "Confirm how many resources now show the new name",
                command: `senso tags get ${id}`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "id, name, curated, created_at, updated_at",
        "Usage counts are NOT returned here — read them back with `senso tags get <id>`.",
      ],
      exitCodes: {
        ...idExits,
        1: "409 — another tag already has that name. There is no merge: re-tag the resources onto the surviving tag, then delete this one",
        2: "<id> is not a UUID, or --name is empty or longer than 255 characters",
        3: "the role lacks update:tag",
        4: "no tag with this id in your organization",
      },
      examples: [
        { command: 'senso tags update 9f1c4e2a-5c1d-4d0e-9f7a-2b8c6e1d3a44 --name "Pricing"' },
      ],
      seeAlso: ["senso tags get <id>", "senso tags delete <id>", "senso tags list"],
    },
  );

  describeCommand(
    tags
      .command("delete")
      .description(
        "Delete a tag and detach it from every prompt, content item, KB node and search turn it was applied to. The resources are untouched — only the label goes. This cannot be undone, and recreating the tag does not restore the attachments.",
      )
      .argument("<id>", "A tag id (UUID) — the `id` field of `senso tags list`")
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const id = parseId(rawId, TAG_ID);
          await apiRequest({
            method: "DELETE",
            path: `/org/tags/${id}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...TAG_ID, id },
          });
          // 204: nothing to show, so the caller gets a machine-readable record
          // of what went rather than a sentence it would have to parse.
          emitConfirmation(
            ctx,
            `Deleted tag ${id} and detached it everywhere.`,
            { action: "deleted", resource: "tag", id },
            { next: [{ why: "Confirm the library after the delete", command: "senso tags list" }] },
          );
        }),
      ),
    {
      notes: [
        "Check the blast radius first: `senso tags get <id>` reports how many prompts, content items, KB nodes and search turns carry the tag.",
      ],
      returns: [
        'Nothing. The API answers 204, and --output json reports { "action": "deleted", "resource": "tag", "id": "<id>" }.',
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID",
        3: "the role lacks delete:tag",
        4: "no tag with this id in your organization — it may already be deleted",
      },
      examples: [
        {
          comment: "See what it is on first",
          command: "senso tags get 9f1c4e2a-5c1d-4d0e-9f7a-2b8c6e1d3a44",
        },
        { command: "senso tags delete 9f1c4e2a-5c1d-4d0e-9f7a-2b8c6e1d3a44" },
      ],
      seeAlso: ["senso tags get <id>", "senso tags update <id>", "senso kb tags detach"],
    },
  );
}
