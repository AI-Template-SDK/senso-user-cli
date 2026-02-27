import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerPromptCommands(program: Command): void {
  const prompts = program
    .command("prompts")
    .description("Manage prompts (geo questions). Prompts are the questions that drive AI content generation — each prompt is run against configured AI models to track brand mentions, claims, and competitor visibility.");

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
}
