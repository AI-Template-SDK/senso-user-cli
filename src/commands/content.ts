import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../lib/api-client.js";
import { parseEnumFlag } from "../lib/enum-arg.js";
import { CliError, EXIT } from "../lib/errors.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import { buildSetTagsBody, buildAttachTagBody } from "../lib/tag-args.js";
import * as log from "../utils/logger.js";

/**
 * The editorial statuses `content verification` filters by, and the one
 * substatus that narrows `published` further. Declared here so the help text
 * and the validation cannot say different things.
 */
const VERIFICATION_STATUSES = ["all", "draft", "review", "rejected", "published"] as const;
const VERIFICATION_SUBSTATUSES = ["pending_draft"] as const;

/**
 * The edit-telemetry batch, checked before it is sent.
 *
 * The endpoint records events in order and fails on the first invalid one,
 * leaving the earlier ones recorded — a half-applied batch is not something the
 * caller can undo, so an obviously wrong body is worth rejecting here instead.
 */
function assertEvents(events: unknown): void {
  if (!Array.isArray(events) || events.length === 0) {
    throw new CliError('--data must contain a non-empty "events" array.', EXIT.USAGE, {
      code: "usage",
      hint: 'Example: --data \'{"events":[{"event_type":"draft_saved","edit_source":"manual"}]}\'',
    });
  }
}

