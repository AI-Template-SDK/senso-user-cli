import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import { buildSetTagsBody, buildAttachTagBody } from "../lib/tag-args.js";
import * as log from "../utils/logger.js";

export function registerPromptCommands(program: Command): void {
  const prompts = program
    .command("prompts")
    .description("Manage prompts (GEO questions). Each prompt is a question that drives both AI content generation (use with 'generate sample --prompt-id') and brand visibility monitoring — tracking how AI models mention your brand, products, and competitors.");

  prompts
    .command("list")
    .description("List all prompts in the organization. Use --search to filter by question text, --sort to order results.")
    .option("--limit <n>", "Maximum prompts to return (max: 100)")
    .option("--offset <n>", "Number of prompts to skip (for pagination)")
    .option("--search <query>", "Filter prompts by question text")
    .option("--sort <order>", "Sort order: created_desc, created_asc, text_asc, text_desc, type_asc, type_desc")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/prompts",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset, search: cmdOpts.search, sort: cmdOpts.sort },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  prompts
    .command("create")
    .description("Create a new prompt. Type must be one of: decision, consideration, awareness, evaluation.")
    .requiredOption("--data <json>", 'JSON: { "question_text": "What are the best...", "type": "decision" }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/prompts",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Prompt created.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  prompts
    .command("get <promptId>")
    .description("Get a prompt with its full run history. Includes all question runs with mentions, claims, citations, and competitor data.")
    .action(async (promptId: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/prompts/${promptId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  prompts
    .command("delete <promptId>")
    .description("Delete a prompt and all its associated run history. This cannot be undone.")
    .action(async (promptId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/prompts/${promptId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Prompt ${promptId} deleted.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  const tags = prompts
    .command("tags")
    .description("Manage tags attached to a prompt. Prompts are auto-tagged on creation — use these commands to override, add, or remove tags afterwards. Tag names are resolved against the org's tag library; unknown names are created automatically.");

  tags
    .command("list <promptId>")
    .description("List tags attached to a prompt.")
    .action(async (promptId: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/prompts/${promptId}/tags`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  tags
    .command("set <promptId>")
    .description("Replace the prompt's full tag collection. Provide --names (comma-separated) and/or --ids (comma-separated UUIDs). Unknown names are created.")
    .option("--names <list>", "Comma-separated tag names (created if missing)")
    .option("--ids <list>", "Comma-separated existing tag UUIDs")
    .action(async (promptId: string, cmdOpts: { names?: string; ids?: string }) => {
      const opts = program.opts();
      try {
        const body = buildSetTagsBody(cmdOpts);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/prompts/${promptId}/tags`,
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Prompt ${promptId} tags updated.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  tags
    .command("add <promptId>")
    .description("Attach a single tag by --name (created if missing) or --id.")
    .option("--name <name>", "Tag name (created if missing)")
    .option("--id <tagId>", "Existing tag UUID")
    .action(async (promptId: string, cmdOpts: { name?: string; id?: string }) => {
      const opts = program.opts();
      const body = buildAttachTagBody(cmdOpts);
      if (!body) {
        log.error("Provide --name or --id.");
        process.exit(1);
      }
      try {
        await apiRequest({
          method: "POST",
          path: `/org/prompts/${promptId}/tags`,
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Tag attached to prompt ${promptId}.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  tags
    .command("remove <promptId>")
    .description("Detach a single tag by --name or --id. Idempotent.")
    .option("--name <name>", "Tag name to detach")
    .option("--id <tagId>", "Existing tag UUID to detach")
    .action(async (promptId: string, cmdOpts: { name?: string; id?: string }) => {
      const opts = program.opts();
      if (!cmdOpts.name && !cmdOpts.id) {
        log.error("Provide --name or --id.");
        process.exit(1);
      }
      try {
        if (cmdOpts.id) {
          await apiRequest({
            method: "DELETE",
            path: `/org/prompts/${promptId}/tags/${cmdOpts.id}`,
            apiKey: opts.apiKey,
            baseUrl: opts.baseUrl,
          });
        } else {
          await apiRequest({
            method: "DELETE",
            path: `/org/prompts/${promptId}/tags`,
            params: { name: cmdOpts.name! },
            apiKey: opts.apiKey,
            baseUrl: opts.baseUrl,
          });
        }
        log.success(`Tag detached from prompt ${promptId}.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}

