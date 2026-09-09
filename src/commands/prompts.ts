import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { runAction } from "../lib/run-action.js";
import { buildSetTagsBody, buildAttachTagBody } from "../lib/tag-args.js";
import * as log from "../utils/logger.js";

/** Columns for the tag endpoints, which all return the same tag shape. */
const TAG_COLUMNS = ["id", "name", "curated"];

export function registerPromptCommands(program: Command): void {
  const prompts = program
    .command("prompts")
    .description(
      "Manage prompts (GEO questions). Each prompt is a question that drives both AI content generation (use with 'generate sample --prompt-id') and brand visibility monitoring — tracking how AI models mention your brand, products, and competitors.",
    );

  prompts
    .command("list")
    .description(
      "List all prompts in the organization. Use --search to filter by question text, --sort to order results.",
    )
    .option("--limit <n>", "Maximum prompts to return (max: 100)")
    .option("--offset <n>", "Number of prompts to skip (for pagination)")
    .option("--search <query>", "Filter prompts by question text")
    .option(
      "--sort <order>",
      "Sort order: created_desc, created_asc, text_asc, text_desc, type_asc, type_desc",
    )
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: "/org/prompts",
          params: {
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
            search: cmdOpts.search,
            sort: cmdOpts.sort,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["prompt_id", "text", "type", "created_at"] });
      }),
    );

  prompts
    .command("create")
    .description(
      "Create a new prompt. Type must be one of: decision, consideration, awareness, evaluation.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "question_text": "What are the best...", "type": "decision" }',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/prompts",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Prompt created.");
        emit(ctx, data);
      }),
    );

  prompts
    .command("get <promptId>")
    .description(
      "Get a prompt with its full run history. Includes all question runs with mentions, claims, citations, and competitor data.",
    )
    .action(
      runAction(program, async (ctx, promptId: string) => {
        const data = await apiRequest({
          path: `/org/prompts/${promptId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  prompts
    .command("delete <promptId>")
    .description("Delete a prompt and all its associated run history. This cannot be undone.")
    .action(
      runAction(program, async (ctx, promptId: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/prompts/${promptId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Prompt ${promptId} deleted.`);
      }),
    );

  const tags = prompts
    .command("tags")
    .description(
      "Manage tags attached to a prompt. Prompts are auto-tagged on creation — use these commands to override, add, or remove tags afterwards. Tag names are resolved against the org's tag library; unknown names are created automatically.",
    );

  tags
    .command("list <promptId>")
    .description("List tags attached to a prompt.")
    .action(
      runAction(program, async (ctx, promptId: string) => {
        const data = await apiRequest({
          path: `/org/prompts/${promptId}/tags`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: TAG_COLUMNS });
      }),
    );

  tags
    .command("set <promptId>")
    .description(
      "Replace the prompt's full tag collection. Provide --names (comma-separated) and/or --ids (comma-separated UUIDs). Unknown names are created.",
    )
    .option("--names <list>", "Comma-separated tag names (created if missing)")
    .option("--ids <list>", "Comma-separated existing tag UUIDs")
    .action(
      runAction(
        program,
        async (ctx, promptId: string, cmdOpts: { names?: string; ids?: string }) => {
          const body = buildSetTagsBody(cmdOpts);
          const data = await apiRequest({
            method: "PUT",
            path: `/org/prompts/${promptId}/tags`,
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`Prompt ${promptId} tags updated.`);
          emit(ctx, data, { columns: TAG_COLUMNS });
        },
      ),
    );

  tags
    .command("add <promptId>")
    .description("Attach a single tag by --name (created if missing) or --id.")
    .option("--name <name>", "Tag name (created if missing)")
    .option("--id <tagId>", "Existing tag UUID")
    .action(
      runAction(program, async (ctx, promptId: string, cmdOpts: { name?: string; id?: string }) => {
        const body = buildAttachTagBody(cmdOpts);
        if (!body) {
          throw new CliError("Provide --name or --id.", EXIT.USAGE, {
            code: "usage",
            hint: "Pass --name <tag> to attach by name (created if missing), or --id <tagId>.",
          });
        }
        await apiRequest({
          method: "POST",
          path: `/org/prompts/${promptId}/tags`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Tag attached to prompt ${promptId}.`);
      }),
    );

  tags
    .command("remove <promptId>")
    .description("Detach a single tag by --name or --id. Idempotent.")
    .option("--name <name>", "Tag name to detach")
    .option("--id <tagId>", "Existing tag UUID to detach")
    .action(
      runAction(program, async (ctx, promptId: string, cmdOpts: { name?: string; id?: string }) => {
        if (!cmdOpts.name && !cmdOpts.id) {
          throw new CliError("Provide --name or --id.", EXIT.USAGE, {
            code: "usage",
            hint: "Pass --name <tag> or --id <tagId> to say which tag to detach.",
          });
        }
        if (cmdOpts.id) {
          await apiRequest({
            method: "DELETE",
            path: `/org/prompts/${promptId}/tags/${cmdOpts.id}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
        } else if (cmdOpts.name) {
          // Narrowed rather than asserted: the check above guarantees one of the
          // two is set, but TypeScript cannot carry that through the branch.
          await apiRequest({
            method: "DELETE",
            path: `/org/prompts/${promptId}/tags`,
            params: { name: cmdOpts.name },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
        }
        emitConfirmation(ctx, `Tag detached from prompt ${promptId}.`);
      }),
    );
}