export function registerContentCommands(program: Command): void {
  const content = program
    .command("content")
    .description(
      "Manage content items in the knowledge base. List, inspect, delete, unpublish, and manage the verification workflow and ownership of content.",
    );

  /**
   * The subset of a KB node this command renders. Typed here rather than read
   * off `Record<string, unknown>` so the table and plain renderings below are
   * checked against something.
   */
  interface KbFileNode {
    kb_node_id?: string;
    name?: string;
    type?: string;
    processing_status?: string;
  }

  content
    .command("list")
    .description(
      "List top-level files and folders in the knowledge base. Use 'kb my-files' for the same result with richer KB node output.",
    )
    .option("--limit <n>", "Items per page", "10")
    .option("--offset <n>", "Pagination offset", "0")
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        // The endpoint returns a bare array on some deployments and a wrapper
        // on others, which is why both shapes are handled here.
        const data = await apiRequest<KbFileNode[] | { nodes?: KbFileNode[] }>({
          path: "/org/kb/my-files",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        const rows = Array.isArray(data) ? data : (data.nodes ?? []);
        emit(ctx, data, {
          table: {
            rows: rows.map((r) => ({
              id: r.kb_node_id,
              name: r.name,
              type: r.type,
              status: r.processing_status,
            })),
            columns: ["id", "name", "type", "status"],
          },
          plain: rows.length
            ? rows.map((r) => {
                // A missing name and an empty one both read as "Untitled",
                // which `??` alone would not cover.
                const name = r.name === undefined || r.name === "" ? "Untitled" : r.name;
                return `  ${pc.bold(name)} ${pc.dim(`(${r.kb_node_id})`)} ${r.type ? pc.dim(`[${r.type}]`) : ""}`;
              })
            : ["  No content found."],
        });
      }),
    );

  content
    .command("get <id>")
    .description(
      "Get a content item by ID. Returns the full content detail including versions, metadata, and publish status.",
    )
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/content/${id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  content
    .command("delete <id>")
    .description(
      "Delete a content item from the knowledge base and any external publish destinations. This cannot be undone.",
    )
    .action(
      runAction(program, async (ctx, id: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/content/${id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Content ${id} deleted.`);
      }),
    );

  content
    .command("unpublish <id>")
    .description(
      "Unpublish a content item. Without --publish-record-ids, removes the content from every destination it's live on and sets its status back to draft. With --publish-record-ids, only the specified publish records are retracted — use this to unpublish from a subset of destinations while leaving the rest live. The content status only flips back to draft once no publish records remain live.",
    )
    .option(
      "--publish-record-ids <ids...>",
      "Restrict unpublish to specific publish_record UUIDs. Use 'content get <id>' to find publish record IDs for a content item.",
    )
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { publishRecordIds?: string[] }) => {
        const body: Record<string, unknown> | undefined =
          cmdOpts.publishRecordIds && cmdOpts.publishRecordIds.length > 0
            ? { publish_record_ids: cmdOpts.publishRecordIds }
            : undefined;
        const data = await apiRequest({
          method: "POST",
          path: `/org/content/${id}/unpublish`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        const message =
          cmdOpts.publishRecordIds && cmdOpts.publishRecordIds.length > 0
            ? `Unpublished ${cmdOpts.publishRecordIds.length} record(s) from content ${id}.`
            : `Content ${id} unpublished.`;
        // The endpoint returns a body only sometimes; without one a JSON caller
        // would otherwise get an empty stdout, so fall back to a confirmation.
        if (data) {
          if (!ctx.quiet) log.success(message);
          emit(ctx, data);
        } else {
          emitConfirmation(ctx, message);
        }
      }),
    );

  content
    .command("verification")
    .description(
      "List content items in the verification workflow. Filter by editorial status (draft, review, rejected, published) to manage the review pipeline.",
    )
    .option("--limit <n>", "Maximum items to return")
    .option("--offset <n>", "Number of items to skip (for pagination)")
    .option("--search <query>", "Filter by title")
    .option("--status <status>", `Filter by status: ${VERIFICATION_STATUSES.join(", ")}`)
    .option(
      "--substatus <substatus>",
      `Narrow further (only valid with --status published): ${VERIFICATION_SUBSTATUSES.join(", ")}`,
    )
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: "/org/content/verification",
          params: {
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
            search: cmdOpts.search,
            // Both flags document a closed set in their own help text, so a typo
            // is knowably wrong here: checking costs nothing and fails at exit 2
            // naming the valid values, instead of a round trip that comes back
            // as an opaque server-side validation error.
            status: parseEnumFlag("--status", cmdOpts.status, VERIFICATION_STATUSES),
            substatus: parseEnumFlag("--substatus", cmdOpts.substatus, VERIFICATION_SUBSTATUSES),
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  content
    .command("verification-counts")
    .description(
      "Get counts of content by editorial status (draft, published, rejected, pending published-draft) plus per-destination published-domain summaries. A lightweight alternative to paging through 'content verification'.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/content/verification/counts",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  content
    .command("verification-velocity")
    .description(
      "Get publish-to-citation velocity for all published content: how many live pages have ever been cited, the average days from publish to first citation, and the same broken down per publisher. Requires the GEO product.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/content/verification/velocity",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  content
    .command("provenance")
    .description(
      "Audit the provenance of one published URL: how its knowledge base sources were ingested, the retrieved chunks and model context, the accepted generation attempt, the editing history, and every publish record. Each stage reports what stored evidence proves and what is missing rather than guessing. --url must match a live publish record's URL exactly — 'publish-records list' is where those URLs come from. Requires the GEO product.",
    )
    .requiredOption("--url <url>", "The live published URL to audit, matched exactly")
    .action(
      runAction(program, async (ctx, cmdOpts: { url: string }) => {
        const data = await apiRequest({
          path: "/org/content/provenance",
          params: { published_url: cmdOpts.url },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  content
    .command("citation-details <id>")
    .description(
      "Get citation detail for one published content item: a pooled summary, per-destination metrics, and a daily trend, over an optional date window and model/location filter. Content IDs come from 'content list' or 'content verification'. Requires the GEO product.",
    )
    .option("--start-date <YYYY-MM-DD>", "Inclusive start of the window")
    .option("--end-date <YYYY-MM-DD>", "Inclusive end of the window; not before --start-date")
    .option(
      "--models <list>",
      "Comma-separated models to filter by (e.g. chatgpt,perplexity). Omit for all.",
    )
    .option("--locations <list>", "Comma-separated locations to filter by. Omit for all.")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: `/org/content/${id}/citation-details`,
          params: {
            start_date: cmdOpts.startDate,
            end_date: cmdOpts.endDate,
            models: cmdOpts.models,
            locations: cmdOpts.locations,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  content
    .command("citation-prompts <id>")
    .description(
      "List the prompt/model rows whose question runs cite one of a published content item's live URLs, with the mention-rate and share-of-voice lift against runs that cite none of them. Use it to see which prompts a published page is actually winning. Content IDs come from 'content list'. Requires the GEO product.",
    )
    .option("--start-date <YYYY-MM-DD>", "Inclusive start of the window")
    .option("--end-date <YYYY-MM-DD>", "Inclusive end of the window; not before --start-date")
    .option(
      "--models <list>",
      "Comma-separated models to filter by (e.g. chatgpt,perplexity). Omit for all.",
    )
    .option("--locations <list>", "Comma-separated locations to filter by. Omit for all.")
    .option(
      "--destinations <list>",
      "Comma-separated publisher slugs to restrict to. Unknown slugs are ignored.",
    )
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: Record<string, string>) => {
        const data = await apiRequest<{ prompts?: Record<string, unknown>[] }>({
          path: `/org/content/${id}/citation-prompts`,
          params: {
            start_date: cmdOpts.startDate,
            end_date: cmdOpts.endDate,
            models: cmdOpts.models,
            locations: cmdOpts.locations,
            destinations: cmdOpts.destinations,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // `external_urls` and `date_range` sit alongside `prompts` and are not
        // pagination keys, so the generic row-finder declines the response.
        // Naming the rows keeps the prompt table out of a JSON blob in a cell.
        emit(ctx, data, {
          table: {
            rows: data.prompts ?? [],
            columns: ["prompt", "model", "mention_rate", "avg_sov", "citation_count"],
          },
        });
      }),
    );

  content
    .command("record-edits <id>")
    .description(
      "Record Builder edit-telemetry events for a content item in bulk, and return how many were inserted versus skipped as duplicates. An event repeating a client_event_id already seen by the organization is skipped. Events are processed in order, so an invalid one fails the request with the earlier events already recorded. Requires the GEO product.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "events": [{ "event_type": "ai_patch_accepted", "edit_source": "ai", "client_event_id": "<uuid>" }] }',
    )
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag<{ events?: unknown }>(cmdOpts.data);
        assertEvents(body.events);
        const data = await apiRequest({
          method: "POST",
          path: `/org/content/${id}/edit-events/bulk`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Edit events recorded for content ${id}.`);
        emit(ctx, data);
      }),
    );

  content
    .command("versions <id>")
    .description(
      "List the version history for a content item, newest first. The current version is flagged with is_current.",
    )
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/content/${id}/versions`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  content
    .command("reject <versionId>")
    .description(
      "Reject a content version in the verification workflow. Optionally provide a reason for the rejection.",
    )
    .option("--reason <text>", "Reason for rejection")
    .action(
      runAction(program, async (ctx, versionId: string, cmdOpts: { reason?: string }) => {
        const body = cmdOpts.reason ? { reason: cmdOpts.reason } : undefined;
        await apiRequest({
          method: "POST",
          path: `/org/content/versions/${versionId}/reject`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Version ${versionId} rejected.`);
      }),
    );

  content
    .command("restore <versionId>")
    .description("Restore a rejected content version back to draft status for further editing.")
    .action(
      runAction(program, async (ctx, versionId: string) => {
        await apiRequest({
          method: "POST",
          path: `/org/content/versions/${versionId}/restore`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Version ${versionId} restored to draft.`);
      }),
    );

  content
    .command("owners <id>")
    .description(
      "List the owners assigned to a content item. Owners are responsible for reviewing and approving content.",
    )
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/content/${id}/owners`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  content
    .command("set-owners <id>")
    .description("Replace all owners of a content item with a new set of user IDs.")
    .requiredOption("--user-ids <ids...>", "User IDs to set as owners")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { userIds: string[] }) => {
        await apiRequest({
          method: "PUT",
          path: `/org/content/${id}/owners`,
          body: { user_ids: cmdOpts.userIds },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Owners updated for content ${id}.`);
      }),
    );

  content
    .command("remove-owner <id> <userId>")
    .description("Remove a single owner from a content item.")
    .action(
      runAction(program, async (ctx, id: string, userId: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/content/${id}/owners/${userId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Owner ${userId} removed from content ${id}.`);
      }),
    );

  const tags = content
    .command("tags")
    .description(
      "Manage tags attached to a content item (both KB-ingested and generated). Content is auto-tagged on creation (KB uploads get tagged once ingestion finishes, raw content is tagged on create) — use these commands to override, add, or remove tags afterwards. Tag names are resolved against the org's tag library; unknown names are created automatically.",
    );

  tags
    .command("list <id>")
    .description("List tags attached to a content item.")
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/content/${id}/tags`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  tags
    .command("set <id>")
    .description(
      "Replace the content item's full tag collection. Provide --names (comma-separated) and/or --ids (comma-separated UUIDs). Unknown names are created.",
    )
    .option("--names <list>", "Comma-separated tag names (created if missing)")
    .option("--ids <list>", "Comma-separated existing tag UUIDs")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { names?: string; ids?: string }) => {
        const body = buildSetTagsBody(cmdOpts);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/content/${id}/tags`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Content ${id} tags updated.`);
        emit(ctx, data);
      }),
    );

  tags
    .command("add <id>")
    .description("Attach a single tag by --name (created if missing) or --id.")
    .option("--name <name>", "Tag name (created if missing)")
    .option("--id <tagId>", "Existing tag UUID")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { name?: string; id?: string }) => {
        const body = buildAttachTagBody(cmdOpts);
        if (!body) {
          throw new CliError("Provide --name or --id.", EXIT.USAGE, {
            code: "usage",
            hint: "Pass --name <name> to create or reuse a tag by name, or --id <tagId> for an existing tag UUID.",
          });
        }
        await apiRequest({
          method: "POST",
          path: `/org/content/${id}/tags`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Tag attached to content ${id}.`);
      }),
    );

  tags
    .command("remove <id>")
    .description("Detach a single tag by --name or --id. Idempotent.")
    .option("--name <name>", "Tag name to detach")
    .option("--id <tagId>", "Existing tag UUID to detach")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { name?: string; id?: string }) => {
        // The missing-flag case is the final branch so that `--name` narrows to
        // a string here, without a non-null assertion.
        if (cmdOpts.id) {
          await apiRequest({
            method: "DELETE",
            path: `/org/content/${id}/tags/${cmdOpts.id}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
        } else if (cmdOpts.name) {
          await apiRequest({
            method: "DELETE",
            path: `/org/content/${id}/tags`,
            params: { name: cmdOpts.name },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
        } else {
          throw new CliError("Provide --name or --id.", EXIT.USAGE, {
            code: "usage",
            hint: "Pass --name <name> or --id <tagId> naming the tag to detach.",
          });
        }
        emitConfirmation(ctx, `Tag detached from content ${id}.`);
      }),
    );
}
