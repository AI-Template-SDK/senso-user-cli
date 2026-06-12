import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerGeneratedContentCommands(program: Command): void {
  const gc = program
    .command("generated-content")
    .description("Browse AI-generated content (GEO). List published or draft generated items, or fetch a single item with its rendered body. Requires the GEO product and read:content permission.");

  gc
    .command("list")
    .description("List generated content. Use --status to switch between published and draft items.")
    .option("--status <status>", "Which items to list: published | drafts", "published")
    .option("--limit <n>", "Items per page (max 100)", "10")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--search <query>", "Filter by title")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      const status = cmdOpts.status === "drafts" || cmdOpts.status === "draft" ? "drafts" : "published";
      try {
        const data = await apiRequest({
          path: `/org/generated-content/${status}`,
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset, search: cmdOpts.search },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gc
    .command("get <id>")
    .description("Get a single generated content item including its question text and rendered body.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: `/org/generated-content/${id}`,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
