import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import { buildSetTagsBody, buildAttachTagBody } from "../lib/tag-args.js";
import * as log from "../utils/logger.js";

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
    .option("--status <status>", "Filter by status: all, draft, review, rejected, published")
    .option(
      "--substatus <substatus>",
      "Narrow further (only valid with --status published): pending_draft",
    )
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: "/org/content/verification",
          params: {
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
            search: cmdOpts.search,
            status: cmdOpts.status,
            substatus: cmdOpts.substatus,
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
