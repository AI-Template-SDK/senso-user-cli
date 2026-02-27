import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerContentTypeCommands(program: Command): void {
  const ct = program
    .command("content-types")
    .description("Manage content type configurations. Content types define the output format and structure for AI-generated content (e.g. blog post, FAQ, landing page).");

  ct
    .command("list")
    .description("List all content types configured for the organization.")
    .option("--limit <n>", "Maximum number of content types to return (default: 50)")
    .option("--offset <n>", "Number of items to skip (for pagination)")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/content-types",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  ct
    .command("create")
    .description("Create a new content type. Requires a name and configuration defining the output structure.")
    .requiredOption("--data <json>", 'JSON: { "name": "Blog Post", "config": { ... } }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/content-types",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Content type created.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  ct
    .command("get <id>")
    .description("Get a content type by ID, including its full configuration.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/content-types/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  ct
    .command("update <id>")
    .description("Update a content type's name or configuration.")
    .requiredOption("--data <json>", 'JSON: { "name": "Updated Name", "config": { ... } }')
    .action(async (id: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/content-types/${id}`,
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Content type ${id} updated.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  ct
    .command("delete <id>")
    .description("Delete a content type. This cannot be undone.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/content-types/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Content type ${id} deleted.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
