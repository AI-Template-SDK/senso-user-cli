import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerEngineCommands(program: Command): void {
  const engine = program
    .command("engine")
    .description("Publish or draft content through the content engine. Used to push AI-generated content to external destinations or save it as a draft for review.");

  engine
    .command("publish")
    .description("Publish content to external destinations via the content engine. Requires geo_question_id, raw_markdown, and seo_title.")
    .requiredOption("--data <json>", 'JSON: { "geo_question_id": "uuid", "raw_markdown": "...", "seo_title": "...", "summary": "..." }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/content-engine/publish",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Content published.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  engine
    .command("draft")
    .description("Save content as a draft for review before publishing. Requires geo_question_id, raw_markdown, and seo_title.")
    .requiredOption("--data <json>", 'JSON: { "geo_question_id": "uuid", "raw_markdown": "...", "seo_title": "...", "summary": "..." }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/content-engine/draft",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Content saved as draft.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });
}
