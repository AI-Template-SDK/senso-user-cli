import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerGenerateCommands(program: Command): void {
  const gen = program
    .command("generate")
    .description("AI content generation. Configure settings, generate content samples from prompts, or trigger full content engine runs.");

  gen
    .command("settings")
    .description("Get content generation settings. Shows whether generation and auto-publish are enabled, the content schedule, and configured publishers.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/content-generation", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("update-settings")
    .description("Update content generation settings. Control auto-publish, generation toggle, and schedule (days of week 0-6).")
    .requiredOption("--data <json>", 'JSON settings: { "enable_content_generation": bool, "content_auto_publish": bool, "content_schedule": [0-6] }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({ method: "PATCH", path: "/org/content-generation", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success("Content generation settings updated.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("sample")
    .description("Generate an ad hoc content sample for a specific prompt and content type. Returns the generated markdown, SEO title, and publish results.")
    .requiredOption("--prompt-id <id>", "Prompt (geo question) ID to generate content for")
    .requiredOption("--content-type-id <id>", "Content type ID that defines the output format")
    .option("--destination <dest>", "Publish destination (e.g. citeables)")
    .action(async (cmdOpts: { promptId: string; contentTypeId: string; destination?: string }) => {
      const opts = program.opts();
      try {
        const body: Record<string, unknown> = {
          geo_question_id: cmdOpts.promptId,
          content_type_id: cmdOpts.contentTypeId,
        };
        if (cmdOpts.destination) {
          body.publish_destination = cmdOpts.destination;
        }
        const data = await apiRequest({
          method: "POST",
          path: "/org/content-generation/sample",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("run")
    .description("Trigger a content generation run. Processes all prompts (or a specific subset) through the content engine. Runs asynchronously.")
    .option("--prompt-ids <ids...>", "Optional list of prompt IDs to process (omit to run all)")
    .action(async (cmdOpts: { promptIds?: string[] }) => {
      const opts = program.opts();
      try {
        const body = cmdOpts.promptIds ? { prompt_ids: cmdOpts.promptIds } : undefined;
        const data = await apiRequest({ method: "POST", path: "/org/content-generation/run", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success("Content generation run triggered.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
