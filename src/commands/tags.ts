import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

export function registerTagsCommands(program: Command): void {
  const tags = program
    .command("tags")
    .description(
      "Manage the organization's tag library. Tags are labels attached to prompts, KB nodes, and content items to group them for filtering or metric rollups. Senso auto-tags prompts, KB content, and search queries on creation, so the tag library grows automatically — most workflows skip these commands and rely on attach-by-name on the resource commands, which also creates tags on demand.",
    );

  tags
    .command("list")
    .description(
      "List all tags for the organization. Pass --counts to include per-tag usage counts.",
    )
    .option("--counts", "Include prompt/content usage counts")
    .action(
      runAction(program, async (ctx, cmdOpts: { counts?: boolean }) => {
        const data = await apiRequest({
          path: "/org/tags",
          params: cmdOpts.counts ? { counts: "true" } : {},
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // The count columns only exist when --counts was passed; a column with
        // no matching field renders empty rather than failing.
        emit(ctx, data, {
          columns: ["id", "name", "prompt_count", "content_count", "created_at"],
        });
      }),
    );

  tags
    .command("create")
    .description("Create a new tag. Tag names are unique per org (case-insensitive).")
    .requiredOption("--name <name>", "Tag name")
    .action(
      runAction(program, async (ctx, cmdOpts: { name: string }) => {
        const data = await apiRequest({
          method: "POST",
          path: "/org/tags",
          body: { name: cmdOpts.name },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Tag "${cmdOpts.name}" created.`);
        emit(ctx, data);
      }),
    );

  tags
    .command("get <id>")
    .description("Get a tag by ID, including usage counts.")
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/tags/${id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  tags
    .command("update <id>")
    .description(
      "Rename a tag. Existing attachments on prompts, content, and KB nodes are preserved.",
    )
    .requiredOption("--name <name>", "New tag name")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { name: string }) => {
        const data = await apiRequest({
          method: "PATCH",
          path: `/org/tags/${id}`,
          body: { name: cmdOpts.name },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Tag ${id} renamed to "${cmdOpts.name}".`);
        emit(ctx, data);
      }),
    );

  tags
    .command("delete <id>")
    .description(
      "Delete a tag and detach it from every prompt, content item, and KB node it was applied to. This cannot be undone.",
    )
    .action(
      runAction(program, async (ctx, id: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/tags/${id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Tag ${id} deleted.`);
      }),
    );
}
